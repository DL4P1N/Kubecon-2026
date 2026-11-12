import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { SuggestResponse } from "@cc/shared";
import { suggestRoutes, SUGGEST_CACHE_MS } from "../src/routes/suggest.js";
import { MAX_SUGGESTIONS } from "../src/suggest/suggest.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { failingDb, mk, recordingDb, seededDb } from "./search-fixtures.js";

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => { spans.length = 0; });

const CATALOG = [
  mk("k", 9, 10, { title: "Kubernetes Security Deep Dive", speaker: "Ada Lovelace" }),
  mk("o", 9, 10, { title: "Observability with OpenTelemetry", speaker: "Grace Hopper" }),
  mk("l", 10, 11, { title: "Scaling Prometheus", speaker: "Ada Lovelace" }),
];

async function setup(talks = CATALOG, rateLimitPerMinute = 5) {
  const state = { clock: 1_000_000 };
  const db = recordingDb(await seededDb(talks));
  const app = Fastify();
  app.register(suggestRoutes, { db, now: () => state.clock, rateLimitPerMinute });
  const get = (q: string) => app.inject({ method: "GET", url: `/api/suggest?q=${encodeURIComponent(q)}` });
  return { db, state, get, app };
}
const texts = (r: { json(): unknown }) => (r.json() as SuggestResponse).suggestions.map((s) => `${s.kind}:${s.text}`);

describe("GET /api/suggest", () => {
  it("completes a prefix with the title", async () => {
    expect(texts(await (await setup()).get("kuber"))).toEqual(["title:Kubernetes Security Deep Dive"]);
  });
  it("completes the last, unfinished word of a longer phrase", async () => {
    expect(texts(await (await setup()).get("scaling prom"))).toEqual(["title:Scaling Prometheus"]);
  });
  it("forgives misspelled whole words (kuberentes, opentelementry)", async () => {
    const { get } = await setup();
    expect(texts(await get("kuberentes"))).toEqual(["title:Kubernetes Security Deep Dive"]);
    expect(texts(await get("opentelementry"))).toEqual(["title:Observability with OpenTelemetry"]);
  });
  it("suggests a speaker once, even when they have several talks", async () => {
    expect(texts(await (await setup()).get("lovelac"))).toEqual([
      "title:Kubernetes Security Deep Dive", "speaker:Ada Lovelace", "title:Scaling Prometheus",
    ]);
  });
  it("treats SQL wildcards and quotes in the typed text as plain text", async () => {
    const { get } = await setup(CATALOG, 100);
    for (const q of ["%%", "_ _", "a'b", "\\\\", "k%"]) expect((await get(q)).statusCode).toBe(200);
    expect(texts(await get("%%"))).toEqual([]);
  });
  it("caps the list", async () => {
    const many = Array.from({ length: 12 }, (_, i) => mk(`t${i}`, 9, 10, { title: `Kubernetes ${i}`, speaker: `Person ${i}` }));
    const { get } = await setup(many);
    expect(((await get("kube")).json() as SuggestResponse).suggestions).toHaveLength(MAX_SUGGESTIONS);
  });
  it("answers short queries without touching the database, and rejects oversized ones", async () => {
    const { get, db } = await setup();
    expect((await get("k")).json()).toEqual({ suggestions: [] });
    expect((await get("   ")).json()).toEqual({ suggestions: [] });
    expect(db.statements).toHaveLength(0);
    expect((await get("x".repeat(101))).statusCode).toBe(400);
  });
  it("rejects a repeated q parameter", async () => {
    const { db, app } = await setup();
    const res = await app.inject({ method: "GET", url: "/api/suggest?q=ab&q=cd" });
    expect(res.statusCode).toBe(400);
    expect(db.statements).toHaveLength(0);
  });
  it("is cached for 30 s, case- and space-insensitively, with a public cache header", async () => {
    const { get, db, state } = await setup();
    const first = await get("Kube");
    expect(first.headers["cache-control"]).toBe("public, max-age=30");
    await get("  kube ");
    expect(db.statements).toHaveLength(1);
    state.clock += SUGGEST_CACHE_MS + 1;
    await get("kube");
    expect(db.statements).toHaveLength(2);
  });
  it("is rate limited per client (cached hits count)", async () => {
    const { get } = await setup(CATALOG, 4);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await get("kube")).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 429]);
  });
  it("maps an unreachable database to 503 + Retry-After and other failures to 502", async () => {
    const run = async (err: { code: string; message: string }) => {
      const app = Fastify();
      app.register(suggestRoutes, { db: failingDb(err) });
      return app.inject({ method: "GET", url: "/api/suggest?q=kube" });
    };
    const down = await run({ code: "ECONNREFUSED", message: "secret kube" });
    expect(down.statusCode).toBe(503);
    expect(down.headers["retry-after"]).toBe("5");
    expect(down.body).not.toContain("secret");
    expect((await run({ code: "42P01", message: "relation" })).statusCode).toBe(502);
  });
  it("never puts the typed text on a span", async () => {
    await (await setup()).get("secret query");
    const span = spans.find((s) => s.name === "search.suggest")!;
    expect(JSON.stringify(span)).not.toContain("secret");
    expect(span.attrs).toEqual({ "http.request.method": "GET", "http.route": "/api/suggest" });
    expect(span.set["http.response.status_code"]).toBe(200);
  });
});
