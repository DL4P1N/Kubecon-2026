import type { FastifyInstance } from "fastify";
import { routes, type InterestAggregateResponse } from "@cc/shared";
import { EsError, type EsClient } from "../es/client.js";
import { aggregateInterests, writeAggregate } from "../interests/aggregate.js";
import { withSpan } from "../telemetry/span.js";

/** Minimum time between writes of the aggregate to `interest_clusters`. */
export const WRITE_INTERVAL_MS = 60_000;

export interface InterestRouteDeps {
  es: EsClient;
  now?: () => Date;
}

/** GET /api/interests/aggregate: public organizer view, k >= 5 suppressed counts only. */
export function registerInterestRoutes(root: FastifyInstance, deps: InterestRouteDeps): void {
  root.register(async (app) => {
    const { es } = deps;
    const now = deps.now ?? (() => new Date());
    let lastWrite = -Infinity;

    app.setErrorHandler((err: Error, _req, reply) => {
      if (err instanceof EsError) return reply.code(502).send({ error: "aggregate_unavailable" });
      return reply.code(500).send({ error: "internal_error" });
    });

    app.get(routes.interestsAggregate.path, async (): Promise<InterestAggregateResponse> =>
      withSpan(
        "interests.aggregate",
        { "db.system": "elasticsearch", "db.namespace": "attendees", "db.operation.name": "search" },
        async () => {
          const at = now();
          const result = await aggregateInterests(es, at);
          // Persist at most once a minute so a public GET cannot flood the index.
          if (at.getTime() - lastWrite >= WRITE_INTERVAL_MS) {
            lastWrite = at.getTime();
            try {
              await writeAggregate(es, result);
            } catch {
              // Best effort: the response does not depend on the stored copy.
            }
          }
          return result;
        },
      ),
    );
  });
}
