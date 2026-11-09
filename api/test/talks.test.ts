import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { RelatedTalksResponse, TalkDetailResponse } from "@cc/shared";
import { talkRoutes, TALKS_CACHE_MS } from "../src/routes/talks.js";
import { buildRelatedBody, similarityText, NON_SESSION_TRACKS } from "../src/talks/alternatives.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { esHit, fakeEs, talk, type FakeHandler } from "./helpers.js";

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => { spans.length = 0; });

const SRC = talk("src", 9, 10, { room: "Hall A", tags: ["security", "k8s"], title: "Securing images", abstract: "Sign them." });
// Related talks may be at ANY time, even the same room.
const REL1 = talk("rel1", 14, 15, { room: "Hall A", tags: ["security"] });
const REL2 = talk("rel2", 9, 10, { room: "Hall B", tags: [] });

function setup(opts: { hits?: ReturnType<typeof esHit>[]; searchStatus?: number } = {}) {
  const state = { clock: 1_000_000 };
  const handler: FakeHandler = (call) => {
    if (!call.path.startsWith("/talks/_search")) return undefined;
    const ids = (call.body as { query?: { terms?: { id?: string[] } } }).query?.terms?.id;
    if (ids) return { body: { hits: { hits: ids.includes("src") ? [esHit(SRC, 1)] : [] } } };
    if (opts.searchStatus) return { status: opts.searchStatus, body: { error: { type: "inference_exception" } } };
    return { body: { took: 2, hits: { hits: opts.hits ?? [esHit(REL1, 3), esHit(REL2, 1)] } } };
  };
  const es = fakeEs(handler);
  const app = Fastify();
  app.register(talkRoutes, { es, now: () => state.clock, rateLimitPerMinute: 4 });
  const get = (url: string) => app.inject({ method: "GET", url });
  const semantic = () => es.calls.filter((c) => !(c.body as { query?: { terms?: unknown } }).query?.terms);
  return { get, es, state, semantic };
}

describe("related query shape", () => {
  it("is the same semantic query as alternatives but at any time", () => {
    const body = buildRelatedBody(SRC, 5) as { size: number; query: { bool: Record<string, unknown> } };
    expect(body.size).toBe(5);
    expect(body.query.bool.must).toEqual([{ semantic: { field: "content_semantic", query: similarityText(SRC) } }]);
    expect(body.query.bool.filter).toBeUndefined(); // no time restriction
    expect(body.query.bool.must_not).toEqual([{ term: { id: "src" } }, { terms: { track: [...NON_SESSION_TRACKS] } }]);
  });
});

describe("GET /api/talks/:id", () => {
  it("returns the talk publicly, cached, with an allowlisted span", async () => {
    const { get } = setup();
    const res = await get("/api/talks/src");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect((res.json() as TalkDetailResponse).talk).toMatchObject({ id: "src", title: "Securing images", room: "Hall A" });
    const span = spans.find((s) => s.name === "talks.detail")!;
    expect(span.attrs).toEqual({ "http.request.method": "GET", "url.path": "/api/talks/:id" });
    expect(span.set).toEqual({ "http.response.status_code": 200 });
  });
  it("404s an unknown talk and 400s a malformed id", async () => {
    const { get } = setup();
    expect((await get("/api/talks/nope")).statusCode).toBe(404);
    expect((await get("/api/talks/bad%20id")).statusCode).toBe(400);
  });
  it("caches for 60 s", async () => {
    const { get, es, state } = setup();
    await get("/api/talks/src");
    await get("/api/talks/src");
    expect(es.calls).toHaveLength(1);
    state.clock += TALKS_CACHE_MS + 1;
    await get("/api/talks/src");
    expect(es.calls).toHaveLength(2);
  });
});

describe("GET /api/talks/:id/related", () => {
  it("returns related talks at any time (including the same room) with shared tags", async () => {
    const { get } = setup();
    const res = await get("/api/talks/src/related");
    expect(res.statusCode).toBe(200);
    const body = res.json() as RelatedTalksResponse;
    expect(body.talkId).toBe("src");
    expect(body.related.map((r) => r.talk.id)).toEqual(["rel1", "rel2"]);
    expect(body.related[0]).toMatchObject({ score: 3, sharedTags: ["security"] });
    expect(body.related[1]!.sharedTags).toEqual([]);
    expect(spans.find((s) => s.name === "talks.related")!.set).toEqual({ "http.response.status_code": 200, "search.hits": 2 });
  });
  it("never returns the talk itself even if ES does, honours size and validates it", async () => {
    const { get, es } = setup({ hits: [esHit(SRC, 9), esHit(REL1, 1)] });
    const body = (await get("/api/talks/src/related?size=2")).json() as RelatedTalksResponse;
    expect(body.related.map((r) => r.talk.id)).toEqual(["rel1"]);
    expect((es.calls.at(-1)!.body as { size: number }).size).toBe(2);
    for (const q of ["size=0", "size=11", "size=x"]) expect((await get(`/api/talks/src/related?${q}`)).statusCode, q).toBe(400);
  });
  it("404s unknown talks without a semantic search, caches, and maps ES overload to 503", async () => {
    const a = setup();
    expect((await a.get("/api/talks/nope/related")).statusCode).toBe(404);
    expect(a.es.calls).toHaveLength(1); // only the id lookup
    expect(a.semantic()).toHaveLength(0);
    const b = setup();
    await b.get("/api/talks/src/related");
    await b.get("/api/talks/src/related");
    expect(b.semantic().filter((c) => (c.body as { query?: { bool?: unknown } }).query?.bool)).toHaveLength(1);
    const c = setup({ searchStatus: 429 });
    const res = await c.get("/api/talks/src/related");
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
  });
  it("rate limits each talk route per client (cached hits still count)", async () => {
    const { get } = setup();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await get("/api/talks/src/related")).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 429]);
    expect((await get("/api/talks/src")).statusCode).toBe(200); // other routes keep their own budget
  });
});
