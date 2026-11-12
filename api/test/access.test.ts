import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Writable } from "node:stream";
import type { AccessTokenResponse, RegisterResponse, ScanResponse } from "@cc/shared";
import { SignJWT } from "jose";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { resetMetricsForTest } from "../src/telemetry/metrics.js";
import { createTokenService } from "../src/auth/token.js";
import type { Db } from "../src/db/client.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { insertTalks, testDb } from "./pg.js";
import { talk } from "./helpers.js";
import { accessRoutes, scanBodySchema } from "../src/routes/access.js";
import { registerRoutes } from "../src/routes/register.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { RoomActivityCounter } from "../src/rooms/activity.js";
import { loggerOptions } from "../src/telemetry/logger.js";

const KEY = "test-signing-key-that-is-long-enough-0123456789";
const ROOM = "Salt Palace | Level 1 | Hall DE";
const OTHER_ROOM = "Hyatt Regency | Level 4 | Regency Ballroom B-D";

const embedder = new LocalHashEmbedder();
const embed = (text: string) => embedder.embed(text, "passage");

/** Wraps a Db so matching statements fail like a driver error would. */
function failing(db: Db, fail: (sql: string) => boolean): Db {
  return {
    ...db,
    query: ((sql: string, params?: readonly unknown[]) =>
      fail(sql) ? Promise.reject(Object.assign(new Error(`boom ${sql}`), { code: "XX000" })) : db.query(sql, params)) as Db["query"],
  };
}

interface Recorded {
  name: string;
  attrs: Record<string, string | number | boolean>;
}

describe("QR access", () => {
  let app: FastifyInstance;
  let db: Db;
  let failEntitlements = false;
  let t = Date.parse("2026-11-09T12:00:00Z");
  let spans: Recorded[];
  let logs: string[];
  let roomActivity: RoomActivityCounter;
  const now = () => t;
  const tokens = () => createTokenService({ key: KEY, now });

  async function build(opts: { scanLimit?: number } = {}) {
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        logs.push(String(chunk));
        cb();
      },
    });
    const a = Fastify({ logger: { ...loggerOptions, level: "trace", stream: logStream } });
    await a.register(registerRoutes, { db, tokens: tokens(), embed, now });
    await a.register(accessRoutes, { db: failing(db, (sql) => failEntitlements && /from entitlements/.test(sql)), tokens: tokens(), scanRateLimitPerMinute: opts.scanLimit, now, roomActivity });
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
    failEntitlements = false;
    db = await testDb();
    await insertTalks(db, [
      { ...talk("t1", 9, 10, { room: ROOM }), level: "beginner" },
      { ...talk("t2", 10, 11, { room: OTHER_ROOM }), level: "beginner" },
    ]);
    roomActivity = new RoomActivityCounter(now);
    app = await build();
  });
  afterEach(async () => {
    setSpanRunner();
    await app.close();
    await db.close();
  });

  const setEntitlement = (id: string, rooms: string[], expiresAt: Date, pass = "workshop") =>
    db.query(
      `insert into entitlements (attendee_id, pass_type, rooms, updated_at, expires_at) values ($1, $2, $3, $4, $5)
       on conflict (attendee_id) do update set pass_type = excluded.pass_type, rooms = excluded.rooms, expires_at = excluded.expires_at`,
      [id, pass, rooms, new Date(t), expiresAt],
    );

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

  it("counts allowed scans but not invalid or revoked scans", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    for (let i = 0; i < 4; i++) expect((await scan(qr.token)).json()).toMatchObject({ decision: "allow" });
    await scan("invalid-token");
    await db.query("update entitlements set rooms = '{}' where attendee_id = $1", [reg.attendeeId]);
    expect((await scan(qr.token)).json()).toMatchObject({ decision: "deny" });
    expect(roomActivity.snapshot([ROOM]).rooms[0]).toEqual({ room: ROOM, level: "quiet" });
  });

  it("refuses a QR token (403) to an attendee who stored qr_checkin=false", async () => {
    const reg = await register(false);
    expect((await db.query<{ consent_qr_checkin: boolean }>("select consent_qr_checkin from attendees where id = $1", [reg.attendeeId])).rows[0]!.consent_qr_checkin).toBe(false);
    const res = await qrToken(reg);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "forbidden" });
  });

  it("issues a QR token when consent was never sent (defaults true), and 401 without or with a bad session", async () => {
    const noConsent = await app.inject({ method: "POST", url: "/api/register", payload: { name: "Ada", interests: ["kubernetes"] } });
    expect((await qrToken(noConsent.json() as RegisterResponse)).statusCode).toBe(200);
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
    await setEntitlement(reg.attendeeId, [OTHER_ROOM], new Date(t + 3600_000));
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    expect((await scan(qr.token, OTHER_ROOM)).json()).toMatchObject({ decision: "allow" });
    const out = await scan(qr.token, ROOM);
    expect(out.statusCode).toBe(200);
    expect(out.json()).toEqual({ decision: "deny", room: ROOM, reason: "not_entitled" });
  });

  it("denies when there is no (or an expired) entitlement row", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    await db.query("delete from entitlements where attendee_id = $1", [reg.attendeeId]);
    expect((await scan(qr.token)).json()).toMatchObject({ decision: "deny", reason: "no_entitlement" });
    await setEntitlement(reg.attendeeId, ["*"], new Date(t - 1000), "general");
    expect((await scan(qr.token)).json()).toMatchObject({ decision: "deny", reason: "no_entitlement" });
    // Exactly at expiry counts as expired.
    await setEntitlement(reg.attendeeId, ["*"], new Date(t), "general");
    expect((await scan(qr.token)).json()).toMatchObject({ decision: "deny", reason: "no_entitlement" });
    await setEntitlement(reg.attendeeId, ["*"], new Date(t + 1000), "general");
    expect((await scan(qr.token)).json()).toMatchObject({ decision: "allow" });
  });

  it("refuses a QR token when the attendee has expired", async () => {
    const reg = await register();
    await db.query("update attendees set expires_at = $1 where id = $2", [new Date(t - 1), reg.attendeeId]);
    expect((await qrToken(reg)).statusCode).toBe(401);
  });

  it("honours revocation: editing the entitlement row between two scans flips the decision", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    expect((await scan(qr.token)).json()).toMatchObject({ decision: "allow" });
    await db.query("update entitlements set rooms = '{}' where attendee_id = $1", [reg.attendeeId]);
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
    failEntitlements = true;
    const out = await scan(qr.token);
    expect(out.statusCode).toBe(503);
    expect(out.body).not.toMatch(/boom|from entitlements/);
    expect(out.body).not.toContain("allow");
    expect(out.body).not.toContain(reg.attendeeId);
  });

  it("rate limits the scan endpoint", async () => {
    await app.close();
    app = await build({ scanLimit: 3 });
    for (let i = 0; i < 3; i++) expect((await scan("not-a-jwt")).statusCode).toBe(401);
    expect((await scan("not-a-jwt")).statusCode).toBe(429);
  });

  it("audits scan decisions with only validated rooms and never logs or spans identities, tokens or unvalidated rooms", async () => {
    const reg = await register();
    const qr = (await qrToken(reg)).json() as AccessTokenResponse;
    await setEntitlement(reg.attendeeId, [OTHER_ROOM], new Date(t + 1000), "x");
    await scan(qr.token, OTHER_ROOM);
    await scan(qr.token, ROOM);
    const privateRoom = "private-room-input";
    await scan("garbage", privateRoom);
    await scan(qr.token, privateRoom);
    const malformedRoom = `${privateRoom}\u0001x`;
    expect(scanBodySchema.safeParse({ token: qr.token, room: malformedRoom }).success).toBe(false);
    await scan(qr.token, malformedRoom);
    failEntitlements = true;
    await scan(qr.token, ROOM);

    const scans = spans.filter((s) => s.name === "access.scan");
    expect(scans.map((s) => s.attrs)).toEqual([
      { "access.decision": "allow", "room.id": OTHER_ROOM },
      { "access.decision": "deny", "room.id": ROOM },
      { "access.decision": "deny" },
      { "access.decision": "deny" },
      { "access.decision": "deny" },
      { "access.decision": "deny", "room.id": ROOM },
    ]);
    expect(spans.some((s) => s.name === "access.token")).toBe(true);
    const audit = logs.map((line) => JSON.parse(line)).filter((record) => record["access.decision"]);
    expect(audit.map((record) => ({ decision: record["access.decision"], room: record["room.id"] }))).toEqual([
      { decision: "allow", room: OTHER_ROOM },
      { decision: "deny", room: ROOM },
      { decision: "deny", room: "unknown" },
      { decision: "deny", room: "unknown" },
      { decision: "deny", room: "unknown" },
      { decision: "deny", room: ROOM },
    ]);
    const everything = JSON.stringify(spans) + logs.join("");
    expect(everything).not.toContain(reg.attendeeId);
    expect(everything).not.toContain(qr.token);
    expect(everything).not.toContain(reg.token);
    expect(everything).not.toContain(privateRoom);
  });

  it("counts scans by decision and room only, never by attendee ID, and not by unvalidated room input", async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 });
    const provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
    resetMetricsForTest();
    try {
      const reg = await register();
      const qr = (await qrToken(reg)).json() as AccessTokenResponse;
      await scan(qr.token);
      await scan(qr.token);
      await scan("garbage", "attacker-chosen-room");
      await scan(qr.token, "Nowhere");
      await reader.forceFlush();

      const all = exporter.getMetrics().flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics));
      const points = all.find((m) => m.descriptor.name === "access.scans")!.dataPoints;
      const summary = points.map((p) => ({ ...p.attributes, n: p.value }));
      expect(summary).toEqual(
        expect.arrayContaining([
          { "access.decision": "allow", "room.id": ROOM, n: 2 },
          { "access.decision": "deny", "room.id": "unknown", n: 2 },
        ]),
      );
      expect(points).toHaveLength(2);
      expect(JSON.stringify(points)).not.toContain(reg.attendeeId);
      expect(JSON.stringify(points)).not.toContain("attacker-chosen-room");
    } finally {
      await provider.shutdown();
      metrics.disable();
      resetMetricsForTest();
    }
  });
});
