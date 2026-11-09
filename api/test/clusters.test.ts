import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { setSpanRunner } from "../src/telemetry/span.js";
import { MIN_CLUSTER_SIZE, type InterestClustersResponse } from "@cc/shared";
import { buildClusters, chooseK, finalize, labelFor, topInterests, type ClusterInput } from "../src/clusters/build.js";
import { seededRandom } from "../src/clusters/kmeans.js";
import { runClusterJob } from "../src/clusters/job.js";
import { demoSpecs, seedDemoAttendees } from "../src/clusters/seed.js";
import { createEsClient } from "../src/es/client.js";
import { LocalHashEmbedder } from "../src/es/embeddings.js";
import { registerClusterRoutes } from "../src/routes/clusters.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

type Doc = Record<string, unknown>;

/** In-memory fake of the ES endpoints the job, the seed and the route use. */
function fakeEs() {
  const attendees = new Map<string, Doc>();
  const clusters = new Map<string, Doc>();
  const calls: string[] = [];
  let scrollRest: Doc[] = [];
  let searchBody: Doc | undefined;
  let pageSize = 500;
  const page = (hits: Doc[]) => ({ _scroll_id: "scroll-1", hits: { hits } });

  const fetchImpl = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    const body = init.body ? (String(init.body).includes("\n") ? undefined : JSON.parse(String(init.body))) : undefined;

    if (method === "POST" && u.pathname === "/attendees/_search") {
      searchBody = body;
      pageSize = body.size;
      const all = [...attendees.values()]
        .filter((a) => (a.consent as { cluster_map: boolean }).cluster_map === true && Array.isArray(a.interest_vector))
        .map((a) => ({ _source: { interests: a.interests, interest_vector: a.interest_vector } }));
      scrollRest = all.slice(pageSize);
      return json(page(all.slice(0, pageSize)));
    }
    if (method === "POST" && u.pathname === "/_search/scroll") {
      const next = scrollRest.slice(0, pageSize);
      scrollRest = scrollRest.slice(pageSize);
      return json(page(next));
    }
    if (method === "DELETE" && u.pathname === "/_search/scroll") return json({ succeeded: true });
    if (method === "POST" && u.pathname === "/_bulk") {
      const lines = String(init.body).trim().split("\n").map((l) => JSON.parse(l));
      for (let i = 0; i < lines.length; i += 2) {
        const { _index, _id } = lines[i].index;
        (_index === "attendees" ? attendees : clusters).set(_id, lines[i + 1]);
      }
      return json({ errors: false, items: [] });
    }
    if (method === "PUT" && u.pathname.startsWith("/interest_clusters/_doc/")) {
      clusters.set(decodeURIComponent(u.pathname.split("/").pop()!), JSON.parse(String(init.body)));
      return json({ result: "created" }, 201);
    }
    if (method === "POST" && u.pathname.endsWith("/_refresh")) return json({});
    if (method === "POST" && u.pathname === "/interest_clusters/_delete_by_query") return json({ deleted: 0 });
    if (method === "POST" && u.pathname === "/interest_clusters/_search") {
      const q = JSON.stringify(body.query);
      const docs = [...clusters.values()];
      if (q.includes('"cluster_id":"_run"') && !q.includes("must_not")) {
        const markers = docs.filter((d) => d.cluster_id === "_run").sort((a, b) => String(b.computed_at).localeCompare(String(a.computed_at)));
        return json({ hits: { hits: markers.slice(0, 1).map((d) => ({ _source: d })) } });
      }
      const runId = /"run_id":"([^"]+)"/.exec(q)![1];
      return json({ hits: { hits: docs.filter((d) => d.run_id === runId && d.cluster_id !== "_run").map((d) => ({ _source: d })) } });
    }
    return json({ error: `unhandled ${method} ${u.pathname}` }, 400);
  }) as unknown as typeof fetch;

  return {
    attendees,
    clusters,
    calls,
    get searchBody() {
      return searchBody;
    },
    client: createEsClient({ esUrl: "http://es:9200", esUsername: "", esPassword: "" }, fetchImpl),
  };
}

/** Synthetic vectors: `groups` lists the size of each tight group in 8-D space. */
function groupsOf(sizes: number[], seed = 5): ClusterInput[] {
  const rand = seededRandom(seed);
  const out: ClusterInput[] = [];
  sizes.forEach((size, g) => {
    for (let i = 0; i < size; i++) {
      const vector = new Array<number>(8).fill(0).map((_, d) => (d === g % 8 ? 10 : 0) + (rand() - 0.5) * 0.2);
      out.push({ vector, interests: [`topic-${g}`, `shared-${g % 2}`] });
    }
  });
  return out;
}

describe("cluster building and k-anonymity", () => {
  it("chooses k by size, capped, and 0 below the minimum", () => {
    expect(chooseK(4)).toBe(0);
    expect(chooseK(5)).toBe(1);
    expect(chooseK(40)).toBe(4);
    expect(chooseK(10_000)).toBe(8);
    expect(chooseK(10_000, 5, 3)).toBe(3);
  });

  it("never returns a cluster under 5 members, for many sizes and shapes", () => {
    const rand = seededRandom(99);
    for (let trial = 0; trial < 60; trial++) {
      const groupCount = 1 + Math.floor(rand() * 7);
      const sizes = Array.from({ length: groupCount }, () => 1 + Math.floor(rand() * 14));
      const inputs = groupsOf(sizes, trial + 1);
      const run = buildClusters(inputs, { seed: trial });
      for (const c of run.clusters) expect(c.size).toBeGreaterThanOrEqual(MIN_CLUSTER_SIZE);
      const shown = run.clusters.reduce((s, c) => s + c.size, 0);
      expect(shown + run.suppressed).toBe(inputs.length); // nobody lost or double counted
    }
  });

  it("returns nothing, and suppresses everyone, below 5 attendees", () => {
    const run = buildClusters(groupsOf([4]));
    expect(run.clusters).toEqual([]);
    expect(run.suppressed).toBe(4);
    expect(buildClusters([])).toMatchObject({ clusters: [], suppressed: 0, k: 0 });
  });

  it("pools small clusters into 'other' when the pool reaches 5, else suppresses them", () => {
    // 20 + 3 + 3 + 1: the three small groups pool into 7 -> shown as "other".
    const pooled = buildClusters(groupsOf([20, 3, 3, 1]), { maxK: 8 });
    expect(pooled.clusters.every((c) => c.size >= 5)).toBe(true);
    // 20 + 2 + 1: the pool is 3 -> suppressed, no "other".
    const small = buildClusters(groupsOf([20, 2, 1]));
    expect(small.clusters.some((c) => c.other)).toBe(false);
    expect(small.suppressed).toBeGreaterThanOrEqual(1);
    expect(small.clusters.every((c) => c.size >= 5)).toBe(true);
  });

  it("finalize drops any undersized cluster even if an earlier step let one through", () => {
    const run = finalize({
      clusters: [
        { clusterId: "c1", label: "A", size: 9, topInterests: [], other: false },
        { clusterId: "c2", label: "B", size: 4, topInterests: [], other: false },
      ],
      suppressed: 1,
      attendees: 14,
      k: 2,
    });
    expect(run.clusters.map((c) => c.clusterId)).toEqual(["c1"]);
    expect(run.suppressed).toBe(5);
  });

  it("labels from interests shared by at least 5 members only", () => {
    const members: ClusterInput[] = Array.from({ length: 6 }, (_, i) => ({
      vector: [0],
      interests: i < 2 ? ["kubernetes", "rare-hobby"] : ["kubernetes", "opentelemetry"],
    }));
    const top = topInterests(members);
    expect(top).toEqual(["kubernetes"]); // opentelemetry has 4, rare-hobby 2: both below 5
    expect(labelFor(top)).toBe("Kubernetes");
    expect(labelFor([])).toBe("Mixed interests");
    expect(labelFor(["vector search", "rag", "x"])).toBe("Vector Search + Rag");
  });
});

describe("cluster job, demo seed and route", () => {
  const spans: { name: string; attrs: Record<string, string | number | boolean> }[] = [];
  beforeAll(() => {
    setSpanRunner(async (name, attrs, fn) => {
      const rec = { name, attrs: { ...attrs } };
      spans.push(rec);
      return fn({ setAttribute: (k, v) => void (rec.attrs[k] = v) });
    });
  });
  afterAll(() => setSpanRunner());
  beforeEach(() => void (spans.length = 0));

  const embedder = new LocalHashEmbedder(256);
  const now = new Date("2026-11-09T12:00:00Z");

  it("demo seed of 40 synthetic opted-in attendees produces a map, with the off-topic four suppressed", async () => {
    const es = fakeEs();
    expect(await seedDemoAttendees(es.client, embedder, now)).toBe(40);
    expect(demoSpecs().every((s) => s.id.startsWith("demo-"))).toBe(true);

    const result = await runClusterJob(es.client, { now: () => now, runId: "run-test-1", pageSize: 15, dims: 256 });
    expect(result).toMatchObject({ runId: "run-test-1", attendees: 40, skipped: 0 });
    expect(result.shown).toBe(3);
    expect(result.suppressed).toBe(4);
    expect(es.calls.filter((c) => c === "POST /_search/scroll").length).toBeGreaterThan(1); // paged
    expect(es.calls).toContain("DELETE /_search/scroll");

    const written = [...es.clusters.values()].filter((d) => d.cluster_id !== "_run");
    expect(written.length).toBe(result.shown);
    for (const d of written) {
      expect(d.run_id).toBe("run-test-1");
      expect(d.size as number).toBeGreaterThanOrEqual(MIN_CLUSTER_SIZE);
    }
    // The marker is the last write and carries the suppressed count.
    expect(es.clusters.get("run-test-1:_run")).toMatchObject({ size: result.suppressed });
    // Nothing identifying is persisted.
    expect(JSON.stringify([...es.clusters.values()])).not.toMatch(/demo-\d\d|Demo attendee/);

    const app = Fastify();
    registerClusterRoutes(app, { es: es.client, nodeEnv: "test" });
    const res = await app.inject({ method: "GET", url: "/api/interests/clusters" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as InterestClustersResponse;
    expect(body.runId).toBe("run-test-1");
    expect(body.minClusterSize).toBe(5);
    expect(body.clusters.length).toBe(result.shown);
    expect(body.clusters.every((c) => c.size >= 5)).toBe(true);
    expect(body.suppressed).toBe(result.suppressed);
    expect(JSON.stringify(body)).not.toContain("centroid");
    await app.close();
  });

  it("only requests opted-in, unexpired attendees with a vector, and skips malformed vectors", async () => {
    const es = fakeEs();
    const mk = (id: string, optIn: boolean, vector: unknown): [string, Doc] => [
      id,
      { interests: ["kubernetes"], interest_vector: vector, consent: { cluster_map: optIn } },
    ];
    const entries = [
      ...Array.from({ length: 6 }, (_, i) => mk(`in-${i}`, true, [1, 0, 0, i / 100])),
      mk("out-1", false, [1, 0, 0, 0]),
      mk("bad-dims", true, [1, 0]),
      mk("bad-values", true, [1, "x", 0, 0]),
    ];
    entries.forEach(([id, d]) => es.attendees.set(id, d));
    const result = await runClusterJob(es.client, { now: () => now, runId: "run-test-2" });
    expect(result.attendees).toBe(6);
    expect(result.skipped).toBe(2);
    const filters = JSON.stringify((es.searchBody as { query: unknown }).query);
    expect(filters).toContain('"consent.cluster_map":true');
    expect(filters).toContain("expires_at");
    expect(filters).toContain("interest_vector");
  });

  it("emits a clusters.run span with counts only", async () => {
    const es = fakeEs();
    await seedDemoAttendees(es.client, embedder, now);
    await runClusterJob(es.client, { now: () => now, runId: "run-test-3" });
    const span = spans.find((s) => s.name === "clusters.run");
    expect(span).toBeDefined();
    const keys = Object.keys(span!.attrs).sort();
    expect(keys).toEqual(["clusters.attendees", "clusters.k", "clusters.shown", "clusters.suppressed", "db.system"]);
    expect(span!.attrs["clusters.attendees"]).toBe(40);
    expect(JSON.stringify(span!.attrs)).not.toMatch(/demo-|run-test|interests/);
  });

  it("route: empty before the first run, key-gated, fail-closed in production, 502 on ES failure", async () => {
    const es = fakeEs();
    const open = Fastify();
    registerClusterRoutes(open, { es: es.client, nodeEnv: "test" });
    expect((await open.inject({ url: "/api/interests/clusters" })).json()).toMatchObject({ runId: null, clusters: [] });

    const gated = Fastify();
    registerClusterRoutes(gated, { es: es.client, organizerKey: "s3cret-key", nodeEnv: "production" });
    expect((await gated.inject({ url: "/api/interests/clusters" })).statusCode).toBe(401);
    expect((await gated.inject({ url: "/api/interests/clusters", headers: { "x-organizer-key": "wrong" } })).statusCode).toBe(401);
    expect((await gated.inject({ url: "/api/interests/clusters", headers: { "x-organizer-key": "s3cret-key" } })).statusCode).toBe(200);

    const prodNoKey = Fastify();
    registerClusterRoutes(prodNoKey, { es: es.client, nodeEnv: "production" });
    // (organizerKey falls back to env; the test environment does not set ORGANIZER_KEY)
    expect((await prodNoKey.inject({ url: "/api/interests/clusters" })).statusCode).toBe(503);

    const broken = Fastify();
    const failing = createEsClient({ esUrl: "http://es:9200", esUsername: "", esPassword: "" }, (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch);
    registerClusterRoutes(broken, { es: failing, nodeEnv: "test" });
    const r = await broken.inject({ url: "/api/interests/clusters" });
    expect(r.statusCode).toBe(502);
    expect(r.body).not.toContain("boom");
    await Promise.all([open, gated, prodNoKey, broken].map((a) => a.close()));
  });

  it("route never returns a stored cluster under the minimum", async () => {
    const es = fakeEs();
    es.clusters.set("r:_run", { cluster_id: "_run", run_id: "r", size: 0, computed_at: now.toISOString() });
    es.clusters.set("r:c1", { cluster_id: "c1", run_id: "r", label: "Big", size: 8, top_interests: [], computed_at: now.toISOString() });
    es.clusters.set("r:c2", { cluster_id: "c2", run_id: "r", label: "Tiny", size: 3, top_interests: [], computed_at: now.toISOString() });
    const app = Fastify();
    registerClusterRoutes(app, { es: es.client, nodeEnv: "test" });
    const body = (await app.inject({ url: "/api/interests/clusters" })).json() as InterestClustersResponse;
    expect(body.clusters.map((c) => c.id)).toEqual(["c1"]);
    await app.close();
  });
});

it("buildServer registers GET /api/interests/clusters", async () => {
  const es = fakeEs();
  const app = buildServer(loadConfig({}), { es: es.client });
  const res = await app.inject({ method: "GET", url: "/api/interests/clusters" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ runId: null, clusters: [], minClusterSize: 5 });
  await app.close();
});
