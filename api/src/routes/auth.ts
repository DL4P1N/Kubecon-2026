import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { routes, type AuthCallbackResponse, type AuthProvidersResponse } from "@cc/shared";
import type { Config } from "../config.js";
import type { TokenService } from "../auth/token.js";
import type { Db } from "../db/client.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, limitFor, type RouteLimit } from "../http/rateLimit.js";
import { withSpan } from "../telemetry/span.js";
import { PROVIDER_IDS, buildAuthorizeUrl, clearNonceCookie, createStateStore, fetchProfile, identityId, isProviderId, nonceCookie, nonceMatches, sanitizeReturn } from "../auth/oauth.js";

export interface AuthRouteOptions {
  oauth: Config["oauth"];
  db: Db;
  tokens: TokenService;
  /** HMAC key for the account link (config.identityHashKey). */
  identityHashKey: string;
  rateLimit?: RouteLimit;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  now?: () => number;
}

const providerParam = z.object({ provider: z.string().max(32) });
const startQuery = z.object({ return: z.string().max(512).optional(), app: z.string().max(8).optional() });
const callbackBody = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(128) });

const notFound = { error: "not_found", message: "unknown or disabled sign-in provider" };

/**
 * Sign in with GitHub; an account maps to one attendee profile across devices.
 *
 * GET  /api/auth/providers            which providers are configured
 * GET  /api/auth/:provider/start      302 to the provider, with a one-time `state` kept in memory for 10 minutes,
 *                                     and an HttpOnly SameSite=Lax cookie holding a nonce bound to that state
 * POST /api/auth/:provider/callback   {code,state} + the nonce cookie -> exchanges the code with the secret, returns the profile and
 *                                     either an attendee `session` (known account) or an `identityClaim` (new account)
 *
 * Stored: only an HMAC of (provider, provider subject) -> attendee ID in `identities`. No provider tokens are returned or stored, and no code, token or profile field is logged or put on a span
 * (spans carry only the allowlisted route and status code).
 */
export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, opts) => {
  const fetchFn = opts.fetch ?? fetch;
  const states = createStateStore({ now: opts.now });
  const now = opts.now ?? Date.now;

  /** Attendee ID for a known account with a live profile; null for a new account. Drops a link whose profile is gone. */
  async function resolveLinkedAttendee(id: string): Promise<string | null> {
    const { rows } = await opts.db.query<{ attendee_id: string; live: boolean }>(
      `select i.attendee_id, (a.id is not null and a.expires_at > $2) as live
         from identities i left join attendees a on a.id = i.attendee_id
        where i.id = $1`,
      [id, new Date(now())],
    );
    const row = rows[0];
    if (!row) return null;
    if (row.live) return row.attendee_id;
    await opts.db.query("delete from identities where id = $1", [id]);
    return null;
  }
  const limit = limitFor(opts.rateLimit ?? DEFAULT_RATE_LIMITS.auth);
  await applyRateLimit(app);

  app.get(routes.authProviders.path, limit, async (_req, reply): Promise<AuthProvidersResponse> =>
    withSpan("auth.providers", { "http.request.method": "GET", "http.route": routes.authProviders.path }, async (span) => {
      reply.header("cache-control", "no-store");
      span.setAttribute("http.response.status_code", 200);
      return { providers: PROVIDER_IDS.map((id) => ({ id, enabled: Boolean(opts.oauth[id]) })) };
    }),
  );

  app.get(routes.authStart.path, limit, async (req, reply) =>
    withSpan("auth.start", { "http.request.method": "GET", "http.route": routes.authStart.path }, async (span) => {
      const { provider } = providerParam.parse(req.params);
      const cfg = isProviderId(provider) ? opts.oauth[provider] : undefined;
      if (!isProviderId(provider) || !cfg) {
        span.setAttribute("http.response.status_code", 404);
        return reply.code(404).send(notFound);
      }
      const q = startQuery.safeParse(req.query);
      const back = q.success ? sanitizeReturn(q.data.return) : null;
      if (!q.success || back === null) {
        span.setAttribute("http.response.status_code", 400);
        return reply.code(400).send({ error: "invalid_request", message: "invalid return" });
      }
      const { state, nonce } = states.create({ provider, return: back, app: q.data.app === "1" });
      span.setAttribute("http.response.status_code", 302);
      reply.header("cache-control", "no-store");
      // Binds the flow to this browser: the callback must present the same nonce. No cookie plugin is
      // needed; the cookie is scoped to /api/auth so it never rides along on other requests.
      reply.header("set-cookie", nonceCookie(nonce, cfg.redirectUri.startsWith("https:")));
      return reply.redirect(buildAuthorizeUrl(provider, cfg, state), 302);
    }),
  );

  app.post(routes.authCallback.path, { bodyLimit: 4096, ...limit }, async (req, reply) =>
    withSpan("auth.callback", { "http.request.method": "POST", "http.route": routes.authCallback.path }, async (span) => {
      const fail = (status: number, body: { error: string; message: string }) => {
        span.setAttribute("http.response.status_code", status);
        return reply.code(status).send(body);
      };
      const { provider } = providerParam.parse(req.params);
      const cfg = isProviderId(provider) ? opts.oauth[provider] : undefined;
      if (!isProviderId(provider) || !cfg) return fail(404, notFound);
      const parsed = callbackBody.safeParse(req.body);
      // The field name only, never the submitted value.
      if (!parsed.success) return fail(400, { error: "invalid_request", message: `invalid ${String(parsed.error.issues[0]?.path[0] ?? "body")}` });
      const body = parsed.data;
      const pending = states.consume(body.state, provider);
      if (!pending || !nonceMatches(pending.nonce, req.headers.cookie)) return fail(400, { error: "invalid_state", message: "sign-in expired or already used, start again" });
      try {
        const profile = await fetchProfile(provider, cfg, body.code, fetchFn);
        const { subject, ...shown } = profile;
        const id = identityId(opts.identityHashKey, provider, subject);
        let linked: string | null;
        try {
          linked = await resolveLinkedAttendee(id);
        } catch {
          return fail(503, { error: "storage_unavailable", message: "could not check sign-in" });
        }
        const base = { ...shown, return: pending.return, app: pending.app };
        const out: AuthCallbackResponse = linked !== null
          ? { ...base, session: await opts.tokens.sign(linked) }
          : { ...base, claim: await opts.tokens.sign(id, { audience: "identity-claim", ttlSeconds: 900 }) };
        span.setAttribute("http.response.status_code", 200);
        reply.header("cache-control", "no-store");
        reply.header("set-cookie", clearNonceCookie());
        return out;
      } catch {
        // Never logged or echoed: provider errors can carry codes and account details.
        return fail(502, { error: "provider_error", message: "the sign-in provider could not be reached, try again" });
      }
    }),
  );
};
