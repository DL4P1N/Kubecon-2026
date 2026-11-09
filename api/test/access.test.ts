import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Writable } from "node:stream";
import type { AccessTokenResponse, RegisterResponse, ScanResponse } from "@cc/shared";
import { SignJWT } from "jose";
import { createTokenService } from "../src/auth/token.js";
import { createEsClient, type EsClient } from "../src/es/client.js";
import { accessRoutes, scanBodySchema } from "../src/routes/access.js";
import { registerRoutes } from "../src/routes/register.js";
import { setSpanRunner } from "../src/telemetry/span.js";

const KEY = "test-signing-key-that-is-long-enough-0123456789";
const ROOM = "Salt Palace | Level 1 | Hall DE";
const OTHER_ROOM = "Hyatt Regency | Level 4 | Regency Ballroom B-D";

/** In-memory fake of the ES endpoints used by register + access. */
function fakeEs() {
  const docs = new Map<string, Record<string, unknown>>();
  const rooms = new Set([ROOM, OTHER_ROOM]);
  let failEntitlements = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (method === "POST" && u.pathname === "/talks/_count") {
      const room = (JSON.parse(String(init.body)) as { query: { term: { room: string } } }).query.term.room;
      return new Response(JSON.stringify({ count: rooms.has(room) ? 3 : 0 }), { status: 200 });
    }
    const m = /^\/(\w+)\/(_create|_doc)\/([^/]+)$/.exec(u.pathname);
    if (!m) return new Response("{}", { status: 400 });
    const [, index, , id] = m;
    const key = `${index}/${decodeURIComponent(id!)}`;
    if (failEntitlements && index === "entitlements" && method === "GET") return new Response("boom", { status: 500 });
    if (method === "PUT") {
      docs.set(key, JSON.parse(String(init.body)));
      return new Response("{}", { status: 201 });
    }
    if (method === "GET") {
      const src = docs.get(key);
      return src
        ? new Response(JSON.stringify({ found: true, _source: src }), { status: 200 })
        : new Response(JSON.stringify({ found: false }), { status: 404 });
    }
    return new Response("{}", { status: 405 });
  }) as unknown as typeof fetch;
  return {
    docs,
    failEntitlements: () => {
      failEntitlements = true;
    },
    client: createEsClient({ esUrl: "http://es:9200", esUsername: "u", esPassword: "p" }, fetchImpl) as EsClient,
  };
}

interface Recorded {
  name: string;
  attrs: Record<string, string | number | boolean>;
}

describe("QR access", () => {
  let app: FastifyInstance;
  let es: ReturnType<typeof fakeEs>;
  let t = Date.parse("2026-11-09T12:00:00Z");
  let spans: Recorded[];
  let logs: string[];
  const now = () => t;
  const tokens = () => createTokenService({ key: KEY, now });

  async function build(opts: { scanLimit?: number } = {}) {
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    });
    const a = Fastify({ logger: { level: "trace", stream: logStream } });
    await a.register(registerRoutes, { es: es.client, tokens: tokens(), embed: async () => [1], now });
    await a.register(accessRoutes, { es: es.client, tokens: tokens(), scanRateLimitPerMinute: opts.scanLimit, now });
    await a.ready();
    return a;
  }

  beforeEach(async () => {
    t = Date.parse("2026-11-09T12:00:00Z");
    spans = [];
    logs = [];
    setSpanRunner(async (name, attrs, fn) => {
      const rec: Recorded = { name, attrs: { ...attrs } };
      spans.push(rec);
      return fn({
        setAttribute: (k, v) => {
          rec.attrs[k] = v;
        },
      });
    });
    es = fakeEs();
    app = await build();
  });
  afterEach(async () => {
    setSpanRunner();
    await app.close();
  });

  async function register(qrCheckin = true) {
    const res = await app.inject({
      method: "POST",
      url: "/api/register",
      payload: { name: "Ada", interests: ["kubernetes"], consent: { clusterMap: false, qrCheckin } },
    });
    return res.json() as RegisterResponse;
  }
  const qrToken = (reg: RegisterResponse) =>
    app.inject({ method: "POST", url: "/api/access/token", headers: { authorization: `Bearer ${reg.token}` }, payload: {} });
  const scan = (token: string, room: string = ROOM) =>
    app.inject({ method: "POST", url: "/api/access/scan", payload: { token, room } });

  it("issues a 60s access-audience token to an opted-in attendee and the scan allows", async () => {
    const reg = await register();
    const res = await qrToken(reg);
    expect(res.statusCode).toBe(200);
    const body = res.json() as AccessTokenResponse;
    expect(Date.parse(body.expiresAt) - t).toBe(60_000);
    // Carries the attendee ID and nothing else, with audience "access".
    const claims = JSON.parse(Buffer.from(body.token.split(".")[1]!, "base64url").toString());
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "iat", "iss", "sub"]);
    expect(claims.aud).toBe("access");
    expect(claims.sub).toBe(reg.attendeeId);

    const out = await scan(body.token);
    expect(out.statusCode).toBe(200);
    expect(out.json() as ScanResponse).toEqual({ decision: "allow", room: ROOM });
    expect(out.body).not.toContain(reg.attendeeId);
  });

  it("returns 403 on token for an attendee without QR consent, and 401 without or with a bad session", async () => {
    const reg = await register(false);
    expect((await qrToken(reg)).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/access/token", payload: {} })).statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/api/access/token", headers: { authorization: "Bearer a.b.c" }, payload: {} });
    expect(bad.statusCode).toBe(401);
  });

  it("does not accept a QR token as a session token", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    const res = await app.inject({ method: "POST", url: "/api/access/token", headers: { authorization: `Bearer ${qr.token}` }, payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("denies a room the attendee is not entitled to", async () => {
    const reg = await register();
    es.docs.set(`entitlements/${reg.attendeeId}`, {
      attendee_id: reg.attendeeId,
      pass_type: "workshop",
      rooms: [OTHER_ROOM],
      updated_at: new Date(t).toISOString(),
      expires_at: new Date(t + 3600_000).toISOString(),
    });
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    expect((await scan(qr.token, OTHER_ROOM)).json()).toMatchObject({ decision: "allow" });
    const out = await scan(qr.token, ROOM);
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ decision: "deny", room: ROOM, reason: "not_entitled" });
  });

  it("denies when there is no (or an expired) entitlement doc", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    es.docs.delete(`entitlements/${reg.attendeeId}`);
    expect((await scan(qr.token)).json()).toMatchObject({ decision: "deny", reason: "no_entitlement" });
    es.docs.set(`entitlements/${reg.attendeeId}`, {
      attendee_id: reg.attendeeId,
      pass_type: "general",
      rooms: ["*"],
      updated_at: "x",
      expires_at: new Date(t - 1000).toISOString(),
    });
    expect((await scan(qr.token)).json()).toMatchObject({ decision: "deny", reason: "no_entitlement" });
  });

  it("honours revocation: editing the entitlement doc between two scans flips the decision", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    expect((await scan(qr.token)).json()).toMatchObject({ decision: "allow" });
    const doc = es.docs.get(`entitlements/${reg.attendeeId}`)!;
    es.docs.set(`entitlements/${reg.attendeeId}`, { ...doc, rooms: [] });
    expect((await scan(qr.token)).json()).toMatchObject({ decision: "deny", reason: "not_entitled" });
  });

  it("rejects an expired token with 401 and deny", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    t += 61_000;
    const out = await scan(qr.token);
    expect(out.statusCode).toBe(401);
    expect(out.json()).toEqual({ decision: "deny", room: ROOM, reason: "token_expired" });
  });

  it("rejects a bad signature, a wrong audience, a foreign issuer and garbage with 401", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    const [h, p, s] = qr.token.split(".");
    const tampered = `${h}.${p}.${s!.slice(0, -2)}${s!.endsWith("AA") ? "BB" : "AA"}`;
    expect((await scan(tampered)).statusCode).toBe(401);

    const otherKey = await createTokenService({ key: "another-signing-key-that-is-long-enough-xx", now }).sign(reg.attendeeId, {
      audience: "access",
      ttlSeconds: 60,
    });
    expect((await scan(otherKey.token)).statusCode).toBe(401);

    // Valid signature, but a session token (audience "attendee").
    expect((await scan(reg.token)).statusCode).toBe(401);

    // Valid signature and audience, wrong issuer.
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(reg.attendeeId)
      .setIssuer("someone-else")
      .setAudience("access")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(KEY));
    expect((await scan(forged)).statusCode).toBe(401);

    expect((await scan("not-a-jwt")).json()).toMatchObject({ decision: "deny", reason: "token_invalid" });
  });

  it("validates input: unknown room, oversized input, missing fields, control characters", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    expect((await scan(qr.token, "Nowhere")).statusCode).toBe(400);
    expect((await scan(qr.token, "x".repeat(201))).statusCode).toBe(400);
    expect((await scan("x".repeat(2000))).statusCode).toBe(400);
    expect((await scan(qr.token, "Hall\nDE")).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/access/scan", payload: { token: qr.token } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/access/scan" })).statusCode).toBe(400);
    expect(scanBodySchema.safeParse({ token: "a", room: " r ", extra: 1 }).data).toEqual({ token: "a", room: "r" });
  });

  it("fails closed with 503 (no allow) when the entitlement lookup errors", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    es.failEntitlements();
    const out = await scan(qr.token);
    expect(out.statusCode).toBe(503);
    expect(out.body).not.toContain("allow");
    expect(out.body).not.toContain(reg.attendeeId);
  });

  it("rate limits the scan endpoint", async () => {
    await app.close();
    app = await build({ scanLimit: 3 });
    for (let i = 0; i < 3; i++) expect((await scan("not-a-jwt")).statusCode).toBe(401);
    expect((await scan("not-a-jwt")).statusCode).toBe(429);
  });

  it("emits access.scan spans with only access.decision and room.id, and never logs or spans the attendee ID", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    es.docs.set(`entitlements/${reg.attendeeId}`, {
      attendee_id: reg.attendeeId,
      pass_type: "x",
      rooms: [OTHER_ROOM],
      updated_at: "x",
      expires_at: new Date(t + 1000).toISOString(),
    });
    await scan(qr.token, OTHER_ROOM);
    await scan(qr.token, ROOM);
    await scan("garbage");
    await scan(qr.token, "Nowhere");

    const scans = spans.filter((s) => s.name === "access.scan");
    expect(scans.map((s) => s.attrs)).toEqual([
      { "access.decision": "allow", "room.id": OTHER_ROOM },
      { "access.decision": "deny", "room.id": ROOM },
      { "access.decision": "deny" },
      { "access.decision": "deny" },
    ]);
    expect(spans.some((s) => s.name === "access.token")).toBe(true);
    const everything = JSON.stringify(spans) + logs.join("");
    expect(everything).not.toContain(reg.attendeeId);
    expect(everything).not.toContain(qr.token);
    expect(everything).not.toContain(reg.token);
  });
});
