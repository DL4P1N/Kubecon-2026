import { randomUUID } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z } from "zod";
import { routes, type MeResponse, type RegisterResponse } from "@cc/shared";
import { requireAttendee, type TokenService } from "../auth/token.js";
import type { EsClient } from "../es/client.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, limitFor } from "../http/rateLimit.js";
import { embed as defaultEmbed } from "../es/embeddings.js";
import { expiresAtFor, retentionMsFromEnv } from "../retentionPolicy.js";

/**
 * Module 1: registration and profile.
 *
 *   POST /api/register  (no auth, rate limited) -> attendee doc + default entitlement + token
 *   GET  /api/me        (Bearer token)          -> profile
 *
 * Privacy rules (design doc sections 5 and 6):
 * - Only display name, interests and the (always true) consent flags are stored. Email is
 *   accepted for contract compatibility but never stored. Unknown fields are
 *   dropped, so no health, politics or identity data can reach ES.
 * - Profiles are kept by default (expires_at is the NO_EXPIRY sentinel); ATTENDEE_RETENTION_HOURS=24
 *   restores timed deletion (retentionPolicy.ts, docs/retention.md).
 * - The attendee ID is never logged and never put on a span. ES error
 *   messages contain the doc path (and so the ID), so they are not recorded
 *   on spans or returned to clients either.
 */

/** Default entitlement: a general pass to every room. "*" means all rooms. */
export const DEFAULT_PASS_TYPE = "general";
export const ALL_ROOMS = "*";

export const MAX_INTERESTS = 20;
export const MAX_INTEREST_LENGTH = 64;
export const MAX_NAME_LENGTH = 80;

/**
 * Interests are validated loosely (non-empty short strings, bounded count)
 * rather than against the live catalog, so tag discovery via
 * GET /api/search before registration keeps working. Normalised to lowercase
 * and de-duplicated to match catalog tag style.
 */
export const registerBodySchema = z.object({
  name: z.string().trim().min(1, "name is required").max(MAX_NAME_LENGTH),
  // Accepted but never stored (see docs/elasticsearch.md).
  email: z.string().trim().max(254).optional(),
  interests: z
    .array(z.string().trim().min(1).max(MAX_INTEREST_LENGTH))
    .min(1, "at least one interest is required")
    .max(MAX_INTERESTS)
    .transform((xs) => [...new Set(xs.map((x) => x.toLowerCase()))]),
  // The chat sign-up does not ask for consent, so each flag defaults to true when absent. An explicit
  // false is stored and honoured (QR token, interest aggregate, cluster job).
  consent: z
    .object({
      clusterMap: z.boolean(),
      qrCheckin: z.boolean(),
    })
    .optional(),
  // Optional and never stored: only feed the live demo stream (GET /api/events).
  conference: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  returning: z.boolean().optional(),
  // From the sign-in callback; links the new profile to the provider account.
  identityClaim: z.string().max(2048).optional(),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;

/** Shape of a document in the `attendees` index (see es/mappings.ts). */
export interface AttendeeDoc {
  id: string;
  display_name: string;
  interests: string[];
  /** Absent when the embedder was unavailable at registration. */
  interest_vector?: number[];
  consent: { cluster_map: boolean; qr_checkin: boolean };
  created_at: string;
  expires_at: string;
}

export interface EntitlementDoc {
  attendee_id: string;
  pass_type: string;
  rooms: string[];
  updated_at: string;
  expires_at: string;
}

export interface RegisterRoutesOptions {
  es: EsClient;
  tokens: TokenService;
  /** Defaults to the configured embedder (es/embeddings.ts). */
  embed?: (text: string) => Promise<number[]>;
  /** Per client IP per minute. Default 120 (REGISTER_RATE_LIMIT_PER_MINUTE); attendees can share a venue NAT IP. */
  rateLimitPerMinute?: number;
  now?: () => number;
  /** Attendee retention in ms; null keeps profiles. Default: ATTENDEE_RETENTION_HOURS (retentionPolicy.ts). */
  retentionMs?: number | null;
  /**
   * Called once after a successful registration (for the live demo stream). Receives only the display
   * name, the interests and the optional demo fields; never the attendee ID or token. Must not throw.
   */
  onRegistered?: (info: { name: string; interests: string[]; conference?: string; returning?: boolean }) => void;
}

const tracer = () => trace.getTracer("companion-api");

/**
 * Runs a handler inside a span that is ended on every path (success, 4xx,
 * 5xx, thrown error). Only allowlisted attributes (docs/telemetry-allowlist.md)
 * are set; never the attendee ID or error messages (ES errors contain doc
 * paths, and so IDs). Unexpected errors become a generic 500.
 */
async function traced(
  name: string,
  method: string,
  path: string,
  reply: FastifyReply,
  fn: () => Promise<unknown>,
): Promise<unknown> {
  return tracer().startActiveSpan(name, async (span) => {
    let status = 500;
    try {
      const out = await fn();
      status = reply.statusCode;
      return out;
    } catch {
      // Deliberately not logged or recorded: error text may contain the attendee ID.
      status = 500;
      if (!reply.sent) return reply.code(500).send({ error: "internal_error", message: "unexpected error" });
      return reply;
    } finally {
      span.setAttributes({
        "http.request.method": method,
        "http.route": path,
        "http.response.status_code": status,
        "db.system": "elasticsearch",
      });
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR, message: "server_error" });
      span.end();
    }
  });
}

export const registerRoutes: FastifyPluginAsync<RegisterRoutesOptions> = async (app, opts) => {
  const { es, tokens } = opts;
  const embedText = opts.embed ?? defaultEmbed;
  const now = opts.now ?? Date.now;

  // Scoped to this plugin: only routes that opt in via config.rateLimit are limited.
  // Behind an ingress, set Fastify `trustProxy` so req.ip is the client, not the proxy.
  await applyRateLimit(app); // shared 429 shape and req.ip key (http/rateLimit.ts)

  app.post(
    routes.register.path,
    {
      config: {
        rateLimit: { max: opts.rateLimitPerMinute ?? 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) =>
      traced("register", "POST", routes.register.path, reply, async () => {
        const parsed = registerBodySchema.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: "invalid_request",
            // Field paths and messages only; never echo submitted values.
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
          });
        }
        const body = parsed.data;
        let identity: string | null = null;
        if (body.identityClaim !== undefined) {
          try {
            identity = await tokens.verify(body.identityClaim, { audience: "identity-claim" });
          } catch {
            return reply.code(400).send({ error: "invalid_identity_claim", message: "identityClaim: expired or invalid, sign in again" });
          }
        }
        const id = randomUUID();
        const t = now();
        const createdAt = new Date(t).toISOString();
        const expiresAt = expiresAtFor(t, opts.retentionMs === undefined ? retentionMsFromEnv() : opts.retentionMs);

        // Sign first: if signing fails nothing has been written yet (traced() turns it into a 500).
        const signed = await tokens.sign(id);

        // The vector only feeds the cluster map; if the embedder (ES inference)
        // is down, register anyway without it rather than block sign-up.
        const interestVector = await embedText(body.interests.join(", ")).catch(() => undefined);
        const attendee: AttendeeDoc = {
          id,
          display_name: body.name,
          interests: body.interests,
          ...(interestVector ? { interest_vector: interestVector } : {}),
          consent: { cluster_map: body.consent?.clusterMap ?? true, qr_checkin: body.consent?.qrCheckin ?? true },
          created_at: createdAt,
          expires_at: expiresAt,
        };
        const entitlement: EntitlementDoc = {
          attendee_id: id,
          pass_type: DEFAULT_PASS_TYPE,
          rooms: [ALL_ROOMS],
          updated_at: createdAt,
          expires_at: expiresAt,
        };

        let identityCreated = false;
        let duplicate = false;
        try {
          await es.request("PUT", `/attendees/_create/${id}?refresh=wait_for`, attendee);
          await es.request("PUT", `/entitlements/_doc/${id}?refresh=wait_for`, entitlement);
          if (identity !== null) {
            const r = await es.request("PUT", `/identities/_create/${identity}?refresh=wait_for`, { attendee_id: id, created_at: createdAt, expires_at: expiresAt }, [409]);
            if (r.status === 409) duplicate = true;
            else identityCreated = true;
          }
          if (duplicate) throw new Error("duplicate");
        } catch {
          // Best-effort cleanup so a failed registration leaves no half-written
          // attendee. Errors are not logged: they contain the doc path.
          await Promise.allSettled([
            es.request("DELETE", `/attendees/_doc/${id}`, undefined, [404]),
            es.request("DELETE", `/entitlements/_doc/${id}`, undefined, [404]),
            ...(identityCreated && identity !== null ? [es.request("DELETE", `/identities/_doc/${identity}`, undefined, [404])] : []),
          ]);
          if (duplicate) return reply.code(409).send({ error: "already_registered", message: "this account already has a profile, sign in again" });
          return reply.code(503).send({ error: "storage_unavailable", message: "could not store registration" });
        }

        const res: RegisterResponse = { attendeeId: id, token: signed.token, expiresAt: signed.expiresAt };
        try {
          opts.onRegistered?.({ name: body.name, interests: body.interests, conference: body.conference, returning: body.returning });
        } catch {
          // The demo stream must never fail a registration.
        }
        return reply.code(201).send(res);
      }),
  );

  /**
   * Self-service erasure. Deletes every per-attendee document (all keyed by the attendee ID):
   * `entitlements`, `schedules`, and last the `attendees` profile. The profile goes last so a
   * partial failure (503) can simply be retried with the same token. Missing entitlement or
   * schedule docs are fine. If the profile was already gone: 404
   * (stray schedule/entitlement docs are still cleaned). Aggregates and clusters are not
   * touched here; they drop the attendee on the next job run. Nothing here logs or returns the ID.
   */
  app.delete(routes.deleteMe.path, limitFor(DEFAULT_RATE_LIMITS.me), async (req, reply) =>
    traced("me.delete", "DELETE", routes.deleteMe.path, reply, async () => {
      const id = await requireAttendee(tokens, req, reply);
      if (id === null) return reply;
      const enc = encodeURIComponent(id);
      let profileExisted = false;
      try {
        await es.request("DELETE", `/entitlements/_doc/${enc}?refresh=wait_for`, undefined, [404]);
        await es.request("DELETE", `/schedules/_doc/${enc}?refresh=wait_for`, undefined, [404]);
        await es.request("POST", "/identities/_delete_by_query?refresh=true&conflicts=proceed", { query: { term: { attendee_id: id } } });
        const r = await es.request("DELETE", `/attendees/_doc/${enc}?refresh=wait_for`, undefined, [404]);
        profileExisted = r.status !== 404;
      } catch {
        return reply.code(503).send({ error: "storage_unavailable", message: "could not delete profile" });
      }
      if (!profileExisted) return reply.code(404).send({ error: "not_found", message: "attendee not found" });
      return reply.code(204).send();
    }),
  );

  app.get(routes.me.path, limitFor(DEFAULT_RATE_LIMITS.me), async (req, reply) =>
    traced("me", "GET", routes.me.path, reply, async () => {
      const id = await requireAttendee(tokens, req, reply);
      if (id === null) return reply;

      let doc: { found?: boolean; _source?: Omit<AttendeeDoc, "interest_vector"> } | undefined;
      try {
        const r = await es.request<typeof doc>(
          "GET",
          `/attendees/_doc/${encodeURIComponent(id)}?_source_excludes=interest_vector`,
          undefined,
          [404],
        );
        doc = r.body;
      } catch {
        return reply.code(503).send({ error: "storage_unavailable", message: "could not load profile" });
      }

      const src = doc?.found ? doc._source : undefined;
      // Unknown or expired (only when ATTENDEE_RETENTION_HOURS is set) attendee: the token no longer grants anything.
      if (!src || Date.parse(src.expires_at) <= now()) {
        return reply.code(401).send({ error: "unauthorized", message: "attendee not found" });
      }
      const res: MeResponse = {
        attendeeId: src.id,
        name: src.display_name,
        interests: src.interests,
        consent: { clusterMap: src.consent.cluster_map, qrCheckin: src.consent.qr_checkin },
        onboarded: false,
      };
      return res;
    }),
  );
};
