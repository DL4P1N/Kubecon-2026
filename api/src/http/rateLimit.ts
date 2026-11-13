import { isIPv6 } from "node:net";
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
 * Limits are per client per minute. The client is the IPv4 address or the IPv6
 * /64 (see clientKey): one IPv6 subscriber controls a whole /64, so a per-/128
 * bucket would give an attacker unlimited buckets. Cached aggregate routes are
 * cheap and get the most headroom. /healthz is deliberately not limited so
 * kubelet probes never see a 429.
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

/**
 * Rate-limit identity for a client address: IPv4 stays as is, an IPv4-mapped IPv6 address becomes
 * its IPv4 form, and any other IPv6 address becomes its /64 (for example `2001:db8:1:2::/64`).
 */
export function clientKey(ip: string): string {
  const addr = ip.split("%")[0] ?? ip;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped?.[1]) return mapped[1];
  if (!isIPv6(addr)) return ip;
  let text = addr;
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const headParts = head === "" ? [] : head.split(":");
  const tailParts = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? 0 : 8 - headParts.length - tailParts.length;
  const hextets = [...headParts, ...Array<string>(Math.max(zeros, 0)).fill("0"), ...tailParts];
  return `${hextets.slice(0, 4).map((h) => parseInt(h, 16).toString(16)).join(":")}::/64`;
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  search: { max: 60 },
  onboarding: { max: 20 },
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
    keyGenerator: (req) => clientKey(req.ip),
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
