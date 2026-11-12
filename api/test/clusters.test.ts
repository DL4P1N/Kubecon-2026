import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { setSpanRunner } from "../src/telemetry/span.js";
import { MIN_CLUSTER_SIZE, type InterestClustersResponse } from "@cc/shared";
import { buildClusters, chooseK, finalize, labelFor, topInterests, type ClusterInput } from "../src/clusters/build.js";
import { seededRandom } from "../src/clusters/kmeans.js";
import { runClusterJob, writeRun } from "../src/clusters/job.js";
import { demoSpecs, seedDemoAttendees } from "../src/clusters/seed.js";
import { vectorLiteral, type Db } from "../src/db/client.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { testDb } from "./pg.js";
import { registerClusterRoutes } from "../src/routes/clusters.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

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

const now = new Date("2026-11-09T12:00:00Z");

async function insertCluster(db: Db, runId: string, clusterId: string, size: number, at: string, label = "L", top: string[] = []) {
  await db.query(
    `insert into interest_clusters (doc_id, cluster_id, run_id, label, size, top_interests, computed_at) values ($1,$2,$3,$4,$5,$6,$7)`,
    [`${runId}:${clusterId}`, clusterId, runId, label, size, top, at],
  );
}
const rowsOf = async (db: Db) => (await db.query<Record<string, unknown>>("select * from interest_clusters order by doc_id")).rows;

describe("cluster job, demo seed and route", () => {
  const spans: { name: string; attrs: Record<string, string | number | boolean> }[] = [];
  let db: Db;
  beforeAll(() => {
    setSpanRunner(async (name, attrs, fn) => {
      const rec = { name, attrs: { ...attrs } };
      spans.push(rec);
      return fn({ setAttribute: (k, v) => void (rec.attrs[k] = v) });
    });
  });
  afterAll(() => setSpanRunner());
  beforeEach(async () => {
    spans.length = 0;
    db = await testDb();
  });
  afterEach(async () => db.close());

  const embedder = new LocalHashEmbedder();

  it("demo seed of 40 synthetic opted-in attendees produces a map, with the off-topic four suppressed", async () => {
    expect(await seedDemoAttendees(db, embedder, now)).toBe(40);
    expect(await seedDemoAttendees(db, embedder, now)).toBe(40); // idempotent
    expect((await db.query("select 1 from attendees")).rows).toHaveLength(40);
    expect(demoSpecs().every((s) => s.id.startsWith("demo-"))).toBe(true);

    const result = await runClusterJob(db, { now: () => now, runId: "run-test-1", pageSize: 15 }); // paged: 3 pages
    expect(result).toMatchObject({ runId: "run-test-1", attendees: 40, skipped: 0 });
    expect(result.shown).toBe(3);
    expect(result.suppressed).toBe(4);

    const written = (await rowsOf(db)).filter((d) => d.cluster_id !== "_run");
    expect(written.length).toBe(result.shown);
    for (const d of written) {
      expect(d.run_id).toBe("run-test-1");
      expect(d.size as number).toBeGreaterThanOrEqual(MIN_CLUSTER_SIZE);
    }
    const marker = (await db.query<{ size: number }>("select size from interest_clusters where doc_id = 'run-test-1:_run'")).rows[0];
    expect(marker?.size).toBe(result.suppressed);
    // Nothing identifying is persisted.
    expect(JSON.stringify(await rowsOf(db))).not.toMatch(/demo-\d\d|Demo attendee/);

    const app = Fastify();
    registerClusterRoutes(app, { db, nodeEnv: "test" });
    const res = await app.inject({ method: "GET", url: "/api/interests/clusters" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as InterestClustersResponse;
    expect(body.runId).toBe("run-test-1");
    expect(body.minClusterSize).toBe(5);
    expect(body.clusters.length).toBe(result.shown);
    expect(body.clusters.every((c) => c.size >= 5)).toBe(true);
    expect(body.clusters.map((c) => c.size)).toEqual([...body.clusters.map((c) => c.size)].sort((a, b) => b - a));
    expect(body.suppressed).toBe(result.suppressed);
    expect(JSON.stringify(body)).not.toContain("centroid");
    await app.close();
  });

  it("stores 384-dim centroids server-side", async () => {
    await seedDemoAttendees(db, embedder, now);
    await runClusterJob(db, { now: () => now, runId: "run-test-c" });
    const r = await db.query<{ n: number }>("select vector_dims(centroid) as n from interest_clusters where centroid is not null");
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => x.n === 384)).toBe(true);
  });

  it("reads only unexpired, opted-in attendees with a vector", async () => {
    const insert = (id: string, consent: boolean, expires: string, vec: boolean) =>
      db.query(
        `insert into attendees (id, display_name, interests, interest_vector, consent_cluster_map, consent_qr_checkin, created_at, expires_at)
         values ($1,'x',array['kubernetes'],$2::vector,$3,false,$4,$5)`,
        [id, vec ? vectorLiteral(new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : i / 1e4))) : null, consent, now.toISOString(), expires],
      );
    for (let i = 0; i < 6; i++) await insert(`in-${i}`, true, "2026-11-10T00:00:00Z", true);
    for (let i = 0; i < 3; i++) await insert(`out-${i}`, false, "2026-11-10T00:00:00Z", true);
    await insert("expired", true, "2026-11-09T11:00:00Z", true);
    await insert("no-vector", true, "2026-11-10T00:00:00Z", false);
    const result = await runClusterJob(db, { now: () => now, runId: "run-test-2" });
    expect(result.attendees).toBe(6);
    expect(result.skipped).toBe(0);
  });

  it("emits a clusters.run span with counts only", async () => {
    await seedDemoAttendees(db, embedder, now);
    await runClusterJob(db, { now: () => now, runId: "run-test-3" });
    const span = spans.find((s) => s.name === "clusters.run");
    expect(span).toBeDefined();
    const keys = Object.keys(span!.attrs).sort();
    expect(keys).toEqual(["clusters.attendees", "clusters.k", "clusters.shown", "clusters.suppressed", "db.system"]);
    expect(span!.attrs["clusters.attendees"]).toBe(40);
    expect(JSON.stringify(span!.attrs)).not.toMatch(/demo-|run-test|interests/);
  });

  it("route: empty before the first run, key-gated, fail-closed in production without a key, 502 on db failure", async () => {
    const open = Fastify();
    registerClusterRoutes(open, { db, nodeEnv: "test" });
    expect((await open.inject({ url: "/api/interests/clusters" })).json()).toMatchObject({ runId: null, clusters: [] });

    const gated = Fastify();
    registerClusterRoutes(gated, { db, organizerKey: "s3cret-key", nodeEnv: "production" });
    expect((await gated.inject({ url: "/api/interests/clusters" })).statusCode).toBe(401);
    expect((await gated.inject({ url: "/api/interests/clusters", headers: { "x-organizer-key": "wrong" } })).statusCode).toBe(401);
    expect((await gated.inject({ url: "/api/interests/clusters", headers: { "x-organizer-key": "s3cret-key" } })).statusCode).toBe(200);

    const prodNoKey = Fastify();
    registerClusterRoutes(prodNoKey, { db, nodeEnv: "production" });
    // (organizerKey falls back to env; the test environment does not set ORGANIZER_KEY)
    expect((await prodNoKey.inject({ url: "/api/interests/clusters" })).statusCode).toBe(503);
    expect((await prodNoKey.inject({ url: "/api/interests/clusters" })).json()).toEqual({ error: "organizer_key_not_configured" });

    const broken = Fastify();
    const failing = { ...db, query: async () => { throw new Error("boom select secret"); } } as Db;
    registerClusterRoutes(broken, { db: failing, nodeEnv: "test" });
    const r = await broken.inject({ url: "/api/interests/clusters" });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "clusters_unavailable" });
    expect(r.body).not.toContain("boom");
    await Promise.all([open, gated, prodNoKey, broken].map((a) => a.close()));
  });

  it("route never returns a stored cluster under the minimum", async () => {
    const at = now.toISOString();
    await insertCluster(db, "run-r", "_run", 0, at);
    await insertCluster(db, "run-r", "c1", 8, at, "Big");
    await insertCluster(db, "run-r", "c2", 3, at, "Tiny");
    const app = Fastify();
    registerClusterRoutes(app, { db, nodeEnv: "test" });
    const body = (await app.inject({ url: "/api/interests/clusters" })).json() as InterestClustersResponse;
    expect(body.clusters.map((c) => c.id)).toEqual(["c1"]);
    await app.close();
  });

  it("readers never see a half-written run: a failed write rolls back and the previous run stays served", async () => {
    const at = "2026-11-09T11:00:00Z";
    await insertCluster(db, "run-old", "_run", 1, at);
    await insertCluster(db, "run-old", "c1", 9, at, "Old");
    // A run whose write fails midway (duplicate doc_id from an earlier partial write) leaves no rows.
    await insertCluster(db, "run-new", "c2", 7, now.toISOString(), "Collides");
    await db.query("delete from interest_clusters where doc_id = 'run-new:c2'");
    const mk = (clusterId: string) => ({ clusterId, label: clusterId, size: 6, topInterests: [], other: false, centroid: new Array(384).fill(0) });
    const boom = { clusters: [mk("c1"), mk("c1")], suppressed: 0, attendees: 12, k: 2 }; // same doc_id twice: 2nd insert fails
    await expect(writeRun(db, "run-new", boom, now)).rejects.toBeTruthy();
    expect((await db.query("select 1 from interest_clusters where run_id = 'run-new'")).rows).toHaveLength(0);

    let t = 0;
    const app = Fastify();
    registerClusterRoutes(app, { db, nodeEnv: "test", now: () => (t += 60_000) }); // each read bypasses the response cache
    expect(((await app.inject({ url: "/api/interests/clusters" })).json() as InterestClustersResponse).runId).toBe("run-old");

    // A successful run switches the readers over to it in one step.
    await writeRun(db, "run-new", { clusters: [mk("c1")], suppressed: 2, attendees: 8, k: 1 }, now);
    const after = (await app.inject({ url: "/api/interests/clusters" })).json() as InterestClustersResponse;
    expect(after.runId).toBe("run-new");
    expect(after.suppressed).toBe(2);
    expect(after.clusters.map((c) => c.id)).toEqual(["c1"]);
    await app.close();
  });

  it("writeRun suppresses clusters under the minimum even if the caller passes them", async () => {
    const run = { clusters: [{ clusterId: "tiny", label: "T", size: 3, topInterests: [], other: false }], suppressed: 0, attendees: 3, k: 1 };
    await writeRun(db, "run-tiny", run, now);
    const rows = await rowsOf(db);
    expect(rows.map((r) => r.cluster_id)).toEqual(["_run"]);
    expect(rows[0]!.size).toBe(3);
  });
});

describe("coexisting with the aggregate route's rows in interest_clusters", () => {
  let db: Db;
  beforeEach(async () => (db = await testDb()));
  afterEach(async () => db.close());
  const aggregateDocs = async (at: string) => {
    await insertCluster(db, `aggregate-${at}`, "topic:kubernetes", 30, at, "kubernetes", ["kubernetes"]);
    await db.query("update interest_clusters set doc_id = 'aggregate:kubernetes' where cluster_id = 'topic:kubernetes'");
    await insertCluster(db, `aggregate-${at}`, "_run", 99, at, "lookalike");
  };

  it("the route ignores aggregate rows, even newer ones, and reads only the k-means run", async () => {
    await insertCluster(db, "run-1", "_run", 2, "2026-11-09T11:00:00Z");
    await insertCluster(db, "run-1", "c1", 9, "2026-11-09T11:00:00Z", "Kubernetes", ["kubernetes"]);
    await aggregateDocs("2026-11-09T12:00:00Z"); // newer than the k-means run
    const app = Fastify();
    registerClusterRoutes(app, { db, nodeEnv: "test" });
    const body = (await app.inject({ url: "/api/interests/clusters" })).json() as InterestClustersResponse;
    expect(body.runId).toBe("run-1");
    expect(body.suppressed).toBe(2);
    expect(body.clusters.map((c) => c.id)).toEqual(["c1"]);
    await app.close();
  });

  it("the job prunes only its own runs older than 24h and leaves aggregate rows and recent runs alone", async () => {
    await aggregateDocs("2026-11-01T00:00:00Z"); // older than 24h
    await insertCluster(db, "run-ancient", "c1", 9, "2026-11-01T00:00:00Z");
    await insertCluster(db, "run-recent", "c1", 9, "2026-11-09T06:00:00Z");
    await runClusterJob(db, { now: () => now, runId: "run-test-9" });
    const ids = (await rowsOf(db)).map((r) => r.doc_id);
    expect(ids).toContain("aggregate:kubernetes");
    expect(ids).toContain("run-recent:c1");
    expect(ids).toContain("run-test-9:_run");
    expect(ids).not.toContain("run-ancient:c1");
  });
});

it("buildServer registers GET /api/interests/clusters", async () => {
  const db = await testDb();
  const app = buildServer(loadConfig({}), { db, embedder: new LocalHashEmbedder() });
  const res = await app.inject({ method: "GET", url: "/api/interests/clusters" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({ runId: null, clusters: [], minClusterSize: 5 });
  await app.close();
  await db.close();
});
