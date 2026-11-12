import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  routes,
  type OnboardingAnswers,
  type OnboardingRequest,
  type OnboardingResponse,
  type SaveScheduleRequest,
  type ScheduleResponse,
  type SearchMode,
  type SearchResponse,
} from "@cc/shared";
import { z } from "zod";
import { requireAttendee, type TokenService } from "../auth/token.js";
import { applyRateLimit, limitFor, resolveRateLimits, sendIfRateLimited, type RateLimitPolicy } from "../http/rateLimit.js";
import { createCalendar } from "../calendar/ical.js";
import { isDbUnavailable, type Db } from "../db/client.js";
import type { Embedder } from "../embed/embedder.js";
import { RETRY_AFTER_SECONDS, isDbError, sendDbError } from "../search/errors.js";
import type { StatusTracker } from "../status/tracker.js";
import { withSpan } from "../telemetry/span.js";
import { onboardingText } from "../search/queries.js";
import { parseSearchFilters } from "../search/facets.js";
import { DEFAULT_MAX_TALKS, type ScoredTalk } from "../search/schedule.js";
import {
  buildAndSaveSchedule,
  createScheduleStore,
  getTalksByIds,
  loadSchedule,
  onboardingSearch,
  searchTalks,
  type ScheduleStore,
} from "../search/service.js";

export const MAX_QUERY_LENGTH = 500;
export const DEFAULT_SIZE = 10;
export const MAX_SIZE = 50;
export { RETRY_AFTER_SECONDS };
const MAX_SCHEDULE_IDS = 100;
export const MAX_ANSWER_ITEMS = 20;
export const MAX_ANSWER_ITEM_LENGTH = 100;
/** Matches the onboarding textarea's maxLength; only the first MAX_QUERY_LENGTH chars are searched. */
export const MAX_FREE_TEXT_LENGTH = 1000;
/**
 * Most raw topic/goal entries accepted. The catalog returns at most 1000 tags, so the web UI
 * can never send more; anything above gets a clean 400 (only the first 20 are used).
 */
export const MAX_RAW_ANSWER_ITEMS = 1000;
/**
 * Body cap for onboarding and schedule. Sized above the zod caps (1000 tags x 100 chars, plus
 * goals and free text, is about 105 KiB of JSON) so the zod checks answer first with a 400;
 * only bodies no valid client could send get the 413.
 */
export const BODY_LIMIT_BYTES = 256 * 1024;

/**
 * Resolves the attendee for a schedule request. Returns the attendee id, or
 * null after it has already sent a 401. Never logs or spans the id.
 */
export type AttendeeResolver = (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>;

export interface SearchRouteDeps {
  db: Db;
  /** Embeds query text for the semantic leg of hybrid search. */
  embedder: Embedder;
  /** Verifies signed attendee session tokens (auth/token.ts). Required for the schedule routes. */
  tokens?: TokenService;
  /** Test seam: overrides token verification. Production uses `tokenResolver(tokens)`. */
  resolveAttendee?: AttendeeResolver;
  scheduleStore?: ScheduleStore;
  now?: () => Date;
  /** Records search outcomes for GET /api/status (counts and timings only). */
  tracker?: StatusTracker;
  /** Per-IP limits; defaults to DEFAULT_RATE_LIMITS (http/rateLimit.ts). */
  rateLimits?: Partial<RateLimitPolicy>;
}

/** Attendee from a valid signed `Authorization: Bearer <token>`; 401 otherwise. */
export function tokenResolver(tokens: TokenService): AttendeeResolver {
  return (req, reply) => requireAttendee(tokens, req, reply);
}

/** Fail closed: without a token service no request is attributed to any attendee. */
const rejectAll: AttendeeResolver = async (_req, reply) => {
  await reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized", message: "missing bearer token" });
  return null;
};

function bad(message: string) {
  return { error: "invalid_request", message };
}

const iso = (field: string) =>
  z.string({ error: `${field} must be ISO 8601` }).refine((v) => Number.isFinite(Date.parse(v)), `${field} must be ISO 8601`);
const answerList = (field: string) =>
  z
    .array(
      z
        .string({ error: `${field} must be an array of strings` })
        .max(MAX_ANSWER_ITEM_LENGTH, `${field} entries must be at most ${MAX_ANSWER_ITEM_LENGTH} characters`),
      { error: `${field} must be an array of strings` },
    )
    .max(MAX_RAW_ANSWER_ITEMS, `${field} must have at most ${MAX_RAW_ANSWER_ITEMS} entries`)
    // The web UI lets attendees tick any number of catalog tags: keep the first 20 rather
    // than failing the request.
    .transform((list) => list.slice(0, MAX_ANSWER_ITEMS));

export const answersSchema = z.object(
  {
    topics: answerList("answers.topics"),
    experience: z
      .enum(["beginner", "intermediate", "advanced"], { error: "answers.experience must be beginner, intermediate or advanced" })
      .default("intermediate"),
    goals: answerList("answers.goals").default([]),
    freeText: z
      .string({ error: "answers.freeText must be a string" })
      .max(MAX_FREE_TEXT_LENGTH, `answers.freeText must be at most ${MAX_FREE_TEXT_LENGTH} characters`)
      .optional(),
    availableFrom: iso("answers.availableFrom").optional(),
    availableTo: iso("answers.availableTo").optional(),
  },
  { error: "answers.topics is required" },
);

/** Validates onboarding answers; returns an error message (never the submitted values) or the cleaned answers. */
export function parseAnswers(raw: unknown): { error: string } | { answers: OnboardingAnswers } {
  const parsed = answersSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const missingTopics = issue.path.length === 1 && issue.path[0] === "topics" && issue.code === "invalid_type";
    return { error: missingTopics ? "answers.topics is required" : issue.message };
  }
  const a = parsed.data;
  return { answers: { ...a, freeText: a.freeText?.slice(0, MAX_QUERY_LENGTH) } };
}

/** Registers search, onboarding and schedule routes in their own plugin scope (own error handler). */
export function registerSearchRoutes(root: FastifyInstance, deps: SearchRouteDeps): void {
  root.register(async (app) => {
    await applyRateLimit(app);
    addRoutes(app, deps);
  });
}

function addRoutes(app: FastifyInstance, deps: SearchRouteDeps): void {
  const { db, embedder } = deps;
  const resolveAttendee = deps.resolveAttendee ?? (deps.tokens ? tokenResolver(deps.tokens) : rejectAll);
  const store = deps.scheduleStore ?? createScheduleStore(db);
  const now = deps.now ?? (() => new Date());
  const limits = resolveRateLimits(deps.rateLimits);

  /** Runs a search and tells the status tracker how it went (never what it was). */
  async function observed<T>(mode: SearchMode, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const out = await fn();
      deps.tracker?.recordSearch(mode, performance.now() - start, "ok");
      return out;
    } catch (err) {
      deps.tracker?.recordSearch(mode, performance.now() - start, isDbUnavailable(err) ? "overloaded" : "error");
      throw err;
    }
  }

  app.setErrorHandler((err: Error, req, reply) => {
    if (sendIfRateLimited(err, reply)) return reply;
    if (sendDbError(err, req, reply)) return reply;
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413) return reply.code(413).send({ error: "payload_too_large", message: "request body too large" });
    if (status && status >= 400 && status < 500) {
      // Fastify's own 4xx (e.g. malformed JSON); its messages do not include the body.
      return reply.code(status).send({ error: "invalid_request", message: err.message });
    }
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get<{ Querystring: { q?: string; mode?: string; debug?: string; size?: string } & Record<string, unknown> }>(
    routes.search.path,
    limitFor(limits.search),
    async (req, reply): Promise<SearchResponse | void> => {
      // A repeated query param (`?q=a&q=b`) is parsed into an array: reject it with 400.
      const rawQ: unknown = req.query.q ?? "";
      if (typeof rawQ !== "string") return reply.code(400).send(bad("q must be a single string"));
      const q = rawQ.trim();
      const mode = (req.query.mode ?? "hybrid") as SearchMode;
      if (mode !== "hybrid" && mode !== "keyword") return reply.code(400).send(bad("mode must be hybrid or keyword"));
      if (q === "") return reply.code(400).send(bad("q is required"));
      if (q.length > MAX_QUERY_LENGTH) return reply.code(400).send(bad(`q must be at most ${MAX_QUERY_LENGTH} characters`));
      const size = req.query.size === undefined ? DEFAULT_SIZE : Number(req.query.size);
      if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
        return reply.code(400).send(bad(`size must be an integer from 1 to ${MAX_SIZE}`));
      }
      const parsedFilters = parseSearchFilters(req.query);
      if ("error" in parsedFilters) return reply.code(400).send(bad(parsedFilters.error));
      return observed(mode, () => searchTalks(db, embedder, q, mode, size, req.query.debug === "1", parsedFilters.filters));
    },
  );

  app.post<{ Body: OnboardingRequest; Querystring: { debug?: string } }>(
    routes.onboarding.path,
    { ...limitFor(limits.onboarding), bodyLimit: BODY_LIMIT_BYTES },
    async (req, reply): Promise<OnboardingResponse | void> => {
      const parsed = parseAnswers(req.body?.answers);
      if ("error" in parsed) return reply.code(400).send(bad(parsed.error));
      const run = () => onboardingSearch(db, embedder, parsed.answers, req.query.debug === "1");
      // An empty answer set returns without querying the database, so it says nothing about hybrid health.
      return onboardingText(parsed.answers) === "" ? run() : observed("hybrid", run);
    },
  );

  /**
   * Request-level span for the schedule routes, so rejected (401/400) requests
   * are traced too. Allowlisted attributes only: never the attendee id.
   */
  const scheduleSpan = <T>(name: string, method: string, path: string, reply: FastifyReply, fn: () => Promise<T>) =>
    withSpan(name, { "http.request.method": method, "http.route": path }, async (span) => {
      try {
        const out = await fn();
        span.setAttribute("http.response.status_code", reply.statusCode);
        return out;
      } catch (err) {
        span.setAttribute("http.response.status_code", isDbError(err) ? 502 : 500);
        throw err;
      }
    });

  app.post<{ Body: SaveScheduleRequest }>(routes.saveSchedule.path, { ...limitFor(limits.schedule), bodyLimit: BODY_LIMIT_BYTES }, async (req, reply) =>
    scheduleSpan("schedule.save", "POST", routes.saveSchedule.path, reply, async (): Promise<ScheduleResponse | void> => {
      // Authenticate before validating, so callers without a session learn nothing else.
      const attendeeId = await resolveAttendee(req, reply);
      if (attendeeId === null) return reply;

      const body = req.body ?? {};
      const maxTalks = body.maxTalks === undefined ? DEFAULT_MAX_TALKS : body.maxTalks;
      if (!Number.isInteger(maxTalks) || maxTalks < 1 || maxTalks > 50) {
        return reply.code(400).send(bad("maxTalks must be an integer from 1 to 50"));
      }
      const opts = { attendeeId, store, now: now(), maxTalks };

      if (body.answers !== undefined) {
        const parsed = parseAnswers(body.answers);
        if ("error" in parsed) return reply.code(400).send(bad(parsed.error));
        const res = await onboardingSearch(db, embedder, parsed.answers, false);
        const candidates: ScoredTalk[] = (res.hits ?? []).map((h) => ({ talk: h.talk, score: h.score, matched: h.matched }));
        return buildAndSaveSchedule(candidates, [], opts);
      }

      const ids = body.talkIds;
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string") || ids.length > MAX_SCHEDULE_IDS) {
        return reply.code(400).send(bad(`talkIds (array of up to ${MAX_SCHEDULE_IDS} strings) or answers is required`));
      }
      const talks = await getTalksByIds(db, ids);
      const known = new Set(talks.map((t) => t.id));
      const unknown = ids.filter((i) => !known.has(i));
      // Caller order is priority order: earlier ids win conflicts.
      const candidates: ScoredTalk[] = talks.map((talk, i) => ({ talk, score: talks.length - i }));
      return buildAndSaveSchedule(candidates, unknown, opts);
    }),
  );

  app.get(routes.getSchedule.path, limitFor(limits.schedule), async (req, reply) =>
    scheduleSpan("schedule.get", "GET", routes.getSchedule.path, reply, async (): Promise<ScheduleResponse | void> => {
      const attendeeId = await resolveAttendee(req, reply);
      if (attendeeId === null) return reply;
      return loadSchedule(db, store, attendeeId, now());
    }),
  );

  app.get<{ Querystring: { talkId?: string } }>(routes.exportCalendar.path, limitFor(limits.schedule), async (req, reply) =>
    scheduleSpan("schedule.export", "GET", routes.exportCalendar.path, reply, async () => {
      reply.header("Cache-Control", "private, no-store");
      const attendeeId = await resolveAttendee(req, reply);
      if (attendeeId === null) return reply;
      const talkId: unknown = req.query.talkId;
      if (talkId !== undefined && (typeof talkId !== "string" || talkId.length < 1 || talkId.length > 200)) {
        return reply.code(400).send(bad("talkId must be a single string of 1 to 200 characters"));
      }
      const at = now();
      const schedule = await loadSchedule(db, store, attendeeId, at);
      const talks = schedule.items.map((item) => item.talk).filter((talk) => talkId === undefined || talk.id === talkId);
      if (talkId !== undefined && talks.length === 0) return reply.code(404).send({ error: "talk_not_in_schedule" });
      return reply.type("text/calendar; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="conference-schedule.ics"')
        .send(createCalendar(talks, at));
    }),
  );
}
