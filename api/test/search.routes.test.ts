import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { OnboardingResponse, ScheduleResponse, SearchResponse } from "@cc/shared";
import { createTokenService } from "../src/auth/token.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { RETRY_AFTER_SECONDS, registerSearchRoutes } from "../src/routes/search.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { loggerOptions } from "../src/telemetry/logger.js";
import { esHit, fakeEs, talk, type FakeHandler } from "./helpers.js";

const A = talk("a", 9, 10, { level: "beginner" });
const B = talk("b", 9, 10, { level: "beginner" }); // overlaps A
const C = talk("c", 11, 12, { level: "intermediate" });

/** In-memory ES: serves talk searches from a fixed hit list and stores schedule docs. */
function memoryEs(searchHits: ReturnType<typeof esHit>[]) {
  const docs = new Map<string, unknown>();
  const handler: FakeHandler = (call) => {
    if (call.path.startsWith("/talks/_search")) return { body: { took: 3, hits: { hits: searchHits } } };
    if (call.path.startsWith("/schedules/_doc/")) {
      const id = decodeURIComponent(call.path.split("/")[3]!.split("?")[0]!);
      if (call.method === "PUT") {
        docs.set(id, call.body);
        return { body: { result: "created" } };
      }
      return docs.has(id) ? { body: { found: true, _source: docs.get(id) } } : { status: 404, body: { found: false } };
    }
    return undefined;
  };
  return { es: fakeEs(handler), docs };
}

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => {
  spans.length = 0;
});

const hits = [esHit(A, 0.03, ["keyword", "semantic"]), esHit(C, 0.02, ["semantic"]), esHit(B, 0.01, ["keyword"])];

describe("GET /api/search", () => {
  it("sends a misspelled query to Elasticsearch with fuzziness in both modes (#55)", async () => {
    for (const mode of ["keyword", "hybrid"]) {
      const { es } = memoryEs([esHit(A, 4.2, ["keyword"])]);
      const app = buildServer(loadConfig({}), { es });
      const res = await app.inject({ method: "GET", url: `/api/search?q=kuberentes&mode=${mode}` });
      expect(res.statusCode).toBe(200);
      const body = JSON.stringify(es.calls[0]!.body);
      expect(body).toContain('"query":"kuberentes"');
      expect(body).toContain('"fuzziness":"AUTO"');
      expect(body).toContain('"prefix_length":1');
    }
  });
  it("keyword mode sends a multi_match and returns scored hits", async () => {
    const { es } = memoryEs([esHit(A, 4.2, ["keyword"])]);
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "GET", url: "/api/search?q=supply%20chain&mode=keyword" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SearchResponse;
    expect(body.mode).toBe("keyword");
    expect(body.hits[0]).toMatchObject({ score: 4.2, matched: ["keyword"], talk: { id: "a", speaker: "Someone", level: "beginner" } });
    expect(body.debug).toBeUndefined();
    expect(es.calls[0]!.path).toBe("/talks/_search");
    expect(JSON.stringify(es.calls[0]!.body)).toContain("multi_match");
  });

  it("hybrid mode (default) uses the RRF retriever and reports matched legs", async () => {
    const { es } = memoryEs(hits);
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "GET", url: "/api/search?q=secure%20my%20builds" });
    const body = res.json() as SearchResponse;
    expect(body.mode).toBe("hybrid");
    expect(body.hits.map((h) => h.matched)).toEqual([["keyword", "semantic"], ["semantic"], ["keyword"]]);
    expect(JSON.stringify(es.calls[0]!.body)).toContain('"rrf"');
  });

  it("debug=1 returns the exact ES request body", async () => {
    const { es } = memoryEs(hits);
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "GET", url: "/api/search?q=x&mode=hybrid&debug=1" });
    expect((res.json() as SearchResponse).debug).toEqual(es.calls[0]!.body);
  });

  it("emits search and embed spans with only allowlisted attributes", async () => {
    const { es } = memoryEs(hits);
    const app = buildServer(loadConfig({}), { es });
    await app.inject({ method: "GET", url: "/api/search?q=hello" });
    const search = spans.find((s) => s.name === "search")!;
    expect(search.attrs).toEqual({ "search.mode": "hybrid" });
    expect(search.set).toEqual({ "search.hits": 3 });
    expect(spans.some((s) => s.name === "embed")).toBe(true);
    await app.inject({ method: "GET", url: "/api/search?q=hello&mode=keyword" });
    expect(spans.filter((s) => s.name === "embed")).toHaveLength(1);
  });

  it.each([
    ["/api/search?mode=keyword", "missing q"],
    ["/api/search?q=x&mode=bogus", "bad mode"],
    ["/api/search?q=x&size=0", "size too small"],
    ["/api/search?q=x&size=51", "size too large"],
    [`/api/search?q=${"a".repeat(501)}`, "q too long"],
  ])("rejects %s (%s)", async (url) => {
    const { es } = memoryEs([]);
    const app = buildServer(loadConfig({}), { es });
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
    expect(es.calls).toHaveLength(0);
  });

  it("answers 502 without leaking details when ES fails", async () => {
    const es = fakeEs(() => ({ status: 500, body: {} }));
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "GET", url: "/api/search?q=x" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "search_unavailable" });
  });
});

// Realistic Elasticsearch error bodies. The reason text echoes the query on purpose:
// nothing from it may reach the client, a span or the log.
const SECRET = "zebra-secret-query";
const ES_429_NO_ML_CAPACITY = {
  error: {
    root_cause: [
      {
        type: "inference_exception",
        reason: `Could not start deployment because no ML nodes with sufficient capacity were found [query: ${SECRET}]`,
      },
    ],
    type: "search_phase_execution_exception",
    reason: "all shards failed",
    phase: "query",
    grouped: true,
    failed_shards: [],
  },
  status: 429,
};
const ES_400_PARSING = {
  error: {
    root_cause: [{ type: "parsing_exception", reason: `[rrf] unknown field [bogus] near "${SECRET}"`, line: 1, col: 40 }],
    type: "parsing_exception",
    reason: `[rrf] unknown field [bogus] near "${SECRET}"`,
    line: 1,
    col: 40,
  },
  status: 400,
};

/**
 * Fastify app using the production logger options (telemetry/logger.ts: redaction,
 * query-string-free request serializer) with a capturing stream. `lines` holds only the
 * diagnostic line; `all` holds every log line (request/response lines included).
 */
function appWithLogs(es: ReturnType<typeof fakeEs>) {
  const lines: string[] = [];
  const all: string[] = [];
  const keep = (l: string) => {
    all.push(l);
    if (String(JSON.parse(l).msg).startsWith("elasticsearch request failed")) lines.push(l);
  };
  const app = Fastify({ logger: { ...loggerOptions, level: "info", stream: { write: keep } } });
  registerSearchRoutes(app, { es, resolveAttendee: async () => "attendee-test" });
  return { app, lines, all };
}

describe("Elasticsearch failures are diagnosable", () => {
  it("maps a 429 inference capacity error to 503 + Retry-After, with error.type on spans and one log line", async () => {
    const es = fakeEs(() => ({ status: 429, body: ES_429_NO_ML_CAPACITY }));
    const { app, lines, all } = appWithLogs(es);
    const res = await app.inject({ method: "GET", url: `/api/search?q=${SECRET}&mode=hybrid` });

    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe(String(RETRY_AFTER_SECONDS));
    expect(res.json()).toEqual({ error: "search_overloaded" });
    // Hybrid must not silently fall back to keyword: exactly one ES call, the hybrid one.
    expect(es.calls).toHaveLength(1);

    expect(spans.find((s) => s.name === "search")!.set["error.type"]).toBe("inference_exception");
    expect(spans.find((s) => s.name === "embed")!.set["error.type"]).toBe("inference_exception");

    const diag = lines.map((l) => JSON.parse(l));
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatchObject({
      "error.type": "inference_exception",
      "http.route": "/api/search",
      msg: "elasticsearch request failed with status 429 (overloaded)",
      level: 40,
    });

    // Request/response lines went through the same redacting logger and carry no query string.
    expect(all.length).toBeGreaterThan(lines.length);
    expect(all.some((l) => JSON.parse(l).req?.path === "/api/search")).toBe(true);
    const everything = JSON.stringify({ spans, all, body: res.body, headers: res.headers });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("ML nodes");
    expect(everything).not.toContain("authorization");
  });

  it("keeps a 400 parsing error as 502 search_unavailable and records its type", async () => {
    const es = fakeEs(() => ({ status: 400, body: ES_400_PARSING }));
    const { app, lines, all } = appWithLogs(es);
    const res = await app.inject({ method: "GET", url: `/api/search?q=${SECRET}` });

    expect(res.statusCode).toBe(502);
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(res.json()).toEqual({ error: "search_unavailable" });
    expect(spans.find((s) => s.name === "search")!.set["error.type"]).toBe("parsing_exception");
    const diag = lines.map((l) => JSON.parse(l));
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatchObject({ "error.type": "parsing_exception", msg: "elasticsearch request failed with status 400" });
    expect(JSON.stringify({ spans, all, body: res.body })).not.toContain(SECRET);
  });

  it("falls back to http_<status> when the body has no error type", async () => {
    const es = fakeEs(() => ({ status: 500, body: "<html>proxy error</html>" }));
    const { app } = appWithLogs(es);
    const res = await app.inject({ method: "GET", url: "/api/search?q=x" });
    expect(res.statusCode).toBe(502);
    expect(spans.find((s) => s.name === "search")!.set["error.type"]).toBe("http_500");
  });

  it("applies to onboarding and schedule paths too", async () => {
    const es = fakeEs(() => ({ status: 429, body: ES_429_NO_ML_CAPACITY }));
    const { app } = appWithLogs(es);
    const onboarding = await app.inject({
      method: "POST",
      url: "/api/onboarding",
      payload: { answers: { topics: ["security"], freeText: SECRET } },
    });
    expect(onboarding.statusCode).toBe(503);
    expect(onboarding.headers["retry-after"]).toBe(String(RETRY_AFTER_SECONDS));
    expect(onboarding.json()).toEqual({ error: "search_overloaded" });

    spans.length = 0;
    const save = await app.inject({ method: "POST", url: "/api/schedule", payload: { talkIds: ["a"] } });
    expect(save.statusCode).toBe(503);
    expect(spans.find((s) => s.name === "talks.fetch")!.set["error.type"]).toBe("inference_exception");
    expect(JSON.stringify({ spans, bodies: [onboarding.body, save.body] })).not.toContain(SECRET);
  });
});

describe("GET /api/search repeated params", () => {
  it("returns 400 (not 500) for a repeated q parameter", async () => {
    const { es } = memoryEs([]);
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "GET", url: "/api/search?q=a&q=b" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_request" });
    expect(es.calls).toHaveLength(0);
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

  it("builds a hybrid query with level and time filters and returns ranked talks", async () => {
    const { es } = memoryEs(hits);
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "POST", url: "/api/onboarding?debug=1", payload: { answers } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as OnboardingResponse;
    expect(body.query).toEqual({
      text: "security supply chain learn the basics new to this",
      topics: ["security", "supply chain"],
      mode: "hybrid",
    });
    expect(body.hits).toHaveLength(3);
    const sent = JSON.stringify(es.calls[0]!.body);
    expect(sent).toContain('"rrf"');
    expect(sent).toContain('"level":["beginner","intermediate"]');
    expect(sent).toContain("2026-11-10T08:00:00.000Z");
    expect(body.debug).toEqual(es.calls[0]!.body);
  });

  it("rejects bad answers", async () => {
    const { es } = memoryEs([]);
    const app = buildServer(loadConfig({}), { es });
    const post = (a: unknown) => app.inject({ method: "POST", url: "/api/onboarding", payload: { answers: a } });
    expect((await post(undefined)).statusCode).toBe(400);
    expect((await post({ topics: "x" })).statusCode).toBe(400);
    expect((await post({ topics: [], experience: "wizard" })).statusCode).toBe(400);
    expect((await post({ topics: [], availableFrom: "soon" })).statusCode).toBe(400);
  });

  it("skips ES when the answers produce no text", async () => {
    const { es } = memoryEs(hits);
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "POST", url: "/api/onboarding", payload: { answers: { topics: [], experience: "beginner", goals: [] } } });
    expect((res.json() as OnboardingResponse).hits).toEqual([]);
    expect(es.calls).toHaveLength(0);
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
  const server = (es: ReturnType<typeof memoryEs>["es"], search: Record<string, unknown> = {}) =>
    buildServer(loadConfig({}), { es, tokens, search: { now: () => fixedNow, ...search } });

  afterEach(() => {
    clock = fixedNow.getTime();
  });

  it("builds an overlap-free schedule from answers, saves it and reads it back", async () => {
    const { es, docs } = memoryEs(hits);
    const app = server(es);
    const headers = await asAttendee("ada-1");
    const res = await app.inject({
      method: "POST",
      url: "/api/schedule",
      headers,
      payload: { answers: { topics: ["security"], experience: "beginner", goals: [] } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ScheduleResponse;
    // A (best score) wins over overlapping B; C fits.
    expect(body.items.map((i) => i.talk.id)).toEqual(["a", "c"]);
    expect(body.droppedTalkIds).toEqual(["b"]);
    expect(spans.some((s) => s.name === "schedule.build")).toBe(true);

    const saved = docs.get("ada-1") as Record<string, unknown>;
    expect(saved.talk_ids).toEqual(["a", "c"]);
    expect(saved.updated_at).toBe(fixedNow.toISOString());
    expect(saved.expires_at).toBe("2026-11-11T07:00:00.000Z");

    const get = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect((get.json() as ScheduleResponse).items.map((i) => i.talk.id).sort()).toEqual(["a", "c"]);
  });

  it("saves explicit talkIds in priority order and reports unknown and conflicting ids", async () => {
    const { es, docs } = memoryEs([esHit(A, 1), esHit(B, 1), esHit(C, 1)]);
    const app = server(es);
    const headers = await asAttendee("ada-1");
    const res = await app.inject({ method: "POST", url: "/api/schedule", headers, payload: { talkIds: ["b", "a", "c", "nope"] } });
    const body = res.json() as ScheduleResponse;
    expect(body.items.map((i) => i.talk.id)).toEqual(["b", "c"]);
    expect(body.droppedTalkIds).toEqual(["nope", "a"]);
    // Only the overlap is a conflict; the unknown id is not.
    expect(body.skipped?.map(({ talkId, conflictsWith }) => ({ talkId, conflictsWith }))).toEqual([{ talkId: "a", conflictsWith: ["b"] }]);
    expect(body.skipped?.[0]?.talk?.id).toBe("a");
    expect((docs.get("ada-1") as { talk_ids: string[] }).talk_ids).toEqual(["b", "c"]);
    const get = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect((get.json() as ScheduleResponse).skipped).toBeUndefined();
  });

  it("keeps two registered attendees' schedules separate", async () => {
    const { es, docs } = memoryEs([esHit(A, 1), esHit(C, 1)]);
    const app = server(es);
    const ada = await asAttendee("ada-1");
    const bob = await asAttendee("bob-2");
    expect((await app.inject({ method: "POST", url: "/api/schedule", headers: ada, payload: { talkIds: ["a"] } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/schedule", headers: bob, payload: { talkIds: ["c"] } })).statusCode).toBe(200);
    expect((docs.get("ada-1") as { talk_ids: string[] }).talk_ids).toEqual(["a"]);
    expect((docs.get("bob-2") as { talk_ids: string[] }).talk_ids).toEqual(["c"]);
    const ids = async (headers: Record<string, string>) =>
      ((await app.inject({ method: "GET", url: "/api/schedule", headers })).json() as ScheduleResponse).items.map((i) => i.talk.id);
    expect(await ids(ada)).toEqual(["a"]);
    expect(await ids(bob)).toEqual(["c"]);
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
    [
      "a token signed with another key",
      async () => ({ authorization: `Bearer ${(await createTokenService({ key: `${KEY}-other` }).sign("victim-7")).token}` }),
    ],
    [
      "an expired token",
      async () => {
        const headers = await asAttendee("victim-7");
        clock += 9 * 60 * 60 * 1000; // past the 8h session lifetime
        return headers;
      },
    ],
  ])("returns 401 for %s and never touches any schedule", async (_label, makeHeaders) => {
    const { es, docs } = memoryEs([esHit(A, 1)]);
    const victim = { talk_ids: ["a"], updated_at: "2026-11-09T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z" };
    docs.set("victim-7", victim);
    const app = server(es);
    const headers = await makeHeaders();
    const get = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect(get.statusCode).toBe(401);
    expect(get.headers["www-authenticate"]).toMatch(/^Bearer/);
    const post = await app.inject({ method: "POST", url: "/api/schedule", headers, payload: { talkIds: ["a"] } });
    expect(post.statusCode).toBe(401);
    expect(docs.get("victim-7")).toEqual(victim);
    expect(docs.size).toBe(1);
    expect(es.calls).toHaveLength(0);
    // Rejected requests are still traced, with allowlisted attributes only.
    // requireAttendee awaits reply.send(), which can settle just after inject() resolves.
    await new Promise((r) => setImmediate(r));
    expect(spans.map((s) => [s.name, s.set["http.response.status_code"]])).toEqual([
      ["schedule.get", 401],
      ["schedule.save", 401],
    ]);
    expect(JSON.stringify(spans)).not.toContain("victim-7");
  });

  it("fails closed with 401 when no token service is wired", async () => {
    const { es } = memoryEs([]);
    const app = Fastify();
    registerSearchRoutes(app, { es });
    const res = await app.inject({ method: "GET", url: "/api/schedule", headers: await asAttendee("ada-1") });
    expect(res.statusCode).toBe(401);
    expect(es.calls).toHaveLength(0);
  });

  it("keeps search and onboarding public (no token needed)", async () => {
    const { es } = memoryEs(hits);
    const app = server(es);
    expect((await app.inject({ method: "GET", url: "/api/search?q=x&mode=keyword" })).statusCode).toBe(200);
    const onboarding = await app.inject({ method: "POST", url: "/api/onboarding", payload: { answers: { topics: ["security"] } } });
    expect(onboarding.statusCode).toBe(200);
  });

  it("keys schedules per injected attendee resolver without exposing the id in spans", async () => {
    const { es, docs } = memoryEs([esHit(A, 1)]);
    const app = server(es, { resolveAttendee: async () => "zed-42" });
    await app.inject({ method: "POST", url: "/api/schedule", payload: { talkIds: ["a"] } });
    await app.inject({ method: "GET", url: "/api/schedule" });
    expect(docs.has("zed-42")).toBe(true);
    expect(JSON.stringify(spans)).not.toContain("zed-42");
  });

  it("ignores expired schedules on load and serves unexpired ones", async () => {
    const { es, docs } = memoryEs([esHit(A, 1)]);
    const app = server(es);
    const headers = await asAttendee("ada-1");
    const doc = (expires_at: string) => ({ talk_ids: ["a"], updated_at: "2026-11-09T00:00:00.000Z", expires_at });
    docs.set("ada-1", doc("2026-11-10T06:59:59.000Z"));
    const expired = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect(expired.json()).toEqual({ items: [], updatedAt: new Date(0).toISOString() });
    docs.set("ada-1", doc("2026-11-10T07:00:01.000Z"));
    const live = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect((live.json() as ScheduleResponse).items.map((i) => i.talk.id)).toEqual(["a"]);
  });

  it("wraps GET /api/schedule in a request span plus attribute-free load and fetch spans", async () => {
    const { es } = memoryEs([esHit(A, 1)]);
    const app = server(es);
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
    const { es } = memoryEs([]);
    const app = server(es);
    const res = await app.inject({ method: "GET", url: "/api/schedule", headers: await asAttendee("new-3") });
    expect(res.statusCode).toBe(200);
    expect((res.json() as ScheduleResponse).items).toEqual([]);
  });

  it("validates the body", async () => {
    const { es } = memoryEs([]);
    const app = server(es);
    const headers = await asAttendee("ada-1");
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/schedule", headers, payload: payload as object });
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ talkIds: [1] })).statusCode).toBe(400);
    expect((await post({ talkIds: ["a"], maxTalks: 0 })).statusCode).toBe(400);
    expect((await post({ answers: { topics: 3 } })).statusCode).toBe(400);
  });
});
