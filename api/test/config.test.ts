import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const prodEnv = {
  NODE_ENV: "production",
  TOKEN_SIGNING_KEY: "real-key",
  DATABASE_URL: "postgresql://app:pw@db.example.test:5432/postgres",
};

describe("loadConfig in production", () => {
  it("refuses to start without TOKEN_SIGNING_KEY", () => {
    const { TOKEN_SIGNING_KEY: _omit, ...env } = prodEnv;
    expect(() => loadConfig(env)).toThrow(/TOKEN_SIGNING_KEY/);
    expect(() => loadConfig({ ...env, TOKEN_SIGNING_KEY: "" })).toThrow(/TOKEN_SIGNING_KEY/);
  });

  it("refuses to start without DATABASE_URL", () => {
    const { DATABASE_URL: _omit, ...env } = prodEnv;
    expect(() => loadConfig(env)).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...env, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("reads the database settings and no longer knows Elasticsearch", () => {
    const c = loadConfig({ ...prodEnv, DATABASE_CA_FILE: "/etc/ca.pem" });
    expect(c.databaseUrl).toBe(prodEnv.DATABASE_URL);
    expect(c.databaseCaFile).toBe("/etc/ca.pem");
    expect(loadConfig(prodEnv).databaseCaFile).toBeUndefined();
    expect(Object.keys(c).filter((k) => k.toLowerCase().startsWith("es"))).toEqual([]);
  });

  it("defaults chat to scripted so the Claude CLI never runs unless asked", () => {
    expect(loadConfig({ ...prodEnv, TOKEN_SIGNING_KEY: "k".repeat(40) }).chatMode).toBe("scripted");
    expect(loadConfig({ ...prodEnv, TOKEN_SIGNING_KEY: "k".repeat(40), CHAT_MODE: "auto" }).chatMode).toBe("auto");
  });

  it("starts with everything set", () => {
    expect(loadConfig(prodEnv).tokenSigningKey).toBe("real-key");
  });
});

describe("loadConfig outside production", () => {
  it("defaults chat to auto", () => {
    expect(loadConfig({}).chatMode).toBe("auto");
  });

  it("defaults to a local database", () => {
    expect(loadConfig({}).databaseUrl).toMatch(/^postgresql:\/\/.*localhost/);
  });

  it("keeps the dev signing key fallback", () => {
    expect(loadConfig({}).tokenSigningKey).toBe("dev-only-insecure-key");
    expect(loadConfig({ NODE_ENV: "test" }).tokenSigningKey).toBe("dev-only-insecure-key");
  });

  it("requires an identity HMAC key when a complete OAuth provider is configured", () => {
    const oauth = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret", GITHUB_OAUTH_REDIRECT_URI: "https://example.test/callback" };
    expect(() => loadConfig({ ...oauth })).toThrow(/IDENTITY_HASH_KEY \(>=32 chars\)/);
    expect(() => loadConfig({ ...oauth, IDENTITY_HASH_KEY: "short" })).toThrow(/IDENTITY_HASH_KEY \(>=32 chars\)/);
    expect(loadConfig({ ...oauth, IDENTITY_HASH_KEY: "a".repeat(32) }).identityHashKey).toBe("a".repeat(32));
  });
});
