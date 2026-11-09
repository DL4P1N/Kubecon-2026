import { randomBytes } from "node:crypto";
import type { EsClient } from "../es/client.js";
import { withSpan } from "../telemetry/span.js";
import { buildClusters, finalize, type BuildOptions, type ClusterInput, type ClusterRun } from "./build.js";

/**
 * Module 4 batch job (`npm run clusters`, run by the K8s CronJob).
 *
 * 1. Scroll through attendees with an unexpired
 *    record and an interest_vector.
 * 2. Run k-means IN NODE (this process), not in Elasticsearch.
 * 3. Pool clusters under 5 members into "other" (suppressed if still under 5).
 * 4. Write the clusters to `interest_clusters` tagged with a run_id. A run
 *    marker document is written last, so readers only ever see complete runs.
 *
 * Only aggregates are written or emitted: no attendee IDs, names or per-person
 * data leave the read phase, and the span carries counts only.
 */

export const RUN_MARKER_ID = "_run";
/** run_id prefix of k-means runs; the aggregate route uses "aggregate-" in the same index. */
export const RUN_ID_PREFIX = "run-";
const SCROLL_KEEPALIVE = "1m";
const PAGE_SIZE = 500;
/** Superseded cluster runs are pruned after 24h (aggregate run history, not attendee data). */
const RUN_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface ClusterJobOptions extends BuildOptions {
  now?: () => Date;
  runId?: string;
  pageSize?: number;
  /** Vector size to expect; defaults to the size of the first vector seen. */
  dims?: number;
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

interface AttendeeHit {
  _source?: { interests?: unknown; interest_vector?: unknown };
}
interface ScrollPage {
  _scroll_id?: string;
  hits: { hits: AttendeeHit[] };
}

export function newRunId(now: Date): string {
  return `${RUN_ID_PREFIX}${now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
}

/** Opted-in, unexpired attendees (via scroll). Yields vectors and interests only, never IDs. */
export async function loadOptedInAttendees(
  es: EsClient,
  now: Date,
  pageSize = PAGE_SIZE,
  dims?: number,
): Promise<{ inputs: ClusterInput[]; skipped: number }> {
  const inputs: ClusterInput[] = [];
  let skipped = 0;
  let expectedDims = dims;
  let scrollId: string | undefined;
  try {
    let page = (
      await es.request<ScrollPage>("POST", `/attendees/_search?scroll=${SCROLL_KEEPALIVE}`, {
        size: pageSize,
        sort: ["_doc"],
        _source: ["interests", "interest_vector"],
        query: {
          bool: {
            filter: [
              { range: { expires_at: { gt: now.toISOString() } } },
              { exists: { field: "interest_vector" } },
            ],
          },
        },
      })
    ).body;
    for (;;) {
      scrollId = page._scroll_id ?? scrollId;
      const hits = page.hits.hits;
      if (hits.length === 0) break;
      for (const h of hits) {
        const v = h._source?.interest_vector;
        const interests = h._source?.interests;
        const valid =
          Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x));
        if (!valid || (expectedDims !== undefined && v.length !== expectedDims)) {
          skipped++;
          continue;
        }
        expectedDims ??= v.length;
        inputs.push({
          vector: v as number[],
          interests: Array.isArray(interests) ? interests.filter((i): i is string => typeof i === "string") : [],
        });
      }
      if (!scrollId) break;
      page = (await es.request<ScrollPage>("POST", "/_search/scroll", { scroll: SCROLL_KEEPALIVE, scroll_id: scrollId })).body;
    }
  } finally {
    if (scrollId) await es.request("DELETE", "/_search/scroll", { scroll_id: scrollId }, [404]).catch(() => undefined);
  }
  return { inputs, skipped };
}

/** Writes clusters, then the run marker (size = suppressed count), then prunes old runs. */
export async function writeRun(es: EsClient, runId: string, run: ClusterRun, computedAt: Date): Promise<void> {
  const safe = finalize(run); // never persist a cluster under the minimum
  const at = computedAt.toISOString();
  const lines: object[] = [];
  for (const c of safe.clusters) {
    lines.push(
      { index: { _index: "interest_clusters", _id: `${runId}:${c.clusterId}` } },
      {
        cluster_id: c.clusterId,
        run_id: runId,
        label: c.label,
        size: c.size,
        top_interests: c.topInterests,
        ...(c.centroid ? { centroid: c.centroid } : {}),
        computed_at: at,
      },
    );
  }
  if (lines.length > 0) {
    const res = await es.bulk(lines);
    if (res.errors) throw new Error("bulk write of interest_clusters failed");
  }
  // Marker last: it is what makes the run "complete" for readers.
  await es.request("PUT", `/interest_clusters/_doc/${encodeURIComponent(`${runId}:${RUN_MARKER_ID}`)}`, {
    cluster_id: RUN_MARKER_ID,
    run_id: runId,
    label: "run marker",
    size: safe.suppressed,
    top_interests: [],
    computed_at: at,
  });
  await es.request("POST", "/interest_clusters/_refresh");
  await es
    .request("POST", "/interest_clusters/_delete_by_query?conflicts=proceed", {
      // Scoped to this job's own runs: the same index also holds the aggregate topic docs
      // (run_id "aggregate-...") written by GET /api/interests/aggregate.
      query: {
        bool: {
          filter: [
            { prefix: { run_id: RUN_ID_PREFIX } },
            { range: { computed_at: { lt: new Date(computedAt.getTime() - RUN_RETENTION_MS).toISOString() } } },
          ],
        },
      },
    })
    .catch(() => undefined); // pruning is best effort
}

export async function runClusterJob(es: EsClient, opts: ClusterJobOptions = {}): Promise<ClusterJobResult> {
  const now = (opts.now ?? (() => new Date()))();
  const runId = opts.runId ?? newRunId(now);
  // Tracing seam (telemetry/span.ts), like retention.run; the SDK wiring is task #12.
  return withSpan("clusters.run", { "db.system": "elasticsearch" }, async (span) => {
    const { inputs, skipped } = await loadOptedInAttendees(es, now, opts.pageSize, opts.dims);
    const run = buildClusters(inputs, opts);
    await writeRun(es, runId, run, now);
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
