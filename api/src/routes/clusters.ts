import { createHash, timingSafeEqual } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MIN_CLUSTER_SIZE, routes, type InterestClusterNode, type InterestClustersResponse } from "@cc/shared";
import type { EsClient } from "../es/client.js";
import { RUN_ID_PREFIX, RUN_MARKER_ID } from "../clusters/job.js";

export const ORGANIZER_KEY_HEADER = "x-organizer-key";
const MAX_CLUSTERS = 50;

export interface ClusterRouteDeps {
  es: EsClient;
  /**
   * Shared secret organizers send in `x-organizer-key`. Defaults to the
   * ORGANIZER_KEY env var (from a Kubernetes Secret). If unset, the route is
   * open outside production (local demo) and refuses requests in production.
   */
  organizerKey?: string;
  nodeEnv?: string;
}

interface Hit<T> {
  _source: T;
}
interface SearchBody<T> {
  hits: { hits: Hit<T>[] };
}
interface ClusterDoc {
  cluster_id: string;
  run_id: string;
  label: string;
  size: number;
  top_interests?: string[];
  computed_at: string;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

function keyMatches(expected: string, given: unknown): boolean {
  if (typeof given !== "string") return false;
  return timingSafeEqual(digest(expected), digest(given));
}

/** Latest completed run: newest marker, then that run's clusters. Never returns a cluster under the minimum. */
export async function loadLatestClusters(es: EsClient): Promise<InterestClustersResponse> {
  const marker = await es.request<SearchBody<ClusterDoc>>("POST", "/interest_clusters/_search", {
    size: 1,
    sort: [{ computed_at: "desc" }],
    // Only this job's markers: the aggregate route's docs share the index but have
    // run_id "aggregate-..." and cluster_id "topic:...".
    query: { bool: { filter: [{ term: { cluster_id: RUN_MARKER_ID } }, { prefix: { run_id: RUN_ID_PREFIX } }] } },
    _source: ["run_id", "size", "computed_at", "cluster_id", "label"],
  });
  const latest = marker.body.hits.hits[0]?._source;
  if (!latest) return { runId: null, computedAt: null, clusters: [], suppressed: 0, minClusterSize: MIN_CLUSTER_SIZE };

  const docs = await es.request<SearchBody<ClusterDoc>>("POST", "/interest_clusters/_search", {
    size: MAX_CLUSTERS,
    query: {
      bool: { filter: [{ term: { run_id: latest.run_id } }], must_not: [{ term: { cluster_id: RUN_MARKER_ID } }] },
    },
    _source: ["cluster_id", "run_id", "label", "size", "top_interests", "computed_at"], // centroids stay server-side
  });
  const clusters: InterestClusterNode[] = docs.body.hits.hits
    .map((h) => h._source)
    .filter((c) => c.size >= MIN_CLUSTER_SIZE)
    .sort((a, b) => b.size - a.size)
    .map((c) => ({
      id: c.cluster_id,
      label: c.label,
      size: c.size,
      topInterests: c.top_interests ?? [],
      other: c.cluster_id === "other",
    }));
  return {
    runId: latest.run_id,
    computedAt: latest.computed_at,
    clusters,
    suppressed: latest.size,
    minClusterSize: MIN_CLUSTER_SIZE,
  };
}

/** GET /api/interests/clusters, in its own plugin scope. */
export function registerClusterRoutes(root: FastifyInstance, deps: ClusterRouteDeps): void {
  root.register(async (app) => {
    const organizerKey = deps.organizerKey ?? (process.env.ORGANIZER_KEY || undefined);
    const nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV;

    function authorize(req: FastifyRequest, reply: FastifyReply): boolean {
      if (organizerKey === undefined) {
        if (nodeEnv === "production") {
          reply.code(503).send({ error: "organizer_key_not_configured" });
          return false;
        }
        return true;
      }
      if (!keyMatches(organizerKey, req.headers[ORGANIZER_KEY_HEADER])) {
        reply.code(401).send({ error: "unauthorized", message: "organizer key required" });
        return false;
      }
      return true;
    }

    app.get(routes.interestsClusters.path, async (req, reply) =>
      trace.getTracer("companion-api").startActiveSpan("interests.clusters", async (span) => {
        let status = 500;
        try {
          if (!authorize(req, reply)) {
            status = reply.statusCode;
            return reply;
          }
          const body = await loadLatestClusters(deps.es);
          status = 200;
          return body;
        } catch {
          // ES errors can contain query text; neither recorded nor echoed.
          status = 502;
          return reply.code(502).send({ error: "clusters_unavailable" });
        } finally {
          span.setAttributes({
            "http.request.method": "GET",
            "url.path": routes.interestsClusters.path,
            "http.response.status_code": status,
            "db.system": "elasticsearch",
          });
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR, message: "server_error" });
          span.end();
        }
      }),
    );
  });
}
