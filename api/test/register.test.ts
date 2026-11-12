import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import type { MeResponse, RegisterResponse } from "@cc/shared";
import { createTokenService } from "../src/auth/token.js";
import type { Db } from "../src/db/client.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { testDb } from "./pg.js";
import { registerRoutes, registerBodySchema } from "../src/routes/register.js";
import { NO_EXPIRY } from "../src/retentionPolicy.js";

const KEY = "test-signing-key-that-is-long-enough-0123456789";

const embedder = new LocalHashEmbedder();
const embed = (text: string) => embedder.embed(text, "passage");

/** Wraps a Db so statements matching `fail` throw a (non-unique) driver error, inside transactions too. */
function failing(db: Db, fail: (sql: string) => boolean): Db {
  const wrap = (d: Db): Db => ({
    ...d,
    query: ((sql: string, params?: readonly unknown[]) => {
      if (fail(sql)) return Promise.reject(Object.assign(new Error(`boom ${sql}`), { code: "XX000" }));
      return d.query(sql, params);
    }) as Db["query"],
    transaction: (fn) => d.transaction((tx) => fn(wrap(tx))),
  });
  return wrap(db);
}

const count = async (db: Db, table: string) => Number((await db.query<{ n: string }>(`select count(*)::int as n from ${table}`)).rows[0]!.n);
const iso = (v: unknown) => new Date(v as string).toISOString();

const validBody = {
  name: "Ada",
  email: "ada@example.com",
  interests: ["Kubernetes", "opentelemetry", "kubernetes"],
  consent: { clusterMap: true, qrCheckin: false },
};

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });

describe("POST /api/register and GET /api/me", () => {
  let app: FastifyInstance;
  let db: Db;
  let t = Date.parse("2026-11-09T12:00:00Z");
  const now = () => t;

  beforeAll(() => {
    trace.setGlobalTracerProvider(provider);
  });
  afterAll(async () => {
    await provider.shutdown();
    trace.disable();
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  beforeEach(async () => {
    t = Date.parse("2026-11-09T12:00:00Z");
    exporter.reset();
    db = await testDb();
    app = Fastify({ logger: false });
    await app.register(registerRoutes, {
      db,
      tokens: createTokenService({ key: KEY, now }),
      embed,
      rateLimitPerMinute: 3,
      now,
    });
    await app.ready();
  });

  const register = (payload: unknown = validBody) => app.inject({ method: "POST", url: "/api/register", payload: payload as object });

  const attendeeRow = async (id: string) =>
    (await db.query<Record<string, unknown>>("select id, display_name, interests, interest_vector is not null as has_vector, consent_cluster_map, consent_qr_checkin, created_at, expires_at from attendees where id = $1", [id])).rows[0];
  const claimFor = (id: string, ttlSeconds = 900) => createTokenService({ key: KEY, now }).sign(id, { audience: "identity-claim", ttlSeconds });

  it("round-trips register -> me and stores only allowed fields", async () => {
    const res = await register();
    expect(res.statusCode).toBe(201);
    const reg = res.json() as RegisterResponse;
    expect(reg.attendeeId).toMatch(/^[0-9a-f-]{36}$/);

    const attendee = (await attendeeRow(reg.attendeeId))!;
    expect(attendee.interests).toEqual(["kubernetes", "opentelemetry"]);
    expect(attendee.has_vector).toBe(true);
    expect(JSON.stringify(attendee)).not.toContain("ada@example.com");
    // Default policy: profiles are kept, so expires_at is the far-future NO_EXPIRY sentinel.
    expect(iso(attendee.expires_at)).toBe(iso(NO_EXPIRY));
    // The body sent qrCheckin: false; the explicit opt-out is stored, not overridden.
    expect([attendee.consent_cluster_map, attendee.consent_qr_checkin]).toEqual([true, false]);
    const ent = (await db.query<{ pass_type: string; rooms: string[]; expires_at: unknown }>("select * from entitlements where attendee_id = $1", [reg.attendeeId])).rows[0]!;
    expect(ent).toMatchObject({ pass_type: "general", rooms: ["*"] });
    expect(iso(ent.expires_at)).toBe(iso(NO_EXPIRY));
    // Nothing else is created for a plain registration.
    expect(await count(db, "identities")).toBe(0);
    expect(await count(db, "schedules")).toBe(0);

    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${reg.token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json() as MeResponse).toEqual({
      attendeeId: reg.attendeeId,
      name: "Ada",
      interests: ["kubernetes", "opentelemetry"],
      consent: { clusterMap: true, qrCheckin: false },
      onboarded: false,
    });
  });

  it("consumes a valid identity claim by creating one identity row for the registered attendee", async () => {
    const claim = await claimFor("provider-hmac-id");
    const res = await register({ ...validBody, identityClaim: claim.token });
    expect(res.statusCode).toBe(201);
    const registration = res.json<RegisterResponse>();
    const rows = (await db.query<{ id: string; attendee_id: string; created_at: unknown; expires_at: unknown }>("select * from identities")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "provider-hmac-id", attendee_id: registration.attendeeId });
    expect(iso(rows[0]!.created_at)).toBe(new Date(t).toISOString());
    expect(iso(rows[0]!.expires_at)).toBe(iso(NO_EXPIRY));
  });

  it("rejects an invalid or expired identity claim before writing any row", async () => {
    const invalid = await register({ ...validBody, identityClaim: "invalid.claim.token" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "invalid_identity_claim", message: "identityClaim: expired or invalid, sign in again" });
    const claim = await claimFor("expired-id", 1);
    t += 2_000;
    const expired = await register({ ...validBody, identityClaim: claim.token });
    expect(expired.statusCode).toBe(400);
    expect(expired.json()).toMatchObject({ error: "invalid_identity_claim" });
    // A session token is not an identity claim either.
    const session = await createTokenService({ key: KEY, now }).sign("someone");
    expect((await register({ ...validBody, identityClaim: session.token })).statusCode).toBe(400);
    for (const table of ["attendees", "entitlements", "identities"]) expect(await count(db, table)).toBe(0);
  });

  it("rejects a replayed identity claim with 409 and rolls the losing attendee back", async () => {
    const claim = await claimFor("single-use-identity");
    const first = (await register({ ...validBody, identityClaim: claim.token })).json<RegisterResponse>();
    const replay = await register({ ...validBody, name: "Mallory", identityClaim: claim.token });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toEqual({ error: "already_registered", message: "this account already has a profile, sign in again" });
    expect((await db.query<{ id: string }>("select id from attendees")).rows.map((r) => r.id)).toEqual([first.attendeeId]);
    expect(await count(db, "entitlements")).toBe(1);
    expect((await db.query<{ attendee_id: string }>("select attendee_id from identities where id = 'single-use-identity'")).rows[0]!.attendee_id).toBe(first.attendeeId);
  });

  it("accepts a body with no consent field and stores true/true", async () => {
    const { consent: _omitted, ...noConsent } = validBody;
    const res = await register(noConsent);
    expect(res.statusCode).toBe(201);
    const row = (await attendeeRow((res.json() as RegisterResponse).attendeeId))!;
    expect([row.consent_cluster_map, row.consent_qr_checkin]).toEqual([true, true]);
  });

  it("stores an explicit false for each consent flag and defaults only an absent flag to true", async () => {
    const both = (await register({ ...validBody, consent: { clusterMap: false, qrCheckin: false } })).json() as RegisterResponse;
    const a = (await attendeeRow(both.attendeeId))!;
    expect([a.consent_cluster_map, a.consent_qr_checkin]).toEqual([false, false]);
    const mapOnly = (await register({ ...validBody, consent: { clusterMap: false, qrCheckin: true } })).json() as RegisterResponse;
    const b = (await attendeeRow(mapOnly.attendeeId))!;
    expect([b.consent_cluster_map, b.consent_qr_checkin]).toEqual([false, true]);
  });

  describe("ATTENDEE_RETENTION_HOURS=24 restores timed expiry", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("sets expires_at 24 hours after registration on the attendee and entitlement", async () => {
      vi.stubEnv("ATTENDEE_RETENTION_HOURS", "24");
      const reg = (await register()).json() as RegisterResponse;
      const attendee = (await attendeeRow(reg.attendeeId))!;
      expect(Date.parse(iso(attendee.expires_at)) - Date.parse(iso(attendee.created_at))).toBe(24 * 3600 * 1000);
      const ent = (await db.query<{ expires_at: unknown }>("select expires_at from entitlements where attendee_id = $1", [reg.attendeeId])).rows[0]!;
      expect(iso(ent.expires_at)).toBe(iso(attendee.expires_at));
    });
  });

  describe("DELETE /api/me", () => {
    const del = (token?: string) =>
      app.inject({ method: "DELETE", url: "/api/me", headers: token ? { authorization: `Bearer ${token}` } : {} });
    const me = (token: string) => app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } });
    const seedSchedule = (id: string) =>
      db.query("insert into schedules (attendee_id, talk_ids, updated_at, expires_at) values ($1, $2, $3, $4)", [id, ["a"], new Date(t), NO_EXPIRY]);
    const rowsFor = async (table: string, col: string, id: string) => (await db.query(`select 1 from ${table} where ${col} = $1`, [id])).rows.length;

    it("deletes every row of the caller (profile, schedule, entitlement, identities), none of anyone else's, answers 204, and the token stops working", async () => {
      const claim = await claimFor("ada-identity");
      const ada = (await register({ ...validBody, identityClaim: claim.token })).json() as RegisterResponse;
      await db.query("insert into identities (id, attendee_id, created_at, expires_at) values ('ada-second', $1, $2, $3)", [ada.attendeeId, new Date(t), NO_EXPIRY]);
      const bobClaim = await claimFor("bob-identity");
      const bob = (await register({ ...validBody, name: "Bob", identityClaim: bobClaim.token })).json() as RegisterResponse;
      for (const r of [ada, bob]) await seedSchedule(r.attendeeId);

      const res = await del(ada.token);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      for (const [table, col] of [["attendees", "id"], ["schedules", "attendee_id"], ["entitlements", "attendee_id"], ["identities", "attendee_id"]] as const) {
        expect(await rowsFor(table, col, ada.attendeeId)).toBe(0);
        expect(await rowsFor(table, col, bob.attendeeId)).toBe(1);
      }
      // Same token: the profile is gone.
      expect((await del(ada.token)).statusCode).toBe(404);
      expect((await me(ada.token)).statusCode).toBe(401);
      expect((await me(bob.token)).statusCode).toBe(200);
    });

    it("answers 401 without a token or with a bad token and deletes nothing", async () => {
      const ada = (await register()).json() as RegisterResponse;
      expect((await del()).statusCode).toBe(401);
      expect((await del("a.b.c")).statusCode).toBe(401);
      expect(await rowsFor("attendees", "id", ada.attendeeId)).toBe(1);
    });

    it("a second call cleans stray rows but answers 404", async () => {
      const ada = (await register()).json() as RegisterResponse;
      expect((await del(ada.token)).statusCode).toBe(204);
      await seedSchedule(ada.attendeeId);
      expect((await del(ada.token)).statusCode).toBe(404);
      expect(await rowsFor("schedules", "attendee_id", ada.attendeeId)).toBe(0);
    });

    it("deletes nothing and answers 503 when a statement fails mid-way (one transaction), so the caller can retry", async () => {
      const claim = await claimFor("retry-identity");
      const ada = (await register({ ...validBody, identityClaim: claim.token })).json() as RegisterResponse;
      await seedSchedule(ada.attendeeId);
      const app2 = Fastify({ logger: false });
      await app2.register(registerRoutes, { db: failing(db, (sql) => /delete from identities/.test(sql)), tokens: createTokenService({ key: KEY, now }), embed });
      const failed = await app2.inject({ method: "DELETE", url: "/api/me", headers: { authorization: `Bearer ${ada.token}` } });
      expect(failed.statusCode).toBe(503);
      expect(JSON.stringify(failed.json())).not.toContain(ada.attendeeId);
      expect(failed.body).not.toMatch(/delete from/i);
      await app2.close();
      // Entitlement and schedule were deleted before the failing statement; the rollback restored them.
      for (const [table, col] of [["attendees", "id"], ["schedules", "attendee_id"], ["entitlements", "attendee_id"], ["identities", "attendee_id"]] as const) {
        expect(await rowsFor(table, col, ada.attendeeId)).toBe(1);
      }
      expect((await del(ada.token)).statusCode).toBe(204);
    });

    it("puts no attendee ID on its span, which carries allowlisted attributes only", async () => {
      exporter.reset();
      const ada = (await register()).json() as RegisterResponse;
      exporter.reset();
      await del(ada.token);
      const span = exporter.getFinishedSpans().find((s) => s.name === "me.delete")!;
      expect(span.attributes["http.route"]).toBe("/api/me");
      expect(span.attributes["http.response.status_code"]).toBe(204);
      expect(JSON.stringify([span.attributes, span.events])).not.toContain(ada.attendeeId);
    });
  });

  it("returns 401 for /api/me without, with a bad, or with an expired token", async () => {
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    const bad = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: "Bearer a.b.c" } });
    expect(bad.statusCode).toBe(401);

    const reg = (await register()).json() as RegisterResponse;
    t += 9 * 3600 * 1000; // past the 8h token lifetime
    const expired = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${reg.token}` } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().message).toBe("token expired");
  });

  it("returns 401 when the attendee no longer exists or has expired", async () => {
    const reg = (await register()).json() as RegisterResponse;
    await db.query("update attendees set expires_at = $1", [new Date(t - 1000)]);
    const expired = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${reg.token}` } });
    expect(expired.statusCode).toBe(401);
    await db.query("delete from attendees");
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${reg.token}` } });
    expect(me.statusCode).toBe(401);
  });

  it("returns 503 without leaking the attendee ID or SQL when the database fails", async () => {
    const app2 = Fastify({ logger: false });
    await app2.register(registerRoutes, { db: failing(db, () => true), tokens: createTokenService({ key: KEY, now }), embed });
    const res = await app2.inject({ method: "POST", url: "/api/register", payload: validBody });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "storage_unavailable", message: "could not store registration" });
    expect(res.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-|insert into|boom/);
    await app2.close();
  });

  it("rolls everything back (no attendee row) when the entitlement or identity insert fails", async () => {
    for (const pattern of [/insert into entitlements/, /insert into identities/]) {
      const app2 = Fastify({ logger: false });
      await app2.register(registerRoutes, { db: failing(db, (sql) => pattern.test(sql)), tokens: createTokenService({ key: KEY, now }), embed });
      const claim = await claimFor("rollback-identity");
      const res = await app2.inject({ method: "POST", url: "/api/register", payload: { ...validBody, identityClaim: claim.token } });
      expect(res.statusCode).toBe(503);
      for (const table of ["attendees", "entitlements", "identities"]) expect(await count(db, table)).toBe(0);
      await app2.close();
    }
    const span = exporter.getFinishedSpans().filter((s) => s.name === "register").at(-1)!;
    expect(span.attributes["http.response.status_code"]).toBe(503);
  });

  it("returns 5xx, writes nothing and still ends the span when signing fails", async () => {
    const app2 = Fastify({ logger: false });
    await app2.register(registerRoutes, {
      db,
      tokens: {
        sign: async () => {
          throw new Error("kms down");
        },
        verify: async () => "x",
      },
      embed,
    });
    const res = await app2.inject({ method: "POST", url: "/api/register", payload: validBody });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("kms down");
    expect(await count(db, "attendees")).toBe(0);
    const spans = exporter.getFinishedSpans().filter((s) => s.name === "register");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes["http.response.status_code"]).toBe(500);
    await app2.close();
  });

  it("emits a `me` span on 200, 401 and 503 paths, without the attendee ID", async () => {
    const reg = (await register()).json() as RegisterResponse;
    const auth = { authorization: `Bearer ${reg.token}` };
    exporter.reset();

    expect((await app.inject({ method: "GET", url: "/api/me", headers: auth })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
    await db.query("delete from attendees");
    expect((await app.inject({ method: "GET", url: "/api/me", headers: auth })).statusCode).toBe(401);

    const app2 = Fastify({ logger: false });
    await app2.register(registerRoutes, { db: failing(db, () => true), tokens: createTokenService({ key: KEY, now }), embed });
    expect((await app2.inject({ method: "GET", url: "/api/me", headers: auth })).statusCode).toBe(503);
    await app2.close();

    const spans = exporter.getFinishedSpans().filter((s) => s.name === "me");
    expect(spans.map((s) => s.attributes["http.response.status_code"])).toEqual([200, 401, 401, 503]);
    for (const s of spans) {
      expect(s.ended).toBe(true);
      expect(JSON.stringify(s.attributes)).not.toContain(reg.attendeeId);
    }
  });

  it("still registers when the embedder is down, without an interest vector", async () => {
    const app2 = Fastify({ logger: false });
    await app2.register(registerRoutes, {
      db,
      tokens: createTokenService({ key: KEY }),
      embed: async () => {
        throw new Error("inference down");
      },
    });
    const res = await app2.inject({ method: "POST", url: "/api/register", payload: validBody });
    expect(res.statusCode).toBe(201);
    expect((await attendeeRow(res.json().attendeeId))!.has_vector).toBe(false);
    await app2.close();
  });

  it("rate limits registration", async () => {
    for (let i = 0; i < 3; i++) expect((await register()).statusCode).toBe(201);
    expect((await register()).statusCode).toBe(429);
  });

  it("emits a `register` span with allowlisted attributes only, never the attendee ID", async () => {
    const reg = (await register()).json() as RegisterResponse;
    const spans = exporter.getFinishedSpans().filter((s) => s.name === "register");
    expect(spans).toHaveLength(1);
    const allow = new Set([
      "http.request.method", "http.response.status_code", "http.route", "server.address", "server.port",
      "rpc.system", "rpc.service", "rpc.method", "db.system", "db.operation.name", "db.namespace",
      "room.id", "access.decision", "search.mode", "search.hits",
    ]);
    for (const key of Object.keys(spans[0]!.attributes)) expect(allow.has(key)).toBe(true);
    expect(spans[0]!.attributes["http.response.status_code"]).toBe(201);
    expect(JSON.stringify(spans[0]!.attributes)).not.toContain(reg.attendeeId);
    expect(JSON.stringify(spans[0]!.events)).not.toContain(reg.attendeeId);
  });
});

describe("register body validation", () => {
  const rejects = (body: unknown) => expect(registerBodySchema.safeParse(body).success).toBe(false);

  it("accepts a valid body and drops unknown fields", () => {
    const r = registerBodySchema.safeParse({ ...validBody, religion: "x", health: "y" });
    expect(r.success).toBe(true);
    expect(Object.keys(r.data!).sort()).toEqual(["consent", "email", "interests", "name"]);
  });

  it("accepts a body without email", () => {
    const { email: _e, ...noEmail } = validBody;
    expect(registerBodySchema.safeParse(noEmail).success).toBe(true);
  });

  it("rejects bad bodies", () => {
    rejects(undefined);
    rejects({ ...validBody, name: "   " });
    rejects({ ...validBody, name: "x".repeat(81) });
    rejects({ ...validBody, interests: [] });
    rejects({ ...validBody, interests: "kubernetes" });
    rejects({ ...validBody, interests: [""] });
    rejects({ ...validBody, interests: ["x".repeat(65)] });
    rejects({ ...validBody, interests: Array.from({ length: 21 }, (_, i) => `t${i}`) });
    rejects({ ...validBody, interests: [42] });
    rejects({ ...validBody, consent: { clusterMap: "yes", qrCheckin: true } });
  });

  it("returns 400 over HTTP without echoing values", async () => {
    const app = Fastify({ logger: false });
    const db = await testDb();
    await app.register(registerRoutes, { db, tokens: createTokenService({ key: KEY }), embed });
    const res = await app.inject({ method: "POST", url: "/api/register", payload: { ...validBody, name: "", interests: ["secret-value".repeat(10)] } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("secret-value");
    await app.close();
    await db.close();
  });
});
