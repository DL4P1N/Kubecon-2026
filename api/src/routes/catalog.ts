import type { FastifyInstance } from "fastify";
import { routes, type CatalogTopicsResponse } from "@cc/shared";
import type { Db } from "../db/client.js";
import { runQuery } from "../search/errors.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, limitFor, type RouteLimit } from "../http/rateLimit.js";
import { withSpan } from "../telemetry/span.js";

/** Catalog tags only change on reseed; serve them from memory for this long. */
export const CATALOG_CACHE_MS = 30_000;

export interface CatalogRouteOptions {
  /** Per-IP limit; defaults to DEFAULT_RATE_LIMITS.catalogTopics. */
  rateLimit?: RouteLimit;
  now?: () => number;
}

/** Most tags returned, as before. `collate "C"` keeps the order identical to a plain string sort. */
export const MAX_TOPICS = 1000;

async function loadTopics(db: Db): Promise<CatalogTopicsResponse> {
  const rows = await runQuery<{ tag: string }>(
    db,
    `select distinct tag collate "C" as tag from talks, unnest(tags) as tag where btrim(tag) <> '' order by 1 limit ${MAX_TOPICS}`,
  );
  return { topics: [...new Set(rows.map(({ tag }) => tag).filter((tag) => typeof tag === "string" && tag.trim().length > 0))].sort() };
}

/** Public read of catalog metadata only; never queries attendee interests. Own plugin scope (rate limited, cached). */
export function registerCatalogRoutes(root: FastifyInstance, db: Db, opts: CatalogRouteOptions = {}): void {
  root.register(async (app) => {
    await applyRateLimit(app);
    const now = opts.now ?? Date.now;
    let cached: { at: number; value: CatalogTopicsResponse } | undefined;
    let inflight: Promise<CatalogTopicsResponse> | undefined;

    const limit = limitFor(opts.rateLimit ?? DEFAULT_RATE_LIMITS.catalogTopics);
    app.get(routes.catalogTopics.path, limit, async (_request, reply): Promise<CatalogTopicsResponse | void> => {
      try {
        return await withSpan("catalog.topics", {
          "db.system": "postgresql", "db.namespace": "talks", "db.operation.name": "select",
        }, async () => {
          // Only successful responses are cached, so a database outage is not pinned for 30 s.
          if (!cached || now() - cached.at >= CATALOG_CACHE_MS) {
            inflight ??= loadTopics(db).finally(() => {
              inflight = undefined;
            });
            const value = await inflight;
            cached = { at: now(), value };
          }
          reply.header("cache-control", `public, max-age=${CATALOG_CACHE_MS / 1000}`);
          return cached.value;
        });
      } catch {
        // Driver errors can echo data; expose only a stable error code.
        return reply.code(503).send({ error: "catalog_unavailable" });
      }
    });
  });
}
