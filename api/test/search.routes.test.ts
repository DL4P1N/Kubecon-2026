import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { OnboardingResponse, ScheduleResponse, SearchResponse } from "@cc/shared";
import { createTokenService } from "../src/auth/token.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { RETRY_AFTER_SECONDS, registerSearchRoutes } from "../src/routes/search.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { loggerOptions } from "../src/telemetry/logger.js";
import { A, CATALOG, failingDb, recordingDb, seededDb } from "./search-fixtures.js";

const embedder = new LocalHashEmbedder();

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => {
  spans.length = 0;
});

async function server(extra: Record<string, unknown> = {}) {
  const db = recordingDb(await seededDb());
  return { db, app: buildServer(loadConfig({}), { db, embedder, ...extra }) };
}
const ids = (r: SearchResponse) => r.hits.map((h) => h.talk.id);

describe("GET /api/search", () => {
  it("keyword mode matches stemmed terms and returns scored hits with the keyword leg", async () => {
    const { app } = await server();
    const res = await app.inject({ method: "GET", url: "/api/search?q=supply%20chain&mode=keyword" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchResponse;
    expect(body.mode).toBe("keyword");
    expect(ids(body).slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(ids(body)).not.toContain("d");
    expect(body.hits[0]).toMatchObject({ matched: ["keyword"], talk: { speaker: expect.any(String), level: "beginner" } });
    expect(body.hits[0]!.score).toBeGreaterThan(0);
    expect(body.debug).toBeUndefined();
    // Dates come back as ISO strings.
    expect(body.hits.find((h) => h.talk.id === "a")!.talk).toMatchObject({ start: A.start, end: A.end, tags: A.tags });
  });

  it("ranks a title match above an abstract-only match", async () => {
    const { app } = await server();
    const body = (await app.inject({ method: "GET", url: "/api/search?q=sigstore&mode=keyword" })).json() as SearchResponse;
    expect(ids(body)).toEqual(["a"]);
    const t = (await app.inject({ method: "GET", url: "/api/search?q=opentelemetry&mode=keyword" })).json() as SearchResponse;
    expect(ids(t)[0]).toBe("d");
  });

  it.each(["keyword", "hybrid"])("forgives a misspelled query in %s mode (#55)", async (mode) => {
    const { app } = await server();
    const body = (await app.inject({ method: "GET", url: `/api/search?q=kuberentes&mode=${mode}` })).json() as SearchResponse;
    const kw = body.hits.filter((h) => h.matched?.includes("keyword")).map((h) => h.talk.id);
    expect(kw).toContain("c");
  });

  it("hybrid mode (default) fuses both legs and reports which legs matched", async () => {
    const { app } = await server();
    const res = await app.inject({ method: "GET", url: "/api/search?q=supply%20chain%20builds" });
    const body = res.json() as SearchResponse;
    expect(body.mode).toBe("hybrid");
    expect(ids(body).slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(body.hits[0]!.matched).toEqual(["keyword", "semantic"]);
    // The semantic leg ranks every talk, so unrelated ones appear with the semantic leg only.
    const d = body.hits.find((h) => h.talk.id === "d");
    expect(d?.matched).toEqual(["semantic"]);
    const scores = body.hits.map((h) => h.score);
    expect(scores).toEqual([...scores].sort((x, y) => y - x));
  });

  it("respects size", async () => {
    const { app } = await server();
    const body = (await app.inject({ method: "GET", url: "/api/search?q=kubernetes&size=2" })).json() as SearchResponse;
    expect(body.hits).toHaveLength(2);
  });

  it("debug=1 describes the plan (engine, mode, parameter count) without SQL, parameter values or the query text", async () => {
    const { app } = await server();
    const q = "zebra-secret-query";
    const res = await app.inject({ method: "GET", url: `/api/search?q=${q}&mode=hybrid&debug=1` });
    const debug = (res.json() as SearchResponse).debug as Record<string, unknown>;
    expect(Object.keys(debug).sort()).toEqual(["engine", "mode", "paramCount"]);
    expect(debug).toMatchObject({ engine: "postgres", mode: "hybrid", paramCount: expect.any(Number) });
    expect(JSON.stringify(debug)).not.toMatch(/select|from talks|\$1|tsquery/i);
    expect(JSON.stringify(debug)).not.toContain(q);
  });

  it("emits search and embed spans with only allowlisted attributes and no query text", async () => {
    const { app } = await server();
    await app.inject({ method: "GET", url: "/api/search?q=hello-canary" });
    const search = spans.find((s) => s.name === "search")!;
    expect(search.attrs).toEqual({ "search.mode": "hybrid" });
    expect(search.set).toEqual({ "search.hits": CATALOG.length });
    expect(spans.some((s) => s.name === "embed")).toBe(true);
    await app.inject({ method: "GET", url: "/api/search?q=hello&mode=keyword" });
    expect(spans.filter((s) => s.name === "embed")).toHaveLength(1);
    expect(JSON.stringify(spans)).not.toContain("hello-canary");
  });

  it.each([
    ["/api/search?mode=keyword", "missing q"],
    ["/api/search?q=x&mode=bogus", "bad mode"],
    ["/api/search?q=x&size=0", "size too small"],
    ["/api/search?q=x&size=51", "size too large"],
    [`/api/search?q=${"a".repeat(501)}`, "q too long"],
  ])("rejects %s (%s) without touching the database", async (url) => {
    const { app, db } = await server();
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
    expect(db.statements).toHaveLength(0);
  });

  it("returns 400 (not 500) for a repeated q parameter", async () => {
    const { app, db } = await server();
    const res = await app.inject({ method: "GET", url: "/api/search?q=a&q=b" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
    expect(db.statements).toHaveLength(0);
  });

  it("treats operators and quotes in q as plain text", async () => {
    const { app } = await server();
    for (const q of ["'; drop table talks; --", "supply & | ! ( ) :*", '"unbalanced', "%_\\"]) {
      const res = await app.inject({ method: "GET", url: `/api/search?q=${encodeURIComponent(q)}&mode=keyword` });
      expect(res.statusCode).toBe(200);
    }
    const body = (await app.inject({ method: "GET", url: "/api/search?q=supply&mode=keyword" })).json() as SearchResponse;
    expect(body.hits.length).toBeGreaterThan(0);
  });
});

// Failures: the driver message echoes the query on purpose; nothing from it may reach the client, a span or the log.
const SECRET = "zebra-secret-query";

function appWithLogs(db: ReturnType<typeof failingDb>) {
  const lines: string[] = [];
  const all: string[] = [];
  const keep = (l: string) => {
    all.push(l);
    if (String(JSON.parse(l).msg).startsWith("database request failed")) lines.push(l);
  };
  const app = Fastify({ logger: { ...loggerOptions, level: "info", stream: { write: keep } } });
  registerSearchRoutes(app, { db, embedder, resolveAttendee: async () => "attendee-test" });
  return { app, lines, all };
}

describe("database failures are diagnosable without leaking", () => {
  it("maps an unreachable database to 503 + Retry-After, with error.type on the span and one log line", async () => {
    const { app, lines, all } = appWithLogs(failingDb({ code: "ECONNREFUSED", message: `connect failed near "${SECRET}"` }));
    const res = await app.inject({ method: "GET", url: `/api/search?q=${SECRET}&mode=hybrid` });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe(String(RETRY_AFTER_SECONDS));
    expect(res.json()).toEqual({ error: "search_overloaded" });
    expect(spans.find((s) => s.name === "search")!.set["error.type"]).toBe("ECONNREFUSED");
    const diag = lines.map((l) => JSON.parse(l));
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatchObject({ "error.type": "ECONNREFUSED", "http.route": "/api/search", level: 40 });
    expect(all.length).toBeGreaterThan(lines.length);
    expect(JSON.stringify({ spans, all, body: res.body, headers: res.headers })).not.toContain(SECRET);
  });

  it("keeps another database error as 502 search_unavailable and records its SQLSTATE", async () => {
    const { app, lines, all } = appWithLogs(failingDb({ code: "42601", message: `syntax error at or near "${SECRET}"` }));
    const res = await app.inject({ method: "GET", url: `/api/search?q=${SECRET}` });
    expect(res.statusCode).toBe(502);
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(res.json()).toEqual({ error: "search_unavailable" });
    expect(spans.find((s) => s.name === "search")!.set["error.type"]).toBe("42601");
    expect(lines).toHaveLength(1);
    expect(JSON.stringify({ spans, all, body: res.body })).not.toContain(SECRET);
  });

  it("applies to onboarding and schedule paths too", async () => {
    const { app } = appWithLogs(failingDb({ code: "ECONNREFUSED", message: SECRET }));
    const onboarding = await app.inject({ method: "POST", url: "/api/onboarding", payload: { answers: { topics: ["security"], freeText: SECRET } } });
    expect(onboarding.statusCode).toBe(503);
    expect(onboarding.headers["retry-after"]).toBe(String(RETRY_AFTER_SECONDS));
    spans.length = 0;
    const save = await app.inject({ method: "POST", url: "/api/schedule", payload: { talkIds: ["a"] } });
    expect(save.statusCode).toBe(503);
    expect(spans.find((s) => s.name === "attendee.check")!.set["error.type"]).toBe("ECONNREFUSED");
    expect(JSON.stringify({ spans, bodies: [onboarding.body, save.body] })).not.toContain(SECRET);
  });
});

describe("POST /api/onboarding", () => {
  const answers = {
    topics: ["security", "supply chain"],
    experience: "beginner",
    goals: ["learn the basics"],
    freeText: "new to this",
    availableFrom: "2026-11-10T08:00:00.000Z",
    availableTo: "2026-11-10T18:00:00.000Z",
  };

  it("filters by level and time window and returns ranked talks", async () => {
    const { app } = await server();
    const res = await app.inject({ method: "POST", url: "/api/onboarding?debug=1", payload: { answers } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OnboardingResponse;
    expect(body.query).toEqual({
      text: "security supply chain learn the basics new to this",
      topics: ["security", "supply chain"],
      mode: "hybrid",
    });
    // beginner -> beginner + intermediate; D is advanced and never returned. E (beginner) is included.
    const got = body.hits.map((h) => h.talk.id);
    expect(got).not.toContain("d");
    expect(got.slice(0, 2).sort()).toEqual(["a", "b"]);
    expect(Object.keys(body.debug as object).sort()).toEqual(["engine", "mode", "paramCount"]);
  });

  it("applies the availability window to start and end", async () => {
    const { app } = await server();
    const narrow = { ...answers, availableFrom: "2026-11-10T11:00:00.000Z", availableTo: "2026-11-10T12:00:00.000Z" };
    const body = (await app.inject({ method: "POST", url: "/api/onboarding", payload: { answers: narrow } })).json() as OnboardingResponse;
    expect(body.hits.map((h) => h.talk.id).sort()).toEqual(["c", "e"]);
  });

  it("rejects bad answers", async () => {
    const { app } = await server();
    const post = (a: unknown) => app.inject({ method: "POST", url: "/api/onboarding", payload: { answers: a } });
    expect((await post(undefined)).statusCode).toBe(400);
    expect((await post({ topics: "x" })).statusCode).toBe(400);
    expect((await post({ topics: [], experience: "wizard" })).statusCode).toBe(400);
    expect((await post({ topics: [], availableFrom: "soon" })).statusCode).toBe(400);
  });

  it("skips the database when the answers produce no text", async () => {
    const { app, db } = await server();
    const res = await app.inject({ method: "POST", url: "/api/onboarding", payload: { answers: { topics: [], experience: "beginner", goals: [] } } });
    expect((res.json() as OnboardingResponse).hits).toEqual([]);
    expect(db.statements).toHaveLength(0);
  });
});

const KEY = "test-signing-key-that-is-long-enough-0123456789";

describe("schedule routes", () => {
  const fixedNow = new Date("2026-11-10T07:00:00.000Z");
  let clock = fixedNow.getTime();
  const tokens = createTokenService({ key: KEY, now: () => clock });
  const asAttendee = async (id: string): Promise<Record<string, string>> => ({
    authorization: `Bearer ${(await tokens.sign(id)).token}`,
  });
  const scheduleServer = async (search: Record<string, unknown> = {}) => {
    const raw = await seededDb();
    // Saving a schedule requires a live attendee row for every id these tests sign in as.
    for (const id of ["ada-1", "bob-2", "new-3", "victim-7", "zed-42"]) {
      await raw.query(
        `insert into attendees (id, display_name, interests, consent_cluster_map, consent_qr_checkin, created_at, expires_at)
         values ($1, 'x', '{}', false, false, now(), '9999-12-31T23:59:59.999Z')`,
        [id],
      );
    }
    const db = recordingDb(raw);
    return { db, app: buildServer(loadConfig({}), { db, embedder, tokens, search: { now: () => fixedNow, ...search } }) };
  };
  const savedRow = async (db: Awaited<ReturnType<typeof seededDb>>, id: string) =>
    (await db.query<{ talk_ids: string[]; updated_at: Date; expires_at: Date }>("select * from schedules where attendee_id = $1", [id])).rows[0];

  afterEach(() => {
    clock = fixedNow.getTime();
  });

  it("builds an overlap-free schedule from answers, saves it and reads it back", async () => {
    const { app, db } = await scheduleServer();
    const headers = await asAttendee("ada-1");
    const res = await app.inject({ method: "POST", url: "/api/schedule", headers, payload: { answers: { topics: ["security supply chain"], experience: "beginner", goals: [] } } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ScheduleResponse;
    const chosen = body.items.map((i) => i.talk.id);
    // One of the overlapping A/B wins; the other is dropped; no two chosen talks overlap.
    expect(chosen.filter((i) => i === "a" || i === "b")).toHaveLength(1);
    expect(body.droppedTalkIds).toContain(["a", "b"].find((i) => !chosen.includes(i)));
    expect(chosen).not.toContain("d");
    expect(spans.some((s) => s.name === "schedule.build")).toBe(true);

    const saved = await savedRow(db, "ada-1");
    expect(saved!.talk_ids).toEqual(chosen);
    expect(saved!.updated_at.toISOString()).toBe(fixedNow.toISOString());
    // Default policy: schedules are kept like profiles (ATTENDEE_RETENTION_HOURS unset).
    expect(saved!.expires_at.toISOString()).toBe("9999-12-31T23:59:59.999Z");

    const get = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect((get.json() as ScheduleResponse).items.map((i) => i.talk.id).sort()).toEqual([...chosen].sort());
  });

  it("saves explicit talkIds in priority order and reports unknown and conflicting ids", async () => {
    const { app, db } = await scheduleServer();
    const headers = await asAttendee("ada-1");
    const res = await app.inject({ method: "POST", url: "/api/schedule", headers, payload: { talkIds: ["b", "a", "c", "nope"] } });
    const body = res.json() as ScheduleResponse;
    expect(body.items.map((i) => i.talk.id)).toEqual(["b", "c"]);
    expect(body.droppedTalkIds).toEqual(["nope", "a"]);
    // Only the overlap is a conflict; the unknown id is not.
    expect(body.skipped?.map(({ talkId, conflictsWith }) => ({ talkId, conflictsWith }))).toEqual([{ talkId: "a", conflictsWith: ["b"] }]);
    expect(body.skipped?.[0]?.talk?.id).toBe("a");
    expect((await savedRow(db, "ada-1"))!.talk_ids).toEqual(["b", "c"]);
    const get = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect((get.json() as ScheduleResponse).skipped).toBeUndefined();
  });

  it("saving again replaces the previous schedule", async () => {
    const { app, db } = await scheduleServer();
    const headers = await asAttendee("ada-1");
    await app.inject({ method: "POST", url: "/api/schedule", headers, payload: { talkIds: ["a"] } });
    await app.inject({ method: "POST", url: "/api/schedule", headers, payload: { talkIds: ["c"] } });
    expect((await savedRow(db, "ada-1"))!.talk_ids).toEqual(["c"]);
    expect((await db.query("select 1 from schedules")).rowCount).toBe(1);
  });

  it("keeps two registered attendees' schedules separate", async () => {
    const { app, db } = await scheduleServer();
    const ada = await asAttendee("ada-1");
    const bob = await asAttendee("bob-2");
    expect((await app.inject({ method: "POST", url: "/api/schedule", headers: ada, payload: { talkIds: ["a"] } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/schedule", headers: bob, payload: { talkIds: ["c"] } })).statusCode).toBe(200);
    expect((await savedRow(db, "ada-1"))!.talk_ids).toEqual(["a"]);
    expect((await savedRow(db, "bob-2"))!.talk_ids).toEqual(["c"]);
    const got = async (headers: Record<string, string>) =>
      ((await app.inject({ method: "GET", url: "/api/schedule", headers })).json() as ScheduleResponse).items.map((i) => i.talk.id);
    expect(await got(ada)).toEqual(["a"]);
    expect(await got(bob)).toEqual(["c"]);
    expect(JSON.stringify(spans)).not.toContain("ada-1");
    expect(JSON.stringify(spans)).not.toContain("bob-2");
  });

  it.each<[string, () => Promise<Record<string, string>>]>([
    ["no Authorization header", async () => ({})],
    ["an unsigned stub-style token", async () => ({ authorization: "Bearer stub.victim-7" })],
    ["a malformed token", async () => ({ authorization: "Bearer a.b.c" })],
    [
      "a tampered token (payload swapped, original signature)",
      async () => {
        const [h, , sig] = (await tokens.sign("ada-1")).token.split(".");
        const claims = { sub: "victim-7", iss: "conference-companion", aud: "attendee", exp: 4102444800 };
        const forged = Buffer.from(JSON.stringify(claims)).toString("base64url");
        return { authorization: `Bearer ${h}.${forged}.${sig}` };
      },
    ],
    ["a token signed with another key", async () => ({ authorization: `Bearer ${(await createTokenService({ key: `${KEY}-other` }).sign("victim-7")).token}` })],
    [
      "an expired token",
      async () => {
        const headers = await asAttendee("victim-7");
        clock += 9 * 60 * 60 * 1000; // past the 8h session lifetime
        return headers;
      },
    ],
  ])("returns 401 for %s and never touches any schedule", async (_label, makeHeaders) => {
    const { app, db } = await scheduleServer();
    await db.query("insert into schedules (attendee_id, talk_ids, updated_at, expires_at) values ('victim-7', '{a}', now(), '2099-01-01')");
    db.statements.length = 0;
    const headers = await makeHeaders();
    const get = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect(get.statusCode).toBe(401);
    expect(get.headers["www-authenticate"]).toMatch(/^Bearer/);
    const post = await app.inject({ method: "POST", url: "/api/schedule", headers, payload: { talkIds: ["a"] } });
    expect(post.statusCode).toBe(401);
    expect((await savedRow(db, "victim-7"))!.talk_ids).toEqual(["a"]);
    expect((await db.query("select 1 from schedules")).rowCount).toBe(1);
    expect(db.statements.filter((s) => !s.startsWith("select 1 from schedules") && !s.startsWith("select * from schedules"))).toHaveLength(0);
    await new Promise((r) => setImmediate(r));
    expect(spans.map((s) => [s.name, s.set["http.response.status_code"]])).toEqual([
      ["schedule.get", 401],
      ["schedule.save", 401],
    ]);
    expect(JSON.stringify(spans)).not.toContain("victim-7");
  });

  it("fails closed with 401 when no token service is wired", async () => {
    const db = recordingDb(await seededDb());
    const app = Fastify();
    registerSearchRoutes(app, { db, embedder });
    const res = await app.inject({ method: "GET", url: "/api/schedule", headers: await asAttendee("ada-1") });
    expect(res.statusCode).toBe(401);
    expect(db.statements).toHaveLength(0);
  });

  it("keeps search and onboarding public (no token needed)", async () => {
    const { app } = await scheduleServer();
    expect((await app.inject({ method: "GET", url: "/api/search?q=x&mode=keyword" })).statusCode).toBe(200);
    const onboarding = await app.inject({ method: "POST", url: "/api/onboarding", payload: { answers: { topics: ["security"] } } });
    expect(onboarding.statusCode).toBe(200);
  });

  it("keys schedules per injected attendee resolver without exposing the id in spans", async () => {
    const { app, db } = await scheduleServer({ resolveAttendee: async () => "zed-42" });
    await app.inject({ method: "POST", url: "/api/schedule", payload: { talkIds: ["a"] } });
    await app.inject({ method: "GET", url: "/api/schedule" });
    expect(await savedRow(db, "zed-42")).toBeDefined();
    expect(JSON.stringify(spans)).not.toContain("zed-42");
  });

  it("ignores expired schedules on load and serves unexpired ones", async () => {
    const { app, db } = await scheduleServer();
    const headers = await asAttendee("ada-1");
    const put = (expires: string) =>
      db.query(
        `insert into schedules (attendee_id, talk_ids, updated_at, expires_at) values ('ada-1', '{a}', '2026-11-09T00:00:00Z', $1)
         on conflict (attendee_id) do update set expires_at = excluded.expires_at`,
        [expires],
      );
    await put("2026-11-10T06:59:59.000Z");
    const expired = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect(expired.json()).toEqual({ items: [], updatedAt: new Date(0).toISOString() });
    await put("2026-11-10T07:00:01.000Z");
    const live = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect((live.json() as ScheduleResponse).items.map((i) => i.talk.id)).toEqual(["a"]);
  });

  it("wraps GET /api/schedule in a request span plus attribute-free load and fetch spans", async () => {
    const { app } = await scheduleServer();
    const headers = await asAttendee("ada-1");
    await app.inject({ method: "POST", url: "/api/schedule", headers, payload: { talkIds: ["a"] } });
    spans.length = 0;
    await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect(spans.map((s) => s.name)).toEqual(["schedule.get", "schedule.load", "talks.fetch"]);
    expect(spans[0]!.attrs).toEqual({ "http.request.method": "GET", "http.route": "/api/schedule" });
    expect(spans[0]!.set).toEqual({ "http.response.status_code": 200 });
    expect(spans.slice(1).every((s) => Object.keys(s.attrs).length === 0)).toBe(true);
    expect(JSON.stringify(spans)).not.toContain("ada-1");
  });

  it("returns an empty schedule when nothing was saved", async () => {
    const { app } = await scheduleServer();
    const res = await app.inject({ method: "GET", url: "/api/schedule", headers: await asAttendee("new-3") });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ScheduleResponse).items).toEqual([]);
  });

  it("validates the body", async () => {
    const { app } = await scheduleServer();
    const headers = await asAttendee("ada-1");
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/schedule", headers, payload: payload as object });
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ talkIds: [1] })).statusCode).toBe(400);
    expect((await post({ talkIds: ["a"], maxTalks: 0 })).statusCode).toBe(400);
    expect((await post({ answers: { topics: 3 } })).statusCode).toBe(400);
  });
});

