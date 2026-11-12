import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { RelatedTalksResponse, TalkDetailResponse } from "@cc/shared";
import { talkRoutes, TALKS_CACHE_MS } from "../src/routes/talks.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { failingDb, mk, recordingDb, seededDb } from "./search-fixtures.js";

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => { spans.length = 0; });

const SRC = mk("src", 9, 10, { room: "Hall A", tags: ["security", "k8s"], title: "Securing images", abstract: "Sign them." });
// Related talks may be at ANY time, even the same room.
const REL1 = mk("rel1", 14, 15, { room: "Hall A", tags: ["security"], title: "Securing images in production", abstract: "Sign them." });
const REL2 = mk("rel2", 9, 10, { room: "Hall B", tags: [], title: "Dashboards", abstract: "Graphs." });

async function setup() {
  const state = { clock: 1_000_000 };
  const db = recordingDb(await seededDb([SRC, REL1, REL2]));
  const app = Fastify();
  app.register(talkRoutes, { db, now: () => state.clock, rateLimitPerMinute: 4 });
  const get = (url: string) => app.inject({ method: "GET", url });
  const similarity = () => db.statements.filter((s) => s.includes("<=>"));
  return { get, db, state, similarity };
}

describe("GET /api/talks/:id", () => {
  it("returns the talk publicly, cached, with an allowlisted span", async () => {
    const { get } = await setup();
    const res = await get("/api/talks/src");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
    expect((res.json() as TalkDetailResponse).talk).toMatchObject({ id: "src", title: "Securing images", room: "Hall A", speaker: "Someone", start: SRC.start });
    const span = spans.find((s) => s.name === "talks.detail")!;
    expect(span.attrs).toEqual({ "http.request.method": "GET", "http.route": "/api/talks/:id" });
    expect(span.set).toEqual({ "http.response.status_code": 200 });
  });
  it("404s an unknown talk and 400s a malformed id", async () => {
    const { get } = await setup();
    expect((await get("/api/talks/nope")).statusCode).toBe(404);
    expect((await get("/api/talks/bad%20id")).statusCode).toBe(400);
  });
  it("caches for 60 s", async () => {
    const { get, db, state } = await setup();
    await get("/api/talks/src");
    await get("/api/talks/src");
    expect(db.statements).toHaveLength(1);
    state.clock += TALKS_CACHE_MS + 1;
    await get("/api/talks/src");
    expect(db.statements).toHaveLength(2);
  });
});

describe("GET /api/talks/:id/related", () => {
  it("returns related talks at any time (including the same room) with shared tags, most similar first", async () => {
    const { get } = await setup();
    const res = await get("/api/talks/src/related");
    expect(res.statusCode).toBe(200);
    const body = res.json() as RelatedTalksResponse;
    expect(body.talkId).toBe("src");
    expect(body.related.map((r) => r.talk.id)).toEqual(["rel1", "rel2"]);
    expect(body.related[0]).toMatchObject({ sharedTags: ["security"] });
    expect(body.related[0]!.score).toBeGreaterThan(body.related[1]!.score);
    expect(body.related[1]!.sharedTags).toEqual([]);
    expect(spans.find((s) => s.name === "talks.related")!.set).toEqual({ "http.response.status_code": 200, "search.hits": 2 });
  });
  it("never returns the talk itself, honours size and validates it", async () => {
    const { get } = await setup();
    const body = (await get("/api/talks/src/related?size=1")).json() as RelatedTalksResponse;
    expect(body.related.map((r) => r.talk.id)).toEqual(["rel1"]);
    for (const q of ["size=0", "size=11", "size=x"]) expect((await get(`/api/talks/src/related?${q}`)).statusCode, q).toBe(400);
  });
  it("404s unknown talks without a similarity search, caches, and maps an unreachable database to 503", async () => {
    const a = await setup();
    expect((await a.get("/api/talks/nope/related")).statusCode).toBe(404);
    expect(a.similarity()).toHaveLength(0);
    const b = await setup();
    await b.get("/api/talks/src/related");
    await b.get("/api/talks/src/related");
    expect(b.similarity()).toHaveLength(1);
    const app = Fastify();
    app.register(talkRoutes, { db: failingDb({ code: "ECONNREFUSED", message: "secret" }) });
    const res = await app.inject({ method: "GET", url: "/api/talks/src/related" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("5");
    expect(res.body).not.toContain("secret");
  });
  it("rate limits each talk route per client (cached hits still count)", async () => {
    const { get } = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await get("/api/talks/src/related")).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 429]);
    const limited = await get("/api/talks/src/related");
    expect(limited.statusCode).toBe(429);
    // One 429 body in every scope (see docs/security.md), not a route-specific shape.
    expect(limited.json()).toEqual({ statusCode: 429, error: "rate_limited", message: expect.stringContaining("too many requests") });
    expect(limited.headers["retry-after"]).toBeDefined();
    expect((await get("/api/talks/src")).statusCode).toBe(200); // other routes keep their own budget
  });
});
