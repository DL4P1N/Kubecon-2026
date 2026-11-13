import type { FastifyPluginAsync } from "fastify";
import { routes } from "@cc/shared";
import type { EventHub } from "../chat/events.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, clientKey, limitFor, rateLimitedBody, type RouteLimit } from "../http/rateLimit.js";
import { withSpan } from "../telemetry/span.js";

export interface EventsRouteOptions {
  hub: EventHub;
  rateLimit?: RouteLimit;
}

/**
 * GET /api/events (no auth): Server-Sent Events for the venue demo. Heartbeat comment every 20 s,
 * at most 20 concurrent listeners (503 beyond that) and 3 per client IP (shared-shape 429), cleaned up on close. See chat/events.ts for
 * exactly what can appear on the stream.
 */
export const eventsRoutes: FastifyPluginAsync<EventsRouteOptions> = async (app, opts) => {
  await applyRateLimit(app);
  app.get(routes.events.path, limitFor(opts.rateLimit ?? DEFAULT_RATE_LIMITS.events), async (req, reply) => {
    if (req.method === "HEAD") return reply.code(200).header("content-type", "text/event-stream; charset=utf-8").header("cache-control", "no-cache").send();
    // The span covers accepting the listener; the stream itself is open-ended.
    const verdict = await withSpan("events.subscribe", { "http.request.method": "GET", "http.route": routes.events.path }, async (span) => {
      const v = opts.hub.ipFull(clientKey(req.ip)) ? "ip" : opts.hub.full ? "global" : "ok";
      span.setAttribute("http.response.status_code", v === "ok" ? 200 : v === "ip" ? 429 : 503);
      return v;
    });
    if (verdict === "ip") return reply.code(429).header("retry-after", "10").send(rateLimitedBody("too many live streams from this address, retry in 10 seconds"));
    if (verdict === "global") return reply.code(503).header("retry-after", "10").send({ error: "too_many_listeners", message: "too many live listeners" });

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
    opts.hub.add(res, clientKey(req.ip));
  });
};
