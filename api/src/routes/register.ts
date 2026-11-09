import { randomUUID } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { routes, type MeResponse, type RegisterResponse } from "@cc/shared";
import { requireAttendee, type TokenService } from "../auth/token.js";
import type { EsClient } from "../es/client.js";
import { embed as defaultEmbed } from "../es/embeddings.js";

/**
 * Module 1: registration and profile.
 *
 *   POST /api/register  (no auth, rate limited) -> attendee doc + default entitlement + token
 *   GET  /api/me        (Bearer token)          -> profile
 *
 * Privacy rules (design doc sections 5 and 6):
 * - Only display name, interests and consent flags are stored. Email is
 *   accepted for contract compatibility but never stored. Unknown fields are
 *   dropped, so no health, politics or identity data can reach ES.
 * - Attendee data expires 24h after registration (`expires_at`).
 * - The attendee ID is never logged and never put on a span. ES error
 *   messages contain the doc path (and so the ID), so they are not recorded
 *   on spans or returned to clients either.
 */

export const ATTENDEE_RETENTION_MS = 24 * 60 * 60 * 1000;
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
  consent: z.object({
    clusterMap: z.boolean(),
    qrCheckin: z.boolean(),
  }),
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
  /** Per client IP per minute. Default 60. */
  rateLimitPerMinute?: number;
  now?: () => number;
}

const tracer = () => trace.getTracer("companion-api");

/** Only allowlisted attributes (docs/telemetry-allowlist.md). */
function endSpan(span: Span, method: string, path: string, status: number) {
  span.setAttributes({
    "http.request.method": method,
    "url.path": path,
    "http.response.status_code": status,
    "db.system": "elasticsearch",
  });
  if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR, message: "storage_error" });
  span.end();
}

export const registerRoutes: FastifyPluginAsync<RegisterRoutesOptions> = async (app, opts) => {
  const { es, tokens } = opts;
  const embedText = opts.embed ?? defaultEmbed;
  const now = opts.now ?? Date.now;

  // Scoped to this plugin: only routes that opt in via config.rateLimit are limited.
  // Behind an ingress, set Fastify `trustProxy` so req.ip is the client, not the proxy.
  await app.register(rateLimit, { global: false });

  app.post(
    routes.register.path,
    {
      config: {
        rateLimit: { max: opts.rateLimitPerMinute ?? 60, timeWindow: "1 minute" },
      },
    },
    async (req, reply) =>
      tracer().startActiveSpan("register", async (span) => {
        const parsed = registerBodySchema.safeParse(req.body);
        if (!parsed.success) {
          endSpan(span, "POST", routes.register.path, 400);
          return reply.code(400).send({
            error: "invalid_request",
            // Field paths and messages only; never echo submitted values.
            message: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
          });
        }
        const body = parsed.data;
        const id = randomUUID();
        const t = now();
        const createdAt = new Date(t).toISOString();
        const expiresAt = new Date(t + ATTENDEE_RETENTION_MS).toISOString();

        try {
          // The vector only feeds the cluster map; if the embedder (ES inference)
          // is down, register anyway without it rather than block sign-up.
          const interestVector = await embedText(body.interests.join(", ")).catch(() => undefined);
          const attendee: AttendeeDoc = {
            id,
            display_name: body.name,
            interests: body.interests,
            ...(interestVector ? { interest_vector: interestVector } : {}),
            consent: { cluster_map: body.consent.clusterMap, qr_checkin: body.consent.qrCheckin },
            created_at: createdAt,
            expires_at: expiresAt,
          };
          await es.request("PUT", `/attendees/_create/${id}?refresh=wait_for`, attendee);

          const entitlement: EntitlementDoc = {
            attendee_id: id,
            pass_type: DEFAULT_PASS_TYPE,
            rooms: [ALL_ROOMS],
            updated_at: createdAt,
            expires_at: expiresAt,
          };
          await es.request("PUT", `/entitlements/_doc/${id}?refresh=wait_for`, entitlement);
        } catch {
          // Deliberately not logging the error: it contains the doc path.
          endSpan(span, "POST", routes.register.path, 503);
          return reply.code(503).send({ error: "storage_unavailable", message: "could not store registration" });
        }

        const signed = await tokens.sign(id);
        const res: RegisterResponse = { attendeeId: id, token: signed.token, expiresAt: signed.expiresAt };
        endSpan(span, "POST", routes.register.path, 201);
        return reply.code(201).send(res);
      }),
  );

  app.get(routes.me.path, async (req, reply) => {
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
    // Unknown or expired (24h retention) attendee: the token no longer grants anything.
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
  });
};
