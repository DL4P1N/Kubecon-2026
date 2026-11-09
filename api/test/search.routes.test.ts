import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { FastifyRequest } from "fastify";
import type { OnboardingResponse, ScheduleResponse, SearchResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { RETRY_AFTER_SECONDS, STUB_ATTENDEE_ID, defaultResolveAttendee, registerSearchRoutes } from "../src/routes/search.js";
import { setSpanRunner } from "../src/telemetry/span.js";
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
 * Fastify app with a capturing logger. Only the diagnostic line is captured: Fastify's
 * default request serializer logs the raw URL, which the production logger options
 * (telemetry/logger.ts, task #12) strip separately.
 */
function appWithLogs(es: ReturnType<typeof fakeEs>) {
  const lines: string[] = [];
  const keep = (l: string) => {
    if (String(JSON.parse(l).msg).startsWith("elasticsearch request failed")) lines.push(l);
  };
  const app = Fastify({ logger: { level: "info", stream: { write: keep } } });
  registerSearchRoutes(app, { es });
  return { app, lines };
}

describe("Elasticsearch failures are diagnosable", () => {
  it("maps a 429 inference capacity error to 503 + Retry-After, with error.type on spans and one log line", async () => {
    const es = fakeEs(() => ({ status: 429, body: ES_429_NO_ML_CAPACITY }));
    const { app, lines } = appWithLogs(es);
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

    const everything = JSON.stringify({ spans, lines, body: res.body, headers: res.headers });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain("ML nodes");
    expect(everything).not.toContain("authorization");
  });

  it("keeps a 400 parsing error as 502 search_unavailable and records its type", async () => {
    const es = fakeEs(() => ({ status: 400, body: ES_400_PARSING }));
    const { app, lines } = appWithLogs(es);
    const res = await app.inject({ method: "GET", url: `/api/search?q=${SECRET}` });

    expect(res.statusCode).toBe(502);
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(res.json()).toEqual({ error: "search_unavailable" });
    expect(spans.find((s) => s.name === "search")!.set["error.type"]).toBe("parsing_exception");
    const diag = lines.map((l) => JSON.parse(l));
    expect(diag).toHaveLength(1);
    expect(diag[0]).toMatchObject({ "error.type": "parsing_exception", msg: "elasticsearch request failed with status 400" });
    expect(JSON.stringify({ spans, lines, body: res.body })).not.toContain(SECRET);
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

describe("schedule routes", () => {
  const fixedNow = new Date("2026-11-10T07:00:00.000Z");

  it("builds an overlap-free schedule from answers, saves it and reads it back", async () => {
    const { es, docs } = memoryEs(hits);
    const app = buildServer(loadConfig({}), { es, search: { now: () => fixedNow } });
    const res = await app.inject({
      method: "POST",
      url: "/api/schedule",
      payload: { answers: { topics: ["security"], experience: "beginner", goals: [] } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ScheduleResponse;
    // A (best score) wins over overlapping B; C fits.
    expect(body.items.map((i) => i.talk.id)).toEqual(["a", "c"]);
    expect(body.droppedTalkIds).toEqual(["b"]);
    expect(spans.some((s) => s.name === "schedule.build")).toBe(true);

    const saved = docs.get("attendee-stub-1") as Record<string, unknown>;
    expect(saved.talk_ids).toEqual(["a", "c"]);
    expect(saved.updated_at).toBe(fixedNow.toISOString());
    expect(saved.expires_at).toBe("2026-11-11T07:00:00.000Z");

    const get = await app.inject({ method: "GET", url: "/api/schedule" });
    expect((get.json() as ScheduleResponse).items.map((i) => i.talk.id).sort()).toEqual(["a", "c"]);
  });

  it("saves explicit talkIds in priority order and reports unknown and conflicting ids", async () => {
    const { es, docs } = memoryEs([esHit(A, 1), esHit(B, 1), esHit(C, 1)]);
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "POST", url: "/api/schedule", payload: { talkIds: ["b", "a", "c", "nope"] } });
    const body = res.json() as ScheduleResponse;
    expect(body.items.map((i) => i.talk.id)).toEqual(["b", "c"]);
    expect(body.droppedTalkIds).toEqual(["nope", "a"]);
    expect((docs.get("attendee-stub-1") as { talk_ids: string[] }).talk_ids).toEqual(["b", "c"]);
  });

  it("keys schedules per injected attendee without exposing the id in spans", async () => {
    const { es, docs } = memoryEs([esHit(A, 1)]);
    const app = buildServer(loadConfig({}), { es, search: { resolveAttendee: () => "zed-42" } });
    await app.inject({ method: "POST", url: "/api/schedule", payload: { talkIds: ["a"] } });
    await app.inject({ method: "GET", url: "/api/schedule" });
    expect(docs.has("zed-42")).toBe(true);
    expect(JSON.stringify(spans)).not.toContain("zed-42");
  });

  it("does not trust an unsigned Bearer stub.<id> header (no IDOR on other attendees' schedules)", async () => {
    const { es, docs } = memoryEs([esHit(A, 1)]);
    docs.set("victim-7", { talk_ids: ["a"], updated_at: fixedNow.toISOString(), expires_at: "2099-01-01T00:00:00.000Z" });
    const app = buildServer(loadConfig({}), { es });
    const headers = { authorization: "Bearer stub.victim-7" };
    const get = await app.inject({ method: "GET", url: "/api/schedule", headers });
    expect((get.json() as ScheduleResponse).items).toEqual([]);
    await app.inject({ method: "POST", url: "/api/schedule", headers, payload: { talkIds: ["a"] } });
    expect(docs.has("attendee-stub-1")).toBe(true);
    expect((docs.get("victim-7") as { updated_at: string }).updated_at).toBe(fixedNow.toISOString());
    expect(defaultResolveAttendee({ headers } as FastifyRequest)).toBe(STUB_ATTENDEE_ID);
  });

  it("ignores expired schedules on load and serves unexpired ones", async () => {
    const { es, docs } = memoryEs([esHit(A, 1)]);
    const app = buildServer(loadConfig({}), { es, search: { now: () => fixedNow } });
    const doc = (expires_at: string) => ({ talk_ids: ["a"], updated_at: "2026-11-09T00:00:00.000Z", expires_at });
    docs.set("attendee-stub-1", doc("2026-11-10T06:59:59.000Z"));
    const expired = await app.inject({ method: "GET", url: "/api/schedule" });
    expect(expired.json()).toEqual({ items: [], updatedAt: new Date(0).toISOString() });
    docs.set("attendee-stub-1", doc("2026-11-10T07:00:01.000Z"));
    const live = await app.inject({ method: "GET", url: "/api/schedule" });
    expect((live.json() as ScheduleResponse).items.map((i) => i.talk.id)).toEqual(["a"]);
  });

  it("wraps GET /api/schedule load and talk fetch in attribute-free spans", async () => {
    const { es } = memoryEs([esHit(A, 1)]);
    const app = buildServer(loadConfig({}), { es, search: { now: () => fixedNow } });
    await app.inject({ method: "POST", url: "/api/schedule", payload: { talkIds: ["a"] } });
    spans.length = 0;
    await app.inject({ method: "GET", url: "/api/schedule" });
    expect(spans.map((s) => s.name)).toEqual(["schedule.load", "talks.fetch"]);
    expect(spans.every((s) => Object.keys(s.attrs).length === 0)).toBe(true);
    expect(JSON.stringify(spans)).not.toContain("attendee-stub-1");
  });

  it("returns an empty schedule when nothing was saved", async () => {
    const { es } = memoryEs([]);
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "GET", url: "/api/schedule" });
    expect((res.json() as ScheduleResponse).items).toEqual([]);
  });

  it("validates the body", async () => {
    const { es } = memoryEs([]);
    const app = buildServer(loadConfig({}), { es });
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/api/schedule", payload: payload as object });
    expect((await post({})).statusCode).toBe(400);
    expect((await post({ talkIds: [1] })).statusCode).toBe(400);
    expect((await post({ talkIds: ["a"], maxTalks: 0 })).statusCode).toBe(400);
    expect((await post({ answers: { topics: 3 } })).statusCode).toBe(400);
  });
});
