import { afterEach, describe, expect, it } from "vitest";
import type { InterestAggregateResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { buildTopicCounts, splitBuckets } from "../src/interests/aggregate.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import { fakeEs, type FakeHandler } from "./helpers.js";

describe("k >= 5 suppression", () => {
  const buckets = [
    { key: "kubernetes", doc_count: 12 },
    { key: "observability", doc_count: 5 },
    { key: "wasm", doc_count: 4 },
    { key: "ebpf", doc_count: 1 },
  ];

  it("never returns a bucket under 5 individually", () => {
    const { kept, small } = splitBuckets(buckets);
    expect(small).toEqual(["wasm", "ebpf"]);
    const topics = buildTopicCounts(kept, 5);
    expect(topics).toEqual([
      { topic: "kubernetes", count: 12 },
      { topic: "observability", count: 5 },
      { topic: "other", count: 5 },
    ]);
    expect(topics.every((t) => t.count >= 5)).toBe(true);
    expect(topics.map((t) => t.topic)).not.toContain("wasm");
    expect(topics.map((t) => t.topic)).not.toContain("ebpf");
  });

  it("drops the other bucket when it is itself under 5", () => {
    const { kept } = splitBuckets(buckets);
    expect(buildTopicCounts(kept, 4).map((t) => t.topic)).toEqual(["kubernetes", "observability"]);
  });

  it("does not let a real topic named other bypass the merge", () => {
    expect(splitBuckets([{ key: "other", doc_count: 9 }]).kept).toEqual([]);
  });
});

const spans: { name: string; attrs: Record<string, unknown>; set: Record<string, unknown> }[] = [];
setSpanRunner(async (name, attrs, fn) => {
  const rec = { name, attrs, set: {} as Record<string, unknown> };
  spans.push(rec);
  return fn({ setAttribute: (k, v) => void (rec.set[k] = v) });
});
afterEach(() => {
  spans.length = 0;
});

function aggEs(total: number, buckets: { key: string; doc_count: number }[], otherCount: number) {
  const handler: FakeHandler = (call) => {
    if (call.path === "/attendees/_search") {
      return { body: { hits: { total: { value: total }, hits: [] }, aggregations: { topics: { buckets } } } };
    }
    if (call.path === "/attendees/_count") return { body: { count: otherCount } };
    return undefined;
  };
  const es = fakeEs(handler);
  const bulked: object[][] = [];
  es.bulk = async (lines) => {
    bulked.push(lines);
    return { errors: false, items: [] };
  };
  return { es, bulked };
}

describe("GET /api/interests/aggregate", () => {
  it("aggregates opted-in interests, suppresses small groups and stores the result", async () => {
    const { es, bulked } = aggEs(
      20,
      [
        { key: "kubernetes", doc_count: 14 },
        { key: "security", doc_count: 7 },
        { key: "wasm", doc_count: 3 },
        { key: "ebpf", doc_count: 2 },
      ],
      5,
    );
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "GET", url: "/api/interests/aggregate" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as InterestAggregateResponse;
    expect(body.topics).toEqual([
      { topic: "kubernetes", count: 14 },
      { topic: "security", count: 7 },
      { topic: "other", count: 5 },
    ]);
    expect(body.totalOptedIn).toBe(20);
    expect(body.suppressedBelow).toBe(5);

    const search = es.calls[0]!;
    expect(JSON.stringify(search.body)).toContain('"consent.cluster_map":true');
    expect(search.body).toMatchObject({ size: 0, aggs: { topics: { terms: { field: "interests" } } } });
    expect(JSON.stringify(es.calls[1]!.body)).toContain('"interests":["wasm","ebpf"]');

    expect(spans.map((s) => s.name)).toEqual(["interests.aggregate"]);
    const allowed = new Set(["db.system", "db.namespace", "db.operation.name"]);
    expect(Object.keys({ ...spans[0]!.attrs, ...spans[0]!.set }).every((k) => allowed.has(k))).toBe(true);

    expect(bulked).toHaveLength(1);
    expect(bulked[0]![1]).toMatchObject({ label: "kubernetes", size: 14, top_interests: ["kubernetes"] });
    expect(JSON.stringify(bulked)).not.toMatch(/attendee/);
  });

  it("drops a small other group and hides a total under 5", async () => {
    const { es } = aggEs(3, [{ key: "wasm", doc_count: 3 }], 3);
    const app = buildServer(loadConfig({}), { es });
    const body = (await app.inject({ method: "GET", url: "/api/interests/aggregate" })).json() as InterestAggregateResponse;
    expect(body.topics).toEqual([]);
    expect(body.totalOptedIn).toBe(0);
  });

  it("returns 502 when Elasticsearch fails", async () => {
    const es = fakeEs(() => ({ status: 503, body: {} }));
    const app = buildServer(loadConfig({}), { es });
    const res = await app.inject({ method: "GET", url: "/api/interests/aggregate" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "aggregate_unavailable" });
  });
});
