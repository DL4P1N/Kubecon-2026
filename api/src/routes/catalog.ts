import type { FastifyInstance } from "fastify";
import { routes, type CatalogTopicsResponse } from "@cc/shared";
import type { EsClient } from "../es/client.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, limitFor, type RouteLimit } from "../http/rateLimit.js";
import { withSpan } from "../telemetry/span.js";

/** Catalog tags only change on reseed; serve them from memory for this long. */
export const CATALOG_CACHE_MS = 30_000;

interface TopicAggregation {
  timed_out?: boolean;
  _shards?: { failed: number };
  aggregations?: { topics: { buckets: { key: string }[] } };
}

export interface CatalogRouteOptions {
  /** Per-IP limit; defaults to DEFAULT_RATE_LIMITS.catalogTopics. */
  rateLimit?: RouteLimit;
  now?: () => number;
}

async function loadTopics(es: EsClient): Promise<CatalogTopicsResponse> {
  const { body } = await es.request<TopicAggregation>("POST", "/talks/_search", {
    size: 0,
    aggs: { topics: { terms: { field: "tags", size: 1000, order: { _key: "asc" } } } },
  });
  if (body.timed_out || body._shards?.failed || !body.aggregations?.topics?.buckets) {
    throw new Error("Catalog unavailable");
  }
  return { topics: [...new Set(body.aggregations.topics.buckets.map(({ key }) => key)
    .filter((key) => typeof key === "string" && key.trim().length > 0))].sort() };
}

/** Public read of catalog metadata only; never queries attendee interests. Own plugin scope (rate limited, cached). */
export function registerCatalogRoutes(root: FastifyInstance, es: EsClient, opts: CatalogRouteOptions = {}): void {
  root.register(async (app) => {
    await applyRateLimit(app);
    const now = opts.now ?? Date.now;
    let cached: { at: number; value: CatalogTopicsResponse } | undefined;
    let inflight: Promise<CatalogTopicsResponse> | undefined;

    const limit = limitFor(opts.rateLimit ?? DEFAULT_RATE_LIMITS.catalogTopics);
    app.get(routes.catalogTopics.path, limit, async (_request, reply): Promise<CatalogTopicsResponse | void> => {
      try {
        return await withSpan("catalog.topics", {
          "db.system": "elasticsearch", "db.namespace": "talks", "db.operation.name": "search",
        }, async () => {
          // Only successful responses are cached, so an ES outage is not pinned for 30 s.
          if (!cached || now() - cached.at >= CATALOG_CACHE_MS) {
            inflight ??= loadTopics(es).finally(() => {
              inflight = undefined;
            });
            const value = await inflight;
            cached = { at: now(), value };
          }
          reply.header("cache-control", `public, max-age=${CATALOG_CACHE_MS / 1000}`);
          return cached.value;
        });
      } catch {
        // ES error bodies can echo data; expose only a stable error code.
        return reply.code(503).send({ error: "catalog_unavailable" });
      }
    });
  });
}
