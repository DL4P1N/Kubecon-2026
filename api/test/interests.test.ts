import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InterestAggregateResponse } from "@cc/shared";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { buildTopicCounts, splitBuckets } from "../src/interests/aggregate.js";
import { setSpanRunner } from "../src/telemetry/span.js";
import type { Db } from "../src/db/client.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { testDb } from "./pg.js";

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

const NOW = "2026-11-09T12:00:00.000Z";
let db: Db;
beforeEach(async () => (db = await testDb()));
afterEach(async () => db.close());

/** Inserts `n` attendees holding exactly `interests`. */
let seq = 0;
async function addAttendees(n: number, interests: string[], opts: { consent?: boolean; expires?: string } = {}) {
  for (let i = 0; i < n; i++) {
    await db.query(
      `insert into attendees (id, display_name, interests, consent_cluster_map, consent_qr_checkin, created_at, expires_at)
       values ($1, 'x', $2, $3, false, $4, $5)`,
      [`a-${seq++}`, interests, opts.consent ?? true, NOW, opts.expires ?? "2026-11-10T00:00:00Z"],
    );
  }
}
const server = () => buildServer(loadConfig({}), { db, embedder: new LocalHashEmbedder(), search: { now: () => new Date(NOW) } });
const get = async () => server().inject({ method: "GET", url: "/api/interests/aggregate" });

describe("GET /api/interests/aggregate", () => {
  it("aggregates opted-in interests, suppresses small groups and stores the result", async () => {
    await addAttendees(14, ["kubernetes"]);
    await addAttendees(7, ["security"]);
    await addAttendees(3, ["wasm", "ebpf"]);
    await addAttendees(2, ["ebpf"]);
    // wasm 3 + ebpf 5 would pass k on their own if counted per topic; ebpf is exactly 5 -> kept.
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json() as InterestAggregateResponse;
    expect(body.topics).toEqual([
      { topic: "kubernetes", count: 14 },
      { topic: "security", count: 7 },
      { topic: "ebpf", count: 5 },
    ]);
    expect(body.totalOptedIn).toBe(26);
    expect(body.suppressedBelow).toBe(5);
    expect(body.generatedAt).toBe(NOW);

    expect(spans.map((s) => s.name)).toEqual(["interests.aggregate"]);
    const allowed = new Set(["db.system", "db.namespace", "db.operation.name"]);
    expect(Object.keys({ ...spans[0]!.attrs, ...spans[0]!.set }).every((k) => allowed.has(k))).toBe(true);

    const stored = (await db.query<Record<string, unknown>>("select * from interest_clusters order by doc_id")).rows;
    expect(stored.map((r) => r.doc_id)).toEqual(["aggregate:ebpf", "aggregate:kubernetes", "aggregate:security"]);
    expect(stored.find((r) => r.label === "kubernetes")).toMatchObject({ size: 14, top_interests: ["kubernetes"], run_id: `aggregate-${NOW}` });
    expect(JSON.stringify(stored)).not.toMatch(/attendee|a-\d/);
  });

  it("pools small topics into one 'other' counted by distinct attendees", async () => {
    await addAttendees(9, ["kubernetes"]);
    await addAttendees(3, ["wasm", "ebpf"]); // 3 people, two rare topics: other = 3, not 6
    await addAttendees(2, ["rust"]);
    let body = (await get()).json() as InterestAggregateResponse;
    expect(body.topics).toEqual([
      { topic: "kubernetes", count: 9 },
      { topic: "other", count: 5 },
    ]);
    // below 5 distinct people, other disappears
    await db.query("delete from attendees where interests = array['rust']::text[]");
    body = (await server().inject({ method: "GET", url: "/api/interests/aggregate" })).json() as InterestAggregateResponse;
    expect(body.topics).toEqual([{ topic: "kubernetes", count: 9 }]);
  });

  it("excludes opted-out and expired attendees, and counts a repeated interest once per person", async () => {
    await addAttendees(5, ["kubernetes", "kubernetes"]);
    await addAttendees(4, ["kubernetes"], { consent: false });
    await addAttendees(4, ["kubernetes"], { expires: "2026-11-09T11:59:59Z" });
    const body = (await get()).json() as InterestAggregateResponse;
    expect(body.topics).toEqual([{ topic: "kubernetes", count: 5 }]);
    expect(body.totalOptedIn).toBe(5);
  });

  it("replaces the previous stored aggregate so the table does not grow per request", async () => {
    await addAttendees(6, ["kubernetes"]);
    await db.query(
      `insert into interest_clusters (doc_id, cluster_id, run_id, label, size, top_interests, computed_at) values
       ('aggregate:gone','topic:gone','aggregate-2026-11-01T00:00:00.000Z','gone',9,'{gone}','2026-11-01'),
       ('run-1:c1','c1','run-1','keep',9,'{}','2026-11-01')`,
    );
    await get();
    const ids = (await db.query<{ doc_id: string }>("select doc_id from interest_clusters order by doc_id")).rows.map((r) => r.doc_id);
    expect(ids).toEqual(["aggregate:kubernetes", "run-1:c1"]);
  });

  it("drops a small other group and hides a total under 5", async () => {
    await addAttendees(3, ["wasm"]);
    const body = (await get()).json() as InterestAggregateResponse;
    expect(body.topics).toEqual([]);
    expect(body.totalOptedIn).toBe(0);
  });

  it("returns 502 without leaking driver text when the database fails", async () => {
    const failing = { ...db, query: async () => { throw new Error("select secret failed"); } } as Db;
    const app = buildServer(loadConfig({}), { db: failing, embedder: new LocalHashEmbedder() });
    const res = await app.inject({ method: "GET", url: "/api/interests/aggregate" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "aggregate_unavailable" });
  });
});
