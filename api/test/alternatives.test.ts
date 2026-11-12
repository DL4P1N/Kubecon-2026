import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { AlternativesResponse, RelatedTalksResponse } from "@cc/shared";
import type { Db } from "../src/db/client.js";
import type { CatalogTalk } from "../src/db/talks.js";
import { loadConfig } from "../src/config.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { buildServer } from "../src/server.js";
import { talkRoutes as alternativesRoutes, ALTERNATIVES_CACHE_MS } from "../src/routes/talks.js";
import { sharedTags } from "../src/talks/alternatives.js";
import { createStatusTracker, type StatusTracker } from "../src/status/tracker.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { mk, recordingDb, seededDb } from "./search-fixtures.js";

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => { spans.length = 0; });

const SRC = mk("src", 9, 10, { room: "Hall A", tags: ["security", "supply-chain", "k8s"], title: "Securing the supply chain", abstract: "Sign and verify images." });
const ALT1 = mk("alt1", 9, 10, { room: "Hall B", tags: ["security", "sigstore"], title: "Sign and verify images with sigstore", abstract: "Securing the supply chain of container images." });
const ALT2 = mk("alt2", 9, 11, { room: "Hall C", tags: ["observability"], title: "Dashboards and alerting", abstract: "Graphs for operators." });
const SAME_ROOM = mk("same", 9, 10, { room: "Hall A", title: "Securing the supply chain again", abstract: "Sign and verify images." });
const OTHER_TIME = mk("later", 14, 15, { room: "Hall B", tags: ["security"], title: "Securing the supply chain, later", abstract: "Sign and verify images." });
const WORKSHOP = mk("ws", 9, 10, { room: "Hall D", track: "Contribfest", title: "Securing the supply chain workshop", abstract: "Sign and verify images." });
const ADJACENT = mk("adj", 10, 11, { room: "Hall B", title: "Securing the supply chain next door", abstract: "Sign and verify images." });
const ALL = [SRC, ALT1, ALT2, SAME_ROOM, OTHER_TIME, WORKSHOP, ADJACENT];

async function setup(opts: { talks?: CatalogTalk[]; tracker?: StatusTracker; failSimilarity?: { code: string } } = {}) {
  const state = { clock: 1_000_000 };
  const real = recordingDb(await seededDb(opts.talks ?? ALL));
  const db: Db & { statements: string[] } = opts.failSimilarity
    ? Object.assign({}, real, {
        async query(text: string, params?: readonly unknown[]) {
          if (text.includes("<=>")) throw Object.assign(new Error("boom secret"), { code: opts.failSimilarity!.code });
          return real.query(text, params);
        },
      } as Partial<Db>) as Db & { statements: string[] }
    : real;
  const app = Fastify();
  app.register(alternativesRoutes, { db, now: () => state.clock, rateLimitPerMinute: 5, tracker: opts.tracker });
  const get = (url: string) => app.inject({ method: "GET", url });
  const similarityQueries = () => real.statements.filter((s) => s.includes("<=>"));
  return { app, db: real, state, get, similarityQueries };
}

describe("sharedTags", () => {
  it("lists the tags the candidate shares with the original, in the candidate's order", () => {
    const a = { ...SRC, level: undefined };
    expect(sharedTags(a, ALT1)).toEqual(["security"]);
    expect(sharedTags(a, ALT2)).toEqual([]);
  });
});

describe("GET /api/talks/:id/alternatives", () => {
  it("is public and returns overlapping talks in other rooms, most similar first, with the window and shared tags", async () => {
    const { get } = await setup();
    const res = await get("/api/talks/src/alternatives");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    const body = res.json() as AlternativesResponse;
    expect(body.talkId).toBe("src");
    expect(body.window).toEqual({ start: SRC.start, end: SRC.end });
    // Same room, other time, the workshop track, the talk itself and a talk that merely starts when src ends are all excluded.
    expect(body.alternatives.map((a) => a.talk.id)).toEqual(["alt1", "alt2"]);
    expect(body.alternatives[0]).toMatchObject({ sharedTags: ["security"] });
    expect(body.alternatives[0]!.score).toBeGreaterThan(body.alternatives[1]!.score);
    const span = spans.find((s) => s.name === "talks.alternatives")!;
    expect(span.attrs).toEqual({ "http.request.method": "GET", "http.route": "/api/talks/:id/alternatives" });
    expect(span.set).toEqual({ "http.response.status_code": 200, "search.hits": 2 });
  });

  it("honours size and validates id and size", async () => {
    const { get } = await setup();
    const one = (await get("/api/talks/src/alternatives?size=1")).json() as AlternativesResponse;
    expect(one.alternatives.map((a) => a.talk.id)).toEqual(["alt1"]);
    for (const url of ["/api/talks/src/alternatives?size=0", "/api/talks/src/alternatives?size=11", "/api/talks/src/alternatives?size=x", "/api/talks/bad%20id/alternatives"]) {
      expect((await get(url)).statusCode, url).toBe(400);
    }
  });

  it("404s for an unknown talk without running a similarity search", async () => {
    const { get, similarityQueries } = await setup();
    const res = await get("/api/talks/nope/alternatives");
    expect(res.statusCode).toBe(404);
    expect(similarityQueries()).toHaveLength(0);
    expect(spans.find((s) => s.name === "talks.alternatives")!.set["http.response.status_code"]).toBe(404);
  });

  it("caches for 60 seconds per talk and size, then refreshes", async () => {
    const { get, state, similarityQueries } = await setup();
    await get("/api/talks/src/alternatives");
    await get("/api/talks/src/alternatives");
    expect(similarityQueries()).toHaveLength(1);
    await get("/api/talks/src/alternatives?size=2");
    expect(similarityQueries()).toHaveLength(2);
    state.clock += ALTERNATIVES_CACHE_MS + 1;
    await get("/api/talks/src/alternatives");
    expect(similarityQueries()).toHaveLength(3);
  });

  it("rate limits per client (even cached responses)", async () => {
    const { get } = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await get("/api/talks/src/alternatives")).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  it("maps an unreachable database to 503 + Retry-After and other failures to 502, without echoing driver messages", async () => {
    const down = await setup({ failSimilarity: { code: "ECONNREFUSED" } });
    const r1 = await down.get("/api/talks/src/alternatives");
    expect(r1.statusCode).toBe(503);
    expect(r1.headers["retry-after"]).toBe("5");
    expect(r1.json()).toEqual({ error: "search_overloaded" });
    const broken = await setup({ failSimilarity: { code: "42883" } });
    const r2 = await broken.get("/api/talks/src/alternatives");
    expect(r2.statusCode).toBe(502);
    expect(r2.body).not.toContain("boom");
  });

  it("returns an empty list when the talk has no start/end", async () => {
    const { get, similarityQueries } = await setup({ talks: [{ ...SRC, start: undefined as unknown as string, end: undefined as unknown as string }, ALT1] });
    const res = await get("/api/talks/src/alternatives");
    expect(res.statusCode).toBe(200);
    expect((res.json() as AlternativesResponse).alternatives).toEqual([]);
    expect(similarityQueries()).toHaveLength(0);
  });

  it("keeps hits when the talk has an empty room", async () => {
    const { get } = await setup({ talks: [{ ...SRC, room: "" }, { ...ALT1, room: "" }] });
    const body = (await get("/api/talks/src/alternatives")).json() as AlternativesResponse;
    expect(body.alternatives.map((a) => a.talk.id)).toEqual(["alt1"]);
  });

  it("reports similarity searches to the status tracker (ok and overloaded) without content", async () => {
    const calls: unknown[][] = [];
    const tracker = { ...createStatusTracker(), recordSearch: (...a: unknown[]) => void calls.push(a) } as StatusTracker;
    await (await setup({ tracker })).get("/api/talks/src/alternatives");
    await (await setup({ tracker, failSimilarity: { code: "ECONNREFUSED" } })).get("/api/talks/src/alternatives");
    expect(calls.map((c) => [c[0], c[2]])).toEqual([["hybrid", "ok"], ["hybrid", "overloaded"]]);
  });

  it("does not count an unknown talk (404, no search ran) as a hybrid search", async () => {
    const calls: unknown[][] = [];
    const tracker = { ...createStatusTracker(), recordSearch: (...a: unknown[]) => void calls.push(a) } as StatusTracker;
    expect((await (await setup({ tracker })).get("/api/talks/nope/alternatives")).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("GET /api/talks/:id/related and /api/talks/:id", () => {
  it("related: similar talks at any time, excluding itself and non-session tracks, most similar first", async () => {
    const { get } = await setup();
    const body = (await get("/api/talks/src/related?size=10")).json() as RelatedTalksResponse;
    const got = body.related.map((r) => r.talk.id);
    expect(got).not.toContain("src");
    expect(got).not.toContain("ws");
    expect(got).toEqual(expect.arrayContaining(["alt1", "alt2", "same", "later", "adj"]));
    expect(got[0]).not.toBe("alt2");
    const scores = body.related.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(body.related.find((r) => r.talk.id === "alt1")!.sharedTags).toEqual(["security"]);
  });

  it("detail: returns one talk with ISO times, 404 for unknown", async () => {
    const { get } = await setup();
    const res = await get("/api/talks/src");
    expect(res.json()).toMatchObject({ talk: { id: "src", start: SRC.start, end: SRC.end, tags: SRC.tags, level: "intermediate" } });
    expect((await get("/api/talks/nope")).statusCode).toBe(404);
  });
});

it("is registered on the real server, without any attendee token", async () => {
  const db = await seededDb(ALL);
  const app = buildServer(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), { db, embedder: new LocalHashEmbedder() });
  const res = await app.inject({ method: "GET", url: "/api/talks/src/alternatives" });
  expect(res.statusCode).toBe(200);
  expect((res.json() as AlternativesResponse).alternatives.map((a) => a.talk.id)).toEqual(["alt1", "alt2"]);
});
