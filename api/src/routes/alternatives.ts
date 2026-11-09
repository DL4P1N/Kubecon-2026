import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import { ALTERNATIVES_PATH, type AlternativesResponse } from "@cc/shared";
import { EsError, isEsOverload, type EsClient } from "../es/client.js";
import { DEFAULT_ALTERNATIVES, MAX_ALTERNATIVES, findAlternatives } from "../talks/alternatives.js";
import { withSpan } from "../telemetry/span.js";

export const ALTERNATIVES_CACHE_MS = 60_000;
const MAX_CACHE_ENTRIES = 500;
/** Seconds clients should wait before retrying after an Elasticsearch overload. */
const RETRY_AFTER_SECONDS = 5;
const TALK_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export interface AlternativesRouteOptions {
  es: EsClient;
  /** Per client IP per minute. Default 60. */
  rateLimitPerMinute?: number;
  now?: () => number;
}

/**
 * GET /api/talks/:id/alternatives ("room full? go here instead"). Public
 * catalog data only: no attendee identity is read or logged. Responses are
 * cached per talk and size for 60 s so repeated taps do not hit Elasticsearch,
 * and the route is rate limited per client IP.
 */
export const alternativesRoutes: FastifyPluginAsync<AlternativesRouteOptions> = async (app, opts) => {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: AlternativesResponse }>();
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof EsError) {
      // Error type and status only; ES bodies can contain query text.
      req.log.warn({ "error.type": err.errorType, "http.route": req.routeOptions?.url }, `elasticsearch request failed with status ${err.status}`);
      if (isEsOverload(err)) return reply.code(503).header("Retry-After", String(RETRY_AFTER_SECONDS)).send({ error: "search_overloaded" });
      return reply.code(502).send({ error: "search_unavailable" });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: status === 429 ? "rate_limited" : "invalid_request" });
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get<{ Params: { id: string }; Querystring: { size?: string } }>(
    ALTERNATIVES_PATH,
    { config: { rateLimit: { max: opts.rateLimitPerMinute ?? 60, timeWindow: "1 minute" } } },
    async (req, reply) =>
      withSpan("talks.alternatives", { "http.request.method": "GET", "url.path": ALTERNATIVES_PATH }, async (span) => {
        const { id } = req.params;
        const size = req.query.size === undefined ? DEFAULT_ALTERNATIVES : Number(req.query.size);
        if (!TALK_ID.test(id) || !Number.isInteger(size) || size < 1 || size > MAX_ALTERNATIVES) {
          span.setAttribute("http.response.status_code", 400);
          return reply.code(400).send({ error: "invalid_request", message: `id must be a talk id and size an integer from 1 to ${MAX_ALTERNATIVES}` });
        }
        const key = `${id}|${size}`;
        const hit = cache.get(key);
        let value = hit && now() - hit.at < ALTERNATIVES_CACHE_MS ? hit.value : undefined;
        if (!value) {
          value = await findAlternatives(opts.es, id, size);
          if (!value) {
            span.setAttribute("http.response.status_code", 404);
            return reply.code(404).send({ error: "not_found" });
          }
          if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
          cache.set(key, { at: now(), value });
        }
        span.setAttribute("http.response.status_code", 200);
        span.setAttribute("search.hits", value.alternatives.length);
        return reply.header("cache-control", `public, max-age=${ALTERNATIVES_CACHE_MS / 1000}`).send(value);
      }),
  );
};
