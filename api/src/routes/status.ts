import type { FastifyInstance } from "fastify";
import { routes, type ServiceState, type StatusResponse } from "@cc/shared";
import type { Db } from "../db/client.js";
import { runQuery } from "../search/errors.js";
import { WINDOW_SECONDS, type StatusTracker } from "../status/tracker.js";
import { withSpan } from "../telemetry/span.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, limitFor, type RouteLimit } from "../http/rateLimit.js";

/** Responses are cached this long so a busy status page cannot load the database. */
export const STATUS_CACHE_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
/** Degraded when this share of recent responses were 5xx, once there are enough of them. */
export const ERROR_RATE_THRESHOLD = 0.05;
export const ERROR_RATE_MIN_REQUESTS = 20;

export interface StatusRouteDeps {
  db: Db;
  tracker: StatusTracker;
  version: string;
  now?: () => number;
  /** Per-IP limit; defaults to DEFAULT_RATE_LIMITS.status. */
  rateLimit?: RouteLimit;
}

async function dbReachable(db: Db): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // A count on the talks table needs only the read access the search path already has.
    const probe = runQuery(db, "select count(*) from talks");
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS);
    });
    await Promise.race([probe, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** GET /api/status in its own plugin scope (rate limited, 10 s cache). */
export function registerStatusRoutes(root: FastifyInstance, deps: StatusRouteDeps): void {
  root.register(async (app) => {
    await applyRateLimit(app);
    addStatusRoute(app, deps);
  });
}

function addStatusRoute(app: FastifyInstance, deps: StatusRouteDeps): void {
  const now = deps.now ?? Date.now;
  let cached: { at: number; value: StatusResponse } | undefined;
  let inflight: Promise<StatusResponse> | undefined;

  async function compute(): Promise<StatusResponse> {
    const reachable = await dbReachable(deps.db);
    const hybridState = deps.tracker.hybridState();
    const errorRate = deps.tracker.errorRate();
    let status: ServiceState = "ok";
    if (!reachable) status = "down";
    else if (
      hybridState === "warming_up" ||
      (errorRate.requests >= ERROR_RATE_MIN_REQUESTS && errorRate.ratio >= ERROR_RATE_THRESHOLD)
    ) {
      status = "degraded";
    }
    return {
      status,
      generatedAt: new Date(now()).toISOString(),
      windowSeconds: WINDOW_SECONDS,
      api: { up: true, version: deps.version },
      elasticsearch: { reachable },
      search: {
        keyword: deps.tracker.searchStat("keyword"),
        hybrid: { ...deps.tracker.searchStat("hybrid"), state: hybridState },
      },
      errorRate,
    };
  }

  app.get(routes.status.path, limitFor(deps.rateLimit ?? DEFAULT_RATE_LIMITS.status), async (_req, reply): Promise<StatusResponse> =>
    withSpan("status", { "http.request.method": "GET", "http.route": routes.status.path }, async (span) => {
      if (!cached || now() - cached.at >= STATUS_CACHE_MS) {
        inflight ??= compute().finally(() => {
          inflight = undefined;
        });
        const value = await inflight;
        cached = { at: now(), value };
      }
      reply.header("cache-control", `public, max-age=${STATUS_CACHE_MS / 1000}`);
      span.setAttribute("http.response.status_code", 200);
      return cached.value;
    }),
  );
}
