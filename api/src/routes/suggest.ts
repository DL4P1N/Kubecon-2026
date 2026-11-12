import type { FastifyPluginAsync } from "fastify";
import { SUGGEST_PATH, type SuggestResponse } from "@cc/shared";
import type { Db } from "../db/client.js";
import { sendDbError } from "../search/errors.js";
import { MAX_SUGGEST_CHARS, MIN_SUGGEST_CHARS, suggest } from "../suggest/suggest.js";
import { withSpan } from "../telemetry/span.js";
import { applyRateLimit, sendIfRateLimited } from "../http/rateLimit.js";

export const SUGGEST_CACHE_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;

export interface SuggestRouteOptions {
  db: Db;
  /** Per client IP per minute. Default 120: a person typing fires several requests. */
  rateLimitPerMinute?: number;
  now?: () => number;
}

/**
 * GET /api/suggest?q= : title and speaker completions for the search box.
 * Public catalog data only. The typed text is never logged or put on a span
 * (only the route template, as `http.route`, is), and it is used only as an in-memory cache key
 * for 30 s. Rate limited per client IP; cached hits count against the limit.
 */
export const suggestRoutes: FastifyPluginAsync<SuggestRouteOptions> = async (app, opts) => {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; value: SuggestResponse }>();
  await applyRateLimit(app); // shared 429 shape and req.ip key (http/rateLimit.ts)

  app.setErrorHandler((err: Error, req, reply) => {
    if (sendIfRateLimited(err, reply)) return reply;
    if (sendDbError(err, req, reply)) return reply;
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: status === 429 ? "rate_limited" : "invalid_request" });
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get<{ Querystring: { q?: unknown } }>(
    SUGGEST_PATH,
    { config: { rateLimit: { max: opts.rateLimitPerMinute ?? 120, timeWindow: "1 minute" } } },
    async (req, reply) =>
      withSpan("search.suggest", { "http.request.method": "GET", "http.route": SUGGEST_PATH }, async (span) => {
        const raw = req.query.q ?? "";
        if (typeof raw !== "string" || raw.length > MAX_SUGGEST_CHARS * 2) {
          span.setAttribute("http.response.status_code", 400);
          return reply.code(400).send({ error: "invalid_request", message: `q must be one string of at most ${MAX_SUGGEST_CHARS} characters` });
        }
        const q = raw.trim().replace(/\s+/g, " ");
        if (q.length > MAX_SUGGEST_CHARS) {
          span.setAttribute("http.response.status_code", 400);
          return reply.code(400).send({ error: "invalid_request", message: `q must be one string of at most ${MAX_SUGGEST_CHARS} characters` });
        }
        // Too short to suggest anything useful: answer without touching the database.
        if (q.length < MIN_SUGGEST_CHARS) {
          span.setAttribute("http.response.status_code", 200);
          return reply.send({ suggestions: [] } satisfies SuggestResponse);
        }
        const key = q.toLowerCase();
        const hit = cache.get(key);
        let value = hit && now() - hit.at < SUGGEST_CACHE_MS ? hit.value : undefined;
        if (!value) {
          value = { suggestions: await suggest(opts.db, q) };
          if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
          cache.set(key, { at: now(), value });
        }
        span.setAttribute("http.response.status_code", 200);
        span.setAttribute("search.hits", value.suggestions.length);
        return reply.header("cache-control", `public, max-age=${SUGGEST_CACHE_MS / 1000}`).send(value);
      }),
  );
};
