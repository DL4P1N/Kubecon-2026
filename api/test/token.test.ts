import { describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  assertSigningKey,
  bearerToken,
  createTokenService,
  TokenConfigError,
  TokenError,
} from "../src/auth/token.js";

const KEY = "test-signing-key-that-is-long-enough-0123456789";
const ID = "3f6c1d1e-8a43-4c1b-9d55-5f2a8f0e7b11";

async function rejectsWith(p: Promise<unknown>, reason: TokenError["reason"]) {
  await expect(p).rejects.toBeInstanceOf(TokenError);
  await expect(p).rejects.toMatchObject({ reason });
}

describe("attendee token", () => {
  it("signs HS256 with attendee ID as the only custom claim and verifies it", async () => {
    const tokens = createTokenService({ key: KEY });
    const { token, expiresAt } = await tokens.sign(ID);
    expect(decodeProtectedHeader(token).alg).toBe("HS256");
    const claims = decodeJwt(token);
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "iat", "iss", "sub"]);
    expect(claims.sub).toBe(ID);
    expect(Date.parse(expiresAt)).toBe(claims.exp! * 1000);
    expect(await tokens.verify(token)).toBe(ID);
  });

  it("rejects an expired token", async () => {
    let t = Date.parse("2026-11-09T12:00:00Z");
    const tokens = createTokenService({ key: KEY, now: () => t });
    const { token } = await tokens.sign(ID, { ttlSeconds: 60 });
    t += 59_000;
    expect(await tokens.verify(token)).toBe(ID);
    t += 2_000;
    await rejectsWith(tokens.verify(token), "expired");
  });

  it("rejects a tampered token", async () => {
    const tokens = createTokenService({ key: KEY });
    const { token } = await tokens.sign(ID);
    const [h, p, s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...decodeJwt(token), sub: "someone-else" })).toString("base64url");
    await rejectsWith(tokens.verify(`${h}.${forged}.${s}`), "invalid");
    const flipped = s!.slice(0, -2) + (s!.endsWith("AA") ? "BB" : "AA");
    await rejectsWith(tokens.verify(`${h}.${p}.${flipped}`), "invalid");
  });

  it("rejects a token signed with another key", async () => {
    const other = createTokenService({ key: KEY + "-other" });
    const { token } = await other.sign(ID);
    await rejectsWith(createTokenService({ key: KEY }).verify(token), "invalid");
  });

  it("rejects alg=none and malformed tokens", async () => {
    const tokens = createTokenService({ key: KEY });
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: ID, exp: 9999999999 })).toString("base64url");
    await rejectsWith(tokens.verify(`${header}.${body}.`), "invalid");
    await rejectsWith(tokens.verify("not-a-jwt"), "malformed");
  });

  it("keeps audiences separate (session vs QR access tokens)", async () => {
    const tokens = createTokenService({ key: KEY });
    const { token } = await tokens.sign(ID, { audience: "access", ttlSeconds: 30 });
    expect(await tokens.verify(token, { audience: "access" })).toBe(ID);
    await rejectsWith(tokens.verify(token), "invalid");
  });
});

describe("signing key checks", () => {
  it("refuses a missing key in any environment", () => {
    expect(() => createTokenService({ key: "" })).toThrow(TokenConfigError);
    expect(() => assertSigningKey(undefined, "development")).toThrow(/not set/);
  });

  it("refuses placeholder or short keys in production", () => {
    expect(() => createTokenService({ key: "change-me", nodeEnv: "production" })).toThrow(/placeholder/);
    expect(() => createTokenService({ key: "dev-only-insecure-key", nodeEnv: "production" })).toThrow(/placeholder/);
    expect(() => createTokenService({ key: "short-key", nodeEnv: "production" })).toThrow(/at least/);
    expect(() => createTokenService({ key: KEY, nodeEnv: "production" })).not.toThrow();
  });

  it("allows the dev placeholder outside production", () => {
    expect(() => createTokenService({ key: "change-me", nodeEnv: "development" })).not.toThrow();
  });

  it("does not leak the key in error messages", () => {
    try {
      createTokenService({ key: "change-me", nodeEnv: "production" });
    } catch (err) {
      expect(String(err)).not.toContain("change-me");
    }
  });
});

describe("bearerToken", () => {
  it("parses Authorization headers", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer x")).toBe("x");
    expect(bearerToken("Basic xyz")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
