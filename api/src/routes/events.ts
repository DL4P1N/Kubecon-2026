import type { FastifyPluginAsync } from "fastify";
import { routes } from "@cc/shared";
import type { EventHub } from "../chat/events.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, limitFor, type RouteLimit } from "../http/rateLimit.js";
import { withSpan } from "../telemetry/span.js";

export interface EventsRouteOptions {
  hub: EventHub;
  rateLimit?: RouteLimit;
}

/**
 * GET /api/events (no auth): Server-Sent Events for the venue demo. Heartbeat comment every 20 s,
 * at most 20 concurrent listeners (503 beyond that), cleaned up on close. See chat/events.ts for
 * exactly what can appear on the stream.
 */
export const eventsRoutes: FastifyPluginAsync<EventsRouteOptions> = async (app, opts) => {
  await applyRateLimit(app);
  app.get(routes.events.path, limitFor(opts.rateLimit ?? DEFAULT_RATE_LIMITS.events), async (req, reply) => {
    if (req.method === "HEAD") return reply.code(200).header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache").send();
    // The span covers accepting the listener; the stream itself is open-ended.
    const accepted = await withSpan("events.subscribe", { "http.request.method": "GET", "http.route": routes.events.path }, async (span) => {
      if (opts.hub.full) {
        span.setAttribute("http.response.status_code", 503);
        return false;
      }
      span.setAttribute("http.response.status_code", 200);
      return true;
    });
    if (!accepted) return reply.code(503).header("retry-after", "10").send({ error: "too_many_listeners", message: "too many live listeners" });

    reply.hijack();
    const res = reply.raw;
    req.raw.socket.setTimeout(0);
    req.raw.socket.setNoDelay(true);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    opts.hub.add(res);
  });
};
