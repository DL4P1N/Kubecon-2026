import { createHash, timingSafeEqual } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MIN_CLUSTER_SIZE, routes, type InterestClusterNode, type InterestClustersResponse } from "@cc/shared";
import type { Db } from "../db/client.js";
import { RUN_ID_PREFIX, RUN_MARKER_ID } from "../clusters/job.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, limitFor, type RouteLimit } from "../http/rateLimit.js";

export const ORGANIZER_KEY_HEADER = "x-organizer-key";
const MAX_CLUSTERS = 50;
/** Clusters change only when the batch job runs; serve from memory for this long. */
export const CLUSTERS_CACHE_MS = 15_000;

export interface ClusterRouteDeps {
  db: Db;
  /**
   * Shared secret organizers send in `x-organizer-key`. Defaults to the
   * ORGANIZER_KEY env var (from a Kubernetes Secret). If unset, the route is
   * open outside production (local demo) and refuses requests in production.
   */
  organizerKey?: string;
  nodeEnv?: string;
  /** Per-IP limit; defaults to DEFAULT_RATE_LIMITS.interestsClusters. */
  rateLimit?: RouteLimit;
  now?: () => number;
}

interface ClusterRow {
  cluster_id: string;
  run_id: string;
  label: string | null;
  size: number;
  top_interests: string[] | null;
  computed_at: Date | string;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

const digest = (s: string) => createHash("sha256").update(s).digest();

export function keyMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  return timingSafeEqual(digest(expected), digest(given));
}

/**
 * Organizer-key check shared by the organizer-only routes. With no key set the route is open
 * outside production (local demo) and does not exist (404) in production, so anonymous calls cannot
 * degrade the status page; otherwise a missing or wrong `x-organizer-key` is a 401. In production a
 * key shorter than 32 characters is refused at startup. Returns false after sending the reply.
 */
export function organizerAuthorizer(deps: { organizerKey: string | undefined; nodeEnv: string | undefined }) {
  if (deps.nodeEnv === "production" && deps.organizerKey !== undefined && deps.organizerKey.length < 32) {
    throw new Error("ORGANIZER_KEY must be at least 32 characters in production");
  }
  return (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (deps.organizerKey === undefined) {
      if (deps.nodeEnv === "production") {
        reply.code(404).send({ error: "not_found", message: "route not found" });
        return false;
      }
      return true;
    }
    if (!keyMatches(deps.organizerKey, req.headers[ORGANIZER_KEY_HEADER])) {
      reply.code(401).send({ error: "unauthorized", message: "organizer key required" });
      return false;
    }
    return true;
  };
}

/** Latest completed run: newest marker, then that run's clusters. Never returns a cluster under the minimum. */
export async function loadLatestClusters(db: Db): Promise<InterestClustersResponse> {
  // Only this job's markers: the aggregate route's rows share the table but have
  // run_id "aggregate-..." and cluster_id "topic:...". A run is complete once its marker exists
  // (the job writes rows and marker in one transaction).
  const marker = await db.query<ClusterRow>(
    `select cluster_id, run_id, label, size, top_interests, computed_at
       from interest_clusters
      where cluster_id = $1 and starts_with(run_id, $2)
      order by computed_at desc, run_id desc
      limit 1`,
    [RUN_MARKER_ID, RUN_ID_PREFIX],
  );
  const latest = marker.rows[0];
  if (!latest) return { runId: null, computedAt: null, clusters: [], suppressed: 0, minClusterSize: MIN_CLUSTER_SIZE };

  // Centroids stay server-side: never selected.
  const docs = await db.query<ClusterRow>(
    `select cluster_id, run_id, label, size, top_interests, computed_at
       from interest_clusters
      where run_id = $1 and cluster_id <> $2 and size >= $3
      order by size desc, cluster_id
      limit $4`,
    [latest.run_id, RUN_MARKER_ID, MIN_CLUSTER_SIZE, MAX_CLUSTERS],
  );
  const clusters: InterestClusterNode[] = docs.rows.map((c) => ({
    id: c.cluster_id,
    label: c.label ?? "",
    size: c.size,
    topInterests: c.top_interests ?? [],
    other: c.cluster_id === "other",
  }));
  return {
    runId: latest.run_id,
    computedAt: iso(latest.computed_at),
    clusters,
    suppressed: latest.size,
    minClusterSize: MIN_CLUSTER_SIZE,
  };
}

/** GET /api/interests/clusters, in its own plugin scope. */
export function registerClusterRoutes(root: FastifyInstance, deps: ClusterRouteDeps): void {
  root.register(async (app) => {
    await applyRateLimit(app);
    const now = deps.now ?? Date.now;
    let cached: { at: number; value: InterestClustersResponse } | undefined;
    const organizerKey = deps.organizerKey ?? (process.env.ORGANIZER_KEY || undefined);
    const nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV;

    const authorize = organizerAuthorizer({ organizerKey, nodeEnv });

    const limit = limitFor(deps.rateLimit ?? DEFAULT_RATE_LIMITS.interestsClusters);
    app.get(routes.interestsClusters.path, limit, async (req, reply) =>
      trace.getTracer("companion-api").startActiveSpan("interests.clusters", async (span) => {
        let status = 500;
        try {
          if (!authorize(req, reply)) {
            status = reply.statusCode;
            return reply;
          }
          // Checked after authorization, so the cache never serves an unauthorized caller.
          if (!cached || now() - cached.at >= CLUSTERS_CACHE_MS) {
            cached = { at: now(), value: await loadLatestClusters(deps.db) };
          }
          status = 200;
          return cached.value;
        } catch {
          // Driver errors can contain SQL text; neither recorded nor echoed.
          status = 502;
          return reply.code(502).send({ error: "clusters_unavailable" });
        } finally {
          span.setAttributes({
            "http.request.method": "GET",
            "http.route": routes.interestsClusters.path,
            "http.response.status_code": status,
            "db.system": "postgresql",
          });
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR, message: "server_error" });
          span.end();
        }
      }),
    );
  });
}
