import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Shared per-client rate-limit policy for the public API.
 *
 * Buckets are keyed on `request.ip`, which honours the `trustProxy` hop count
 * from config (TRUST_PROXY), so clients behind the ingress get their own
 * bucket and a spoofed X-Forwarded-For entry beyond the trusted hops cannot
 * pick a fresh one. Counters are in memory per replica (no attendee data).
 *
 * Limits are per client IP per minute. Conference Wi-Fi can NAT many
 * attendees behind one address, so the attendee-facing limits are generous;
 * cached aggregate routes are cheap and get the most headroom. /healthz is
 * deliberately not limited so kubelet probes never see a 429.
 */
export interface RouteLimit {
  max: number;
}

export interface RateLimitPolicy {
  search: RouteLimit;
  onboarding: RouteLimit;
  schedule: RouteLimit;
  status: RouteLimit;
  interestsAggregate: RouteLimit;
  interestsClusters: RouteLimit;
  roomPlacement: RouteLimit;
  me: RouteLimit;
  catalogTopics: RouteLimit;
  chat: RouteLimit;
  events: RouteLimit;
  auth: RouteLimit;
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  search: { max: 240 },
  onboarding: { max: 60 },
  schedule: { max: 120 },
  status: { max: 600 },
  interestsAggregate: { max: 300 },
  interestsClusters: { max: 120 },
  roomPlacement: { max: 60 },
  me: { max: 120 },
  catalogTopics: { max: 300 },
  // Each chat turn may spawn the Claude CLI (which spends usage), so the guard is tighter than for reads.
  chat: { max: 30 },
  events: { max: 30 },
  // Each callback makes two outbound calls to a provider; sign-in is a once-in-a-while action.
  auth: { max: 30 },
};

export const RATE_LIMIT_WINDOW = "1 minute";

export function resolveRateLimits(overrides: Partial<RateLimitPolicy> = {}): RateLimitPolicy {
  return { ...DEFAULT_RATE_LIMITS, ...overrides };
}

/** Body for every 429, in every scope: `{ statusCode: 429, error: "rate_limited", message }`. */
export interface RateLimitedBody {
  statusCode: 429;
  error: "rate_limited";
  message: string;
}

/** The shared 429 body, for limits enforced outside @fastify/rate-limit (concurrency caps). */
export function rateLimitedBody(message: string): RateLimitedBody {
  return { statusCode: 429, error: "rate_limited", message };
}

/**
 * Registers @fastify/rate-limit in the caller's plugin scope with `global: false`,
 * so only routes there that set `config.rateLimit` are limited. Register it once
 * per encapsulated scope (not at the root) so no route is counted twice.
 */
export async function applyRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => req.ip,
    errorResponseBuilder: (_req, ctx): RateLimitedBody => ({
      statusCode: 429,
      error: "rate_limited",
      message: `too many requests, retry in ${ctx.after}`,
    }),
  });
}

/** Route options that opt a route into the shared policy. */
export function limitFor(limit: RouteLimit) {
  return { config: { rateLimit: { max: limit.max, timeWindow: RATE_LIMIT_WINDOW } } };
}

/**
 * For scopes with their own error handler: true (and the 429 sent) if `err` is a rate-limit rejection.
 * Sends exactly the builder's body, so a 429 looks the same in every scope, whether it goes
 * through a custom handler or Fastify's default one.
 */
export function sendIfRateLimited(err: unknown, reply: FastifyReply): boolean {
  const e = err as Partial<RateLimitedBody> | null;
  if (e?.statusCode !== 429 || e.error !== "rate_limited") return false;
  const body: RateLimitedBody = { statusCode: 429, error: "rate_limited", message: String(e.message) };
  void reply.code(429).send(body);
  return true;
}
