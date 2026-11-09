import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import type { SuggestResponse } from "@cc/shared";
import { suggestRoutes, SUGGEST_CACHE_MS } from "../src/routes/suggest.js";
import { buildSuggestBody, MAX_SUGGESTIONS } from "../src/suggest/suggest.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { esHit, fakeEs, talk, type FakeHandler } from "./helpers.js";

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => { spans.length = 0; });

const CATALOG = [
  talk("k", 9, 10, { title: "Kubernetes Security Deep Dive", speaker: "Ada Lovelace" }),
  talk("o", 9, 10, { title: "Observability with OpenTelemetry", speaker: "Grace Hopper" }),
  talk("l", 10, 11, { title: "Scaling Prometheus", speaker: "Ada Lovelace" }),
];

/** Optimal-string-alignment distance: edits where a swap of neighbours counts as one, like ES fuzzy matching. */
function osa(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}
const maxEdits = (w: string) => (w.length >= 6 ? 2 : w.length >= 3 ? 1 : 0); // fuzziness: "AUTO"

/**
 * Stand-in for Elasticsearch that honours the two clauses of the suggest body
 * (the real matching lives in ES; this proves the request carries what is needed).
 */
const fuzzyEs: FakeHandler = (call) => {
  if (!call.path.startsWith("/talks/_search")) return undefined;
  const should = (call.body as { query: { bool: { should: { multi_match: { query: string; type: string; fuzziness?: string } }[] } } }).query.bool.should;
  const hits = CATALOG.filter((t) => {
    const fieldWords = `${t.title} ${t.speaker}`.toLowerCase().split(/\s+/);
    return should.some(({ multi_match: m }) => {
      const typed = m.query.toLowerCase().split(/\s+/);
      return typed.some((w, i) => fieldWords.some((f) => {
        if (m.type === "bool_prefix" && i === typed.length - 1) return f.startsWith(w);
        return m.fuzziness === "AUTO" ? f[0] === w[0] && osa(f, w) <= maxEdits(w) : f === w;
      }));
    });
  });
  return { body: { took: 1, hits: { hits: hits.map((t, i) => esHit(t, 3 - i)) } } };
};

function setup(handler: FakeHandler = fuzzyEs, rateLimitPerMinute = 5) {
  const state = { clock: 1_000_000 };
  const es = fakeEs(handler);
  const app = Fastify();
  app.register(suggestRoutes, { es, now: () => state.clock, rateLimitPerMinute });
  const get = (q: string) => app.inject({ method: "GET", url: `/api/suggest?q=${encodeURIComponent(q)}` });
  return { es, state, get };
}
const texts = (r: { json(): unknown }) => (r.json() as SuggestResponse).suggestions.map((s) => `${s.kind}:${s.text}`);

describe("suggest query body", () => {
  it("combines a bool_prefix completion with a fuzzy whole-word clause over title and speaker", () => {
    const should = (buildSuggestBody("kuber") as { query: { bool: { should: { multi_match: Record<string, unknown> }[]; minimum_should_match: number } } }).query.bool;
    expect(should.minimum_should_match).toBe(1);
    expect(should.should.map((c) => [c.multi_match.type, c.multi_match.fuzziness, c.multi_match.prefix_length])).toEqual([
      ["bool_prefix", "AUTO", 1], ["best_fields", "AUTO", 1],
    ]);
    expect(should.should[0]!.multi_match.fields).toEqual(["title^2", "speaker"]);
  });
});

describe("GET /api/suggest", () => {
  it("completes a prefix with the title", async () => {
    expect(texts(await setup().get("kuber"))).toEqual(["title:Kubernetes Security Deep Dive"]);
  });
  it("forgives misspelled whole words (kuberentes, opentelementry)", async () => {
    const { get } = setup();
    expect(texts(await get("kuberentes"))).toEqual(["title:Kubernetes Security Deep Dive"]);
    expect(texts(await get("opentelementry"))).toEqual(["title:Observability with OpenTelemetry"]);
  });
  it("suggests a speaker once, even when they have several talks", async () => {
    expect(texts(await setup().get("lovelac"))).toEqual([
      "title:Kubernetes Security Deep Dive", "speaker:Ada Lovelace", "title:Scaling Prometheus",
    ]);
  });
  it("caps the list", async () => {
    const many = Array.from({ length: 12 }, (_, i) => talk(`t${i}`, 9, 10, { title: `Kubernetes ${i}`, speaker: `Person ${i}` }));
    const { get } = setup(() => ({ body: { hits: { hits: many.map((t) => esHit(t, 1)) } } }));
    expect(((await get("kube")).json() as SuggestResponse).suggestions).toHaveLength(MAX_SUGGESTIONS);
  });
  it("answers short queries without calling Elasticsearch, and rejects oversized ones", async () => {
    const { get, es } = setup();
    expect((await get("k")).json()).toEqual({ suggestions: [] });
    expect((await get("   ")).json()).toEqual({ suggestions: [] });
    expect(es.calls).toHaveLength(0);
    expect((await get("x".repeat(101))).statusCode).toBe(400);
  });
  it("rejects a repeated q parameter", async () => {
    const { es } = setup();
    const app = Fastify();
    app.register(suggestRoutes, { es });
    const res = await app.inject({ method: "GET", url: "/api/suggest?q=ab&q=cd" });
    expect(res.statusCode).toBe(400);
    expect(es.calls).toHaveLength(0);
  });
  it("is cached for 30 s, case- and space-insensitively, with a public cache header", async () => {
    const { get, es, state } = setup();
    const first = await get("Kube");
    expect(first.headers["cache-control"]).toBe("public, max-age=30");
    await get("  kube ");
    expect(es.calls).toHaveLength(1);
    state.clock += SUGGEST_CACHE_MS + 1;
    await get("kube");
    expect(es.calls).toHaveLength(2);
  });
  it("is rate limited per client (cached hits count)", async () => {
    const { get } = setup(fuzzyEs, 4);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await get("kube")).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 429]);
  });
  it("maps Elasticsearch overload to 503 + Retry-After and other failures to 502", async () => {
    const overloaded = await setup(() => ({ status: 429, body: { error: { type: "inference_exception" } } })).get("kube");
    expect(overloaded.statusCode).toBe(503);
    expect(overloaded.headers["retry-after"]).toBe("5");
    expect((await setup(() => ({ status: 500, body: {} })).get("kube")).statusCode).toBe(502);
  });
  it("never puts the typed text on a span", async () => {
    await setup().get("secret query");
    const span = spans.find((s) => s.name === "search.suggest")!;
    expect(JSON.stringify(span)).not.toContain("secret");
    expect(span.attrs).toEqual({ "http.request.method": "GET", "url.path": "/api/suggest" });
    expect(span.set["http.response.status_code"]).toBe(200);
  });
});
