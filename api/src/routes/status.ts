import type { FastifyInstance } from "fastify";
import { routes, type ServiceState, type StatusResponse } from "@cc/shared";
import type { EsClient } from "../es/client.js";
import { TALKS_INDEX } from "../search/queries.js";
import { WINDOW_SECONDS, type StatusTracker } from "../status/tracker.js";
import { withSpan } from "../telemetry/span.js";

/** Responses are cached this long so a busy status page cannot load Elasticsearch. */
export const STATUS_CACHE_MS = 10_000;
const PROBE_TIMEOUT_MS = 3_000;
/** Degraded when this share of recent responses were 5xx, once there are enough of them. */
export const ERROR_RATE_THRESHOLD = 0.05;
export const ERROR_RATE_MIN_REQUESTS = 20;

export interface StatusRouteDeps {
  es: EsClient;
  tracker: StatusTracker;
  version: string;
  now?: () => number;
}

async function esReachable(es: EsClient): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    // A count on the talks index needs only the read access the search path already has.
    const probe = es.request("GET", `/${TALKS_INDEX}/_count`);
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

export function registerStatusRoutes(app: FastifyInstance, deps: StatusRouteDeps): void {
  const now = deps.now ?? Date.now;
  let cached: { at: number; value: StatusResponse } | undefined;
  let inflight: Promise<StatusResponse> | undefined;

  async function compute(): Promise<StatusResponse> {
    const reachable = await esReachable(deps.es);
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

  app.get(routes.status.path, async (_req, reply): Promise<StatusResponse> =>
    withSpan("status", { "http.request.method": "GET", "url.path": routes.status.path }, async (span) => {
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
