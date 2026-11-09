import type { FastifyInstance } from "fastify";
import { routes, type CatalogTopicsResponse } from "@cc/shared";
import type { EsClient } from "../es/client.js";
import { withSpan } from "../telemetry/span.js";

interface TopicAggregation {
  timed_out?: boolean;
  _shards?: { failed: number };
  aggregations?: { topics: { buckets: { key: string }[] } };
}

/** Public read of catalog metadata only; never queries attendee interests. */
export function registerCatalogRoutes(app: FastifyInstance, es: EsClient): void {
  app.get(routes.catalogTopics.path, async (_request, reply): Promise<CatalogTopicsResponse | void> => {
    try {
      return await withSpan("catalog.topics", {
        "db.system": "elasticsearch", "db.namespace": "talks", "db.operation.name": "search",
      }, async () => {
        const { body } = await es.request<TopicAggregation>("POST", "/talks/_search", {
          size: 0,
          aggs: { topics: { terms: { field: "tags", size: 1000, order: { _key: "asc" } } } },
        });
        if (body.timed_out || body._shards?.failed || !body.aggregations?.topics?.buckets) {
          throw new Error("Catalog unavailable");
        }
        return { topics: [...new Set(body.aggregations.topics.buckets.map(({ key }) => key)
          .filter((key) => typeof key === "string" && key.trim().length > 0))].sort() };
      });
    } catch {
      // ES error bodies can echo data; expose only a stable error code.
      return reply.code(503).send({ error: "catalog_unavailable" });
    }
  });
}
