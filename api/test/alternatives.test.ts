import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { AlternativesResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { talkRoutes as alternativesRoutes, ALTERNATIVES_CACHE_MS } from "../src/routes/talks.js";
import { buildAlternativesBody, similarityText, sharedTags, NON_SESSION_TRACKS } from "../src/talks/alternatives.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { esHit, fakeEs, talk, type FakeHandler } from "./helpers.js";

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => { spans.length = 0; });

const SRC = talk("src", 9, 10, { room: "Hall A", tags: ["security", "supply-chain", "k8s"], title: "Securing the supply chain", abstract: "Sign and verify images." });
const ALT1 = talk("alt1", 9, 10, { room: "Hall B", tags: ["security", "sigstore"] });
const ALT2 = talk("alt2", 9, 11, { room: "Hall C", tags: ["observability"] });

function setup(opts: { hits?: ReturnType<typeof esHit>[]; searchStatus?: number; searchError?: string } = {}) {
  const state = { clock: 1_000_000 };
  const handler: FakeHandler = (call) => {
    if (call.path.startsWith("/talks/_search")) {
      const body = call.body as { query?: { terms?: { id?: string[] } } };
      const ids = body.query?.terms?.id;
      if (ids) return { body: { hits: { hits: ids.includes("src") ? [esHit(SRC, 1)] : [] } } }; // talk lookup by id
      if (opts.searchStatus) return { status: opts.searchStatus, body: { error: { type: opts.searchError ?? "boom" } } };
      return { body: { took: 4, hits: { hits: opts.hits ?? [esHit(ALT1, 2.5), esHit(ALT2, 1.2)] } } };
    }
    return undefined;
  };
  const es = fakeEs(handler);
  const app = Fastify();
  app.register(alternativesRoutes, { es, now: () => state.clock, rateLimitPerMinute: 5 });
  const get = (url: string) => app.inject({ method: "GET", url });
  const altSearches = () => es.calls.filter((c) => c.path.startsWith("/talks/_search") && !(c.body as { query?: { terms?: unknown } }).query?.terms);
  return { app, es, state, get, altSearches };
}

describe("query shape", () => {
  it("is a semantic query on the original's title+abstract, filtered to the overlapping window in other rooms, excluding itself and non-sessions", () => {
    const body = buildAlternativesBody(SRC, 3) as { size: number; query: { bool: { must: unknown[]; filter: unknown[]; must_not: unknown[] } } };
    expect(body.size).toBe(3);
    expect(body.query.bool.must).toEqual([{ semantic: { field: "content_semantic", query: similarityText(SRC) } }]);
    expect(similarityText(SRC)).toBe("Securing the supply chain. Sign and verify images.");
    // Overlap: candidate.start < src.end AND candidate.end > src.start
    expect(body.query.bool.filter).toEqual([{ range: { start: { lt: SRC.end } } }, { range: { end: { gt: SRC.start } } }]);
    expect(body.query.bool.must_not).toEqual([
      { term: { id: "src" } },
      { term: { room: "Hall A" } },
      { terms: { track: [...NON_SESSION_TRACKS] } },
    ]);
  });
  it("lists the tags the candidate shares with the original, in the candidate's order", () => {
    expect(sharedTags(SRC, ALT1)).toEqual(["security"]);
    expect(sharedTags(SRC, ALT2)).toEqual([]);
  });
  it("truncates a long abstract in the query text", () => {
    expect(similarityText({ ...SRC, abstract: "x".repeat(5000) }).length).toBeLessThan(700);
  });
});

describe("GET /api/talks/:id/alternatives", () => {
  it("is public and returns ranked alternatives with the window and shared tags, with an allowlisted span", async () => {
    const { get } = setup();
    const res = await get("/api/talks/src/alternatives");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    const body = res.json() as AlternativesResponse;
    expect(body.talkId).toBe("src");
    expect(body.window).toEqual({ start: SRC.start, end: SRC.end });
    expect(body.alternatives.map((a) => a.talk.id)).toEqual(["alt1", "alt2"]);
    expect(body.alternatives[0]).toMatchObject({ score: 2.5, sharedTags: ["security"] });
    const span = spans.find((s) => s.name === "talks.alternatives")!;
    expect(span.attrs).toEqual({ "http.request.method": "GET", "url.path": "/api/talks/:id/alternatives" });
    expect(span.set).toEqual({ "http.response.status_code": 200, "search.hits": 2 });
  });

  it("never returns the talk itself or a same-room talk even if ES does", async () => {
    const { get } = setup({ hits: [esHit(SRC, 9), esHit(talk("same", 9, 10, { room: "Hall A" }), 8), esHit(ALT1, 2)] });
    const body = (await get("/api/talks/src/alternatives?size=5")).json() as AlternativesResponse;
    expect(body.alternatives.map((a) => a.talk.id)).toEqual(["alt1"]);
  });

  it("honours size and validates id and size", async () => {
    const { get, es } = setup();
    await get("/api/talks/src/alternatives?size=2");
    expect((es.calls.at(-1)!.body as { size: number }).size).toBe(2);
    for (const url of ["/api/talks/src/alternatives?size=0", "/api/talks/src/alternatives?size=11", "/api/talks/src/alternatives?size=x", "/api/talks/bad%20id/alternatives"]) {
      expect((await get(url)).statusCode, url).toBe(400);
    }
  });

  it("404s for an unknown talk without running a semantic search", async () => {
    const { get, altSearches } = setup();
    const res = await get("/api/talks/nope/alternatives");
    expect(res.statusCode).toBe(404);
    expect(altSearches()).toHaveLength(0);
    expect(spans.find((s) => s.name === "talks.alternatives")!.set["http.response.status_code"]).toBe(404);
  });

  it("caches for 60 seconds per talk and size, then refreshes", async () => {
    const { get, state, altSearches } = setup();
    await get("/api/talks/src/alternatives");
    await get("/api/talks/src/alternatives");
    expect(altSearches()).toHaveLength(1);
    await get("/api/talks/src/alternatives?size=2");
    expect(altSearches()).toHaveLength(2);
    state.clock += ALTERNATIVES_CACHE_MS + 1;
    await get("/api/talks/src/alternatives");
    expect(altSearches()).toHaveLength(3);
  });

  it("rate limits per client (even cached responses)", async () => {
    const { get } = setup();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await get("/api/talks/src/alternatives")).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);
  });

  it("maps an Elasticsearch overload to 503 + Retry-After and other ES failures to 502, without echoing ES bodies", async () => {
    const overloaded = setup({ searchStatus: 429, searchError: "inference_exception" });
    const r1 = await overloaded.get("/api/talks/src/alternatives");
    expect(r1.statusCode).toBe(503);
    expect(r1.headers["retry-after"]).toBe("5");
    expect(r1.json()).toEqual({ error: "search_overloaded" });
    const broken = setup({ searchStatus: 500 });
    const r2 = await broken.get("/api/talks/src/alternatives");
    expect(r2.statusCode).toBe(502);
    expect(r2.body).not.toContain("boom");
  });
});

it("is registered on the real server, without any attendee token", async () => {
  const handler: FakeHandler = (call) => {
    if (call.path.startsWith("/talks/_search")) {
      const ids = (call.body as { query?: { terms?: { id?: string[] } } }).query?.terms?.id;
      return { body: { hits: { hits: ids ? [esHit(SRC, 1)] : [esHit(ALT1, 2)] } } };
    }
    return undefined;
  };
  const app = buildServer(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), { es: fakeEs(handler) });
  const res = await app.inject({ method: "GET", url: "/api/talks/src/alternatives" });
  expect(res.statusCode).toBe(200);
  expect((res.json() as AlternativesResponse).alternatives.map((a) => a.talk.id)).toEqual(["alt1"]);
});
