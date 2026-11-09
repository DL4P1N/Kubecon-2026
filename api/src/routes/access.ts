import rateLimit from "@fastify/rate-limit";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { routes, type AccessTokenResponse, type ScanResponse } from "@cc/shared";
import { requireAttendee, TokenError, type TokenService } from "../auth/token.js";
import type { EsClient } from "../es/client.js";
import { TALKS_INDEX } from "../search/queries.js";
import { recordAccessScan } from "../telemetry/metrics.js";
import { withSpan } from "../telemetry/span.js";
import { ALL_ROOMS, type AttendeeDoc, type EntitlementDoc } from "./register.js";

/**
 * Module 3: QR access per room.
 *
 *   POST /api/access/token  (attendee Bearer token, QR opt-in) -> ~60s token, audience "access"
 *   POST /api/access/scan   (kiosk, rate limited)              -> allow / deny for one room
 *
 * Design doc section 6:
 * - The QR token carries the attendee ID only and has audience "access", so a
 *   session token cannot be scanned and a QR token cannot call the API.
 * - Every scan reads the `entitlements` doc from Elasticsearch (no cache), so
 *   revocation is just editing that doc. Any failure to decide denies.
 * - Spans carry only `access.decision` and `room.id` (docs/telemetry-allowlist.md).
 *   The attendee ID is never logged, put on a span, or returned by the scan.
 *   ES error messages contain the doc path (and so the ID); they are dropped.
 */

export const ACCESS_AUDIENCE = "access";
export const ACCESS_TOKEN_TTL_SECONDS = 60;
/** Room IDs are the talks index `room` strings (e.g. "Salt Palace | Level 1 | Hall DE"). */
export const MAX_ROOM_LENGTH = 200;
/** A signed JWT carrying a UUID is ~250 bytes; anything much larger is not ours. */
export const MAX_SCAN_TOKEN_LENGTH = 1024;

/** Metric room label when the room is not (yet) a validated catalog room. */
export const UNKNOWN_ROOM = "unknown";

export const scanBodySchema = z.object({
  token: z.string().min(1).max(MAX_SCAN_TOKEN_LENGTH),
  // No control characters (log/header injection); existence is checked against the catalog.
  room: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ROOM_LENGTH)
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f]+$/, "invalid characters"),
});

export interface AccessRoutesOptions {
  es: EsClient;
  tokens: TokenService;
  /** Per client IP per minute. Kiosks share a venue IP, so this is generous. Default 600. */
  scanRateLimitPerMinute?: number;
  /** Per client IP per minute for token issuance. Default 120. */
  tokenRateLimitPerMinute?: number;
  now?: () => number;
}

/** Fail closed: a missing or unparseable expiry (docs are hand-edited) is treated as expired. */
function isActive(expiresAt: unknown, nowMs: number): boolean {
  const exp = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(exp) && exp > nowMs;
}

const deny = (room: string, reason: string): ScanResponse => ({ decision: "deny", room, reason });

export const accessRoutes: FastifyPluginAsync<AccessRoutesOptions> = async (app, opts) => {
  const { es, tokens } = opts;
  const now = opts.now ?? Date.now;

  // Scoped to this plugin; only routes that opt in via config.rateLimit are limited.
  await app.register(rateLimit, { global: false });

  app.post(
    routes.accessToken.path,
    { config: { rateLimit: { max: opts.tokenRateLimitPerMinute ?? 120, timeWindow: "1 minute" } } },
    async (req, reply) =>
      withSpan("access.token", {}, async () => {
        const id = await requireAttendee(tokens, req, reply);
        if (id === null) return reply;

        let doc: { found?: boolean; _source?: Pick<AttendeeDoc, "consent" | "expires_at"> } | undefined;
        try {
          const r = await es.request<typeof doc>(
            "GET",
            `/attendees/_doc/${encodeURIComponent(id)}?_source_includes=consent,expires_at`,
            undefined,
            [404],
          );
          doc = r.body;
        } catch {
          return reply.code(503).send({ error: "storage_unavailable", message: "could not check consent" });
        }
        const src = doc?.found ? doc._source : undefined;
        if (!src || !isActive(src.expires_at, now())) {
          return reply.code(401).send({ error: "unauthorized", message: "attendee not found" });
        }
        if (src.consent?.qr_checkin !== true) {
          return reply.code(403).send({ error: "forbidden", message: "QR check-in was not opted in" });
        }
        const signed = await tokens.sign(id, { audience: ACCESS_AUDIENCE, ttlSeconds: ACCESS_TOKEN_TTL_SECONDS });
        const res: AccessTokenResponse = { token: signed.token, expiresAt: signed.expiresAt };
        return reply.send(res);
      }).catch(() =>
        // Signing failures etc. The error is dropped on purpose (could carry the ID).
        reply.sent ? reply : reply.code(500).send({ error: "internal_error", message: "unexpected error" }),
      ),
  );

  app.post(
    routes.accessScan.path,
    { config: { rateLimit: { max: opts.scanRateLimitPerMinute ?? 600, timeWindow: "1 minute" } } },
    async (req, reply) =>
      withSpan("access.scan", {}, async (span) => {
        // Room that passed the catalog check; user input is never used as a metric label before that.
        let knownRoom: string | undefined;
        const decide = (decision: ScanResponse["decision"]) => {
          span.setAttribute("access.decision", decision);
          recordAccessScan(decision, knownRoom ?? UNKNOWN_ROOM);
        };
        const parsed = scanBodySchema.safeParse(req.body);
        if (!parsed.success) {
          decide("deny");
          // Field paths and messages only; never echo submitted values.
          return reply.code(400).send({
            error: "invalid_request",
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
          });
        }
        const { token, room } = parsed.data;

        const finish = (code: number, body: ScanResponse) => {
          decide(body.decision);
          return reply.code(code).send(body);
        };

        let attendeeId: string;
        try {
          attendeeId = await tokens.verify(token, { audience: ACCESS_AUDIENCE });
        } catch (err) {
          const reason = err instanceof TokenError && err.reason === "expired" ? "token_expired" : "token_invalid";
          return finish(401, deny(room, reason));
        }

        try {
          // Unknown rooms are rejected, never allowed by a "*" entitlement.
          const known = await es.request<{ count?: number }>("POST", `/${TALKS_INDEX}/_count`, {
            query: { term: { room } },
          });
          if (!known.body.count) {
            decide("deny");
            return reply.code(400).send({ error: "invalid_request", message: "room: unknown room" });
          }
          knownRoom = room;
          span.setAttribute("room.id", room);

          const r = await es.request<{ found?: boolean; _source?: EntitlementDoc }>(
            "GET",
            `/entitlements/_doc/${encodeURIComponent(attendeeId)}`,
            undefined,
            [404],
          );
          const ent = r.body?.found ? r.body._source : undefined;
          if (!ent || !isActive(ent.expires_at, now())) return finish(200, deny(room, "no_entitlement"));
          const rooms = Array.isArray(ent.rooms) ? ent.rooms : [];
          if (!rooms.includes(room) && !rooms.includes(ALL_ROOMS)) return finish(200, deny(room, "not_entitled"));
          return finish(200, { decision: "allow", room });
        } catch {
          // Fail closed. ES errors are not logged or returned: they contain the doc path.
          decide("deny");
          return reply.code(503).send({ error: "storage_unavailable", message: "could not check access" });
        }
      }).catch(() =>
        reply.sent ? reply : reply.code(500).send({ error: "internal_error", message: "unexpected error" }),
      ),
  );
};
