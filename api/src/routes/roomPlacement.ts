import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { FastifyInstance } from "fastify";
import { routes, type RoomPlacementResponse } from "@cc/shared";
import type { EsClient } from "../es/client.js";
import { aggregateInterests } from "../interests/aggregate.js";
import { planPlacement, type RoomCapacities } from "../rooms/placement.js";
import { SOURCE_FIELDS } from "../search/queries.js";
import { toTalk } from "../search/service.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, limitFor, type RouteLimit } from "../http/rateLimit.js";
import { organizerAuthorizer } from "./clusters.js";

/** Upper bound on talks read for one placement run. */
export const MAX_PLACEMENT_TALKS = 1000;
/** Placement is served from memory for this long (after authorization), like the cluster route. */
export const PLACEMENT_CACHE_MS = 15_000;

export interface RoomPlacementRouteDeps {
  es: EsClient;
  /** ROOM_CAPACITIES; rooms not listed have unknown capacity. */
  roomCapacities?: RoomCapacities;
  /** Shared secret in `x-organizer-key`; defaults to ORGANIZER_KEY. Same rules as GET /api/interests/clusters. */
  organizerKey?: string;
  nodeEnv?: string;
  /** Per-IP limit; defaults to DEFAULT_RATE_LIMITS.roomPlacement. */
  rateLimit?: RouteLimit;
  now?: () => Date;
}

interface TalksResponse {
  timed_out?: boolean;
  _shards?: { failed: number };
  hits: { hits: { _id: string; _source?: Record<string, unknown> }[] };
}

async function loadPlacement(deps: RoomPlacementRouteDeps, at: Date): Promise<RoomPlacementResponse> {
  // The aggregate is the k >= 5 suppressed output; placement only ever sees that, never attendee rows.
  const aggregate = await aggregateInterests(deps.es, at);
  const { body } = await deps.es.request<TalksResponse>("POST", "/talks/_search", {
    size: MAX_PLACEMENT_TALKS,
    sort: [{ start: "asc" }],
    query: { match_all: {} },
    _source: SOURCE_FIELDS,
  });
  if (body.timed_out || body._shards?.failed) throw new Error("Catalog unavailable");
  const talks = body.hits.hits.map((h) => toTalk(h._id, h._source ?? {}));
  return planPlacement({
    talks,
    aggregate: aggregate.topics,
    capacities: deps.roomCapacities ?? {},
    suppressedBelow: aggregate.suppressedBelow,
    generatedAt: aggregate.generatedAt,
  });
}

/** GET /api/rooms/placement (organizer key), in its own plugin scope. */
export function registerRoomPlacementRoutes(root: FastifyInstance, deps: RoomPlacementRouteDeps): void {
  root.register(async (app) => {
    await applyRateLimit(app);
    const now = deps.now ?? (() => new Date());
    let cached: { at: number; value: RoomPlacementResponse } | undefined;
    const authorize = organizerAuthorizer({
      organizerKey: deps.organizerKey ?? (process.env.ORGANIZER_KEY || undefined),
      nodeEnv: deps.nodeEnv ?? process.env.NODE_ENV,
    });

    const limit = limitFor(deps.rateLimit ?? DEFAULT_RATE_LIMITS.roomPlacement);
    app.get(routes.roomPlacement.path, limit, async (req, reply) =>
      trace.getTracer("companion-api").startActiveSpan("rooms.placement", async (span) => {
        let status = 500;
        try {
          if (!authorize(req, reply)) {
            status = reply.statusCode;
            return reply;
          }
          // Checked after authorization, so the cache never serves an unauthorized caller.
          if (!cached || now().getTime() - cached.at >= PLACEMENT_CACHE_MS) {
            cached = { at: now().getTime(), value: await loadPlacement(deps, now()) };
          }
          reply.header("cache-control", "no-store");
          status = 200;
          return cached.value;
        } catch {
          // ES errors can contain query text; neither recorded nor echoed.
          status = 502;
          return reply.code(502).send({ error: "placement_unavailable" });
        } finally {
          span.setAttributes({
            "http.request.method": "GET",
            "http.route": routes.roomPlacement.path,
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
