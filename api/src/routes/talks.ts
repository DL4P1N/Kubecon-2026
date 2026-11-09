import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { ALTERNATIVES_PATH, RELATED_PATH, TALK_PATH } from "@cc/shared";
import { EsError, isEsOverload, type EsClient } from "../es/client.js";
import {
  DEFAULT_ALTERNATIVES,
  DEFAULT_RELATED,
  MAX_ALTERNATIVES,
  findAlternatives,
  findRelated,
  findTalk,
} from "../talks/alternatives.js";
import { withSpan } from "../telemetry/span.js";

export const TALKS_CACHE_MS = 60_000;
/** Kept for the alternatives tests and docs: same 60 s window. */
export const ALTERNATIVES_CACHE_MS = TALKS_CACHE_MS;
const MAX_CACHE_ENTRIES = 500;
/** Seconds clients should wait before retrying after an Elasticsearch overload. */
const RETRY_AFTER_SECONDS = 5;
const TALK_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export interface TalkRouteOptions {
  es: EsClient;
  /** Per client IP per minute. Default 60. */
  rateLimitPerMinute?: number;
  now?: () => number;
}

/**
 * Public catalog routes (no attendee identity is read or logged):
 *   GET /api/talks/:id               one talk (detail page)
 *   GET /api/talks/:id/alternatives  same time slot, other rooms, by similarity ("room full?")
 *   GET /api/talks/:id/related       similar topics at any time (detail page)
 * Each response is cached per route, talk and size for 60 s, and all routes are
 * rate limited per client IP (cached hits count too).
 */
export const talkRoutes: FastifyPluginAsync<TalkRouteOptions> = async (app, opts) => {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: unknown }>();
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

  const rateLimitConfig = { rateLimit: { max: opts.rateLimitPerMinute ?? 60, timeWindow: "1 minute" } };

  /** Runs `compute` (or serves the cache) inside a span with allowlisted attributes. */
  async function serve<T>(
    spanName: string,
    routeTemplate: string,
    key: string,
    reply: FastifyReply,
    compute: () => Promise<T | undefined>,
    hits: (v: T) => number | undefined,
  ) {
    return withSpan(spanName, { "http.request.method": "GET", "url.path": routeTemplate }, async (span) => {
      const hit = cache.get(key);
      let value = hit && now() - hit.at < TALKS_CACHE_MS ? (hit.value as T) : undefined;
      if (value === undefined) {
        value = await compute();
        if (value === undefined) {
          span.setAttribute("http.response.status_code", 404);
          return reply.code(404).send({ error: "not_found" });
        }
        if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
        cache.set(key, { at: now(), value });
      }
      span.setAttribute("http.response.status_code", 200);
      const n = hits(value);
      if (n !== undefined) span.setAttribute("search.hits", n);
      return reply.header("cache-control", `public, max-age=${TALKS_CACHE_MS / 1000}`).send(value);
    });
  }

  const badRequest = (reply: FastifyReply, max: number) =>
    reply.code(400).send({ error: "invalid_request", message: `id must be a talk id and size an integer from 1 to ${max}` });

  /** Parses `size` against a default and maximum; returns undefined when invalid. */
  const parseSize = (raw: string | undefined, fallback: number, max: number) => {
    const size = raw === undefined ? fallback : Number(raw);
    return Number.isInteger(size) && size >= 1 && size <= max ? size : undefined;
  };

  app.get<{ Params: { id: string } }>(TALK_PATH, { config: rateLimitConfig }, async (req, reply) => {
    const { id } = req.params;
    if (!TALK_ID.test(id)) return badRequest(reply, MAX_ALTERNATIVES);
    return serve("talks.detail", TALK_PATH, `detail|${id}`, reply, async () => {
      const talk = await findTalk(opts.es, id);
      return talk ? { talk } : undefined;
    }, () => undefined);
  });

  app.get<{ Params: { id: string }; Querystring: { size?: string } }>(ALTERNATIVES_PATH, { config: rateLimitConfig }, async (req, reply) => {
    const { id } = req.params;
    const size = parseSize(req.query.size, DEFAULT_ALTERNATIVES, MAX_ALTERNATIVES);
    if (!TALK_ID.test(id) || size === undefined) return badRequest(reply, MAX_ALTERNATIVES);
    return serve("talks.alternatives", ALTERNATIVES_PATH, `alt|${id}|${size}`, reply, () => findAlternatives(opts.es, id, size), (v) => v.alternatives.length);
  });

  app.get<{ Params: { id: string }; Querystring: { size?: string } }>(RELATED_PATH, { config: rateLimitConfig }, async (req, reply) => {
    const { id } = req.params;
    const size = parseSize(req.query.size, DEFAULT_RELATED, MAX_ALTERNATIVES);
    if (!TALK_ID.test(id) || size === undefined) return badRequest(reply, MAX_ALTERNATIVES);
    return serve("talks.related", RELATED_PATH, `rel|${id}|${size}`, reply, () => findRelated(opts.es, id, size), (v) => v.related.length);
  });
};
