import type { FastifyInstance } from "fastify";
import { routes, type InterestAggregateResponse } from "@cc/shared";
import type { Db } from "../db/client.js";
import { aggregateInterests, writeAggregate } from "../interests/aggregate.js";
import { withSpan } from "../telemetry/span.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, limitFor, sendIfRateLimited, type RouteLimit } from "../http/rateLimit.js";

/** Minimum time between writes of the aggregate to `interest_clusters`. */
export const WRITE_INTERVAL_MS = 60_000;
/** The public aggregate is served from memory for this long, so polling cannot load the database. */
export const AGGREGATE_CACHE_MS = 15_000;

export interface InterestRouteDeps {
  db: Db;
  now?: () => Date;
  /** Per-IP limit; defaults to DEFAULT_RATE_LIMITS.interestsAggregate. */
  rateLimit?: RouteLimit;
}

/** GET /api/interests/aggregate: public organizer view, k >= 5 suppressed counts only. */
export function registerInterestRoutes(root: FastifyInstance, deps: InterestRouteDeps): void {
  root.register(async (app) => {
    await applyRateLimit(app);
    const { db } = deps;
    const now = deps.now ?? (() => new Date());
    let lastWrite = -Infinity;
    let cached: { at: number; value: InterestAggregateResponse } | undefined;
    let inflight: Promise<InterestAggregateResponse> | undefined;

    app.setErrorHandler((err: Error, _req, reply) => {
      if (sendIfRateLimited(err, reply)) return reply;
      // Only database calls throw here; driver messages can contain SQL, so none is echoed.
      return reply.code(502).send({ error: "aggregate_unavailable" });
    });

    async function compute(): Promise<InterestAggregateResponse> {
      const at = now();
      const result = await aggregateInterests(db, at);
      // Persist at most once a minute so a public GET cannot flood the table.
      if (at.getTime() - lastWrite >= WRITE_INTERVAL_MS) {
        lastWrite = at.getTime();
        try {
          await writeAggregate(db, result);
        } catch {
          // Best effort: the response does not depend on the stored copy.
        }
      }
      return result;
    }

    const limit = limitFor(deps.rateLimit ?? DEFAULT_RATE_LIMITS.interestsAggregate);
    app.get(routes.interestsAggregate.path, limit, async (_req, reply): Promise<InterestAggregateResponse> =>
      withSpan(
        "interests.aggregate",
        { "db.system": "postgresql", "db.namespace": "attendees", "db.operation.name": "select" },
        async () => {
          // Aggregate counts only (k >= 5 suppressed), identical for every caller: safe to share.
          if (!cached || now().getTime() - cached.at >= AGGREGATE_CACHE_MS) {
            inflight ??= compute().finally(() => {
              inflight = undefined;
            });
            const value = await inflight;
            cached = { at: now().getTime(), value };
          }
          reply.header("cache-control", `public, max-age=${AGGREGATE_CACHE_MS / 1000}`);
          return cached.value;
        },
      ),
    );
  });
}
