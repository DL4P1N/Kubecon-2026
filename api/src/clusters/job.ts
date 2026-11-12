import { randomBytes } from "node:crypto";
import { parseVector, vectorLiteral, type Db } from "../db/client.js";
import { withSpan } from "../telemetry/span.js";
import { buildClusters, finalize, type BuildOptions, type ClusterInput, type ClusterRun } from "./build.js";

/**
 * Module 4 batch job (`npm run clusters`, run by the K8s CronJob).
 *
 * 1. Page through attendees who opted in to the cluster map, are unexpired
 *    and have an interest_vector.
 * 2. Run k-means IN NODE (this process), not in Elasticsearch.
 * 3. Pool clusters under 5 members into "other" (suppressed if still under 5).
 * 4. Write the clusters to `interest_clusters` tagged with a run_id, with the
 *    run marker row, in ONE transaction: readers find a run through its marker,
 *    so they only ever see complete runs.
 *
 * Only aggregates are written or emitted: no attendee IDs, names or per-person
 * data leave the read phase, and the span carries counts only.
 */

export const RUN_MARKER_ID = "_run";
/** run_id prefix of k-means runs; the aggregate route uses "aggregate-" in the same index. */
export const RUN_ID_PREFIX = "run-";
const PAGE_SIZE = 500;
/** Superseded cluster runs are pruned after 24h (aggregate run history, not attendee data). */
const RUN_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface ClusterJobOptions extends BuildOptions {
  now?: () => Date;
  runId?: string;
  pageSize?: number;
}

export interface ClusterJobResult {
  runId: string;
  /** Counts only. */
  attendees: number;
  skipped: number;
  k: number;
  shown: number;
  suppressed: number;
}

export function newRunId(now: Date): string {
  return `${RUN_ID_PREFIX}${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

/** Opted-in, unexpired attendees, paged by id. Yields vectors and interests only, never IDs. */
export async function loadOptedInAttendees(
  db: Db,
  now: Date,
  pageSize = PAGE_SIZE,
): Promise<{ inputs: ClusterInput[]; skipped: number }> {
  const inputs: ClusterInput[] = [];
  let skipped = 0;
  let after = "";
  for (;;) {
    const { rows } = await db.query<{ id: string; interests: string[] | null; vec: string }>(
      `select id, interests, interest_vector::text as vec
         from attendees
        where consent_cluster_map
          and interest_vector is not null
          and expires_at > $1
          and id > $2
        order by id
        limit $3`,
      [now.toISOString(), after, pageSize],
    );
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;
    for (const r of rows) {
      const v = parseVector(r.vec);
      if (!v || v.length === 0 || !v.every(Number.isFinite)) {
        skipped++;
        continue;
      }
      inputs.push({ vector: v, interests: (r.interests ?? []).filter((i) => typeof i === "string") });
    }
    if (rows.length < pageSize) break;
  }
  return { inputs, skipped };
}

/**
 * Writes the clusters and the run marker (size = suppressed count) in one transaction, then
 * prunes this job's runs older than the retention window. Atomic: a reader that finds the
 * marker finds every cluster row of that run.
 */
export async function writeRun(db: Db, runId: string, run: ClusterRun, computedAt: Date): Promise<void> {
  const safe = finalize(run); // never persist a cluster under the minimum
  const at = computedAt.toISOString();
  await db.transaction(async (tx) => {
    const insert = `insert into interest_clusters (doc_id, cluster_id, run_id, label, size, top_interests, centroid, computed_at)
                    values ($1, $2, $3, $4, $5, $6, $7::vector, $8)`;
    for (const c of safe.clusters) {
      await tx.query(insert, [
        `${runId}:${c.clusterId}`,
        c.clusterId,
        runId,
        c.label,
        c.size,
        c.topInterests,
        c.centroid ? vectorLiteral(c.centroid) : null,
        at,
      ]);
    }
    await tx.query(insert, [`${runId}:${RUN_MARKER_ID}`, RUN_MARKER_ID, runId, "run marker", safe.suppressed, [], null, at]);
    // Scoped to this job's own runs: the same table also holds the aggregate topic rows
    // (run_id "aggregate-...") written by GET /api/interests/aggregate.
    await tx.query(
      `delete from interest_clusters where starts_with(run_id, $1) and run_id <> $2 and computed_at < $3`,
      [RUN_ID_PREFIX, runId, new Date(computedAt.getTime() - RUN_RETENTION_MS).toISOString()],
    );
  });
}

export async function runClusterJob(db: Db, opts: ClusterJobOptions = {}): Promise<ClusterJobResult> {
  const now = (opts.now ?? (() => new Date()))();
  const runId = opts.runId ?? newRunId(now);
  // Tracing seam (telemetry/span.ts), like retention.run; the SDK wiring is task #12.
  return withSpan("clusters.run", { "db.system": "postgresql" }, async (span) => {
    const { inputs, skipped } = await loadOptedInAttendees(db, now, opts.pageSize);
    const run = buildClusters(inputs, opts);
    await writeRun(db, runId, run, now);
    const result: ClusterJobResult = {
      runId,
      attendees: inputs.length,
      skipped,
      k: run.k,
      shown: run.clusters.length,
      suppressed: run.suppressed,
    };
    // Counts only; keys are on the collector allowlist (docs/telemetry-allowlist.md).
    span.setAttribute("clusters.attendees", result.attendees);
    span.setAttribute("clusters.k", result.k);
    span.setAttribute("clusters.shown", result.shown);
    span.setAttribute("clusters.suppressed", result.suppressed);
    return result;
  });
}
