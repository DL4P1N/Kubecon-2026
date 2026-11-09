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
import { requireAttendee, type TokenService } from "../auth/token.js";
import { EsError, isEsOverload, type EsClient } from "../es/client.js";
import type { StatusTracker } from "../status/tracker.js";
import { withSpan } from "../telemetry/span.js";
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
/** Seconds clients should wait before retrying after an Elasticsearch overload (503). */
export const RETRY_AFTER_SECONDS = 5;
const MAX_SCHEDULE_IDS = 100;
const LEVELS = new Set(["beginner", "intermediate", "advanced"]);

/**
 * Resolves the attendee for a schedule request. Returns the attendee id, or
 * null after it has already sent a 401. Never logs or spans the id.
 */
export type AttendeeResolver = (req: FastifyRequest, reply: FastifyReply) => Promise<string | null>;

export interface SearchRouteDeps {
  es: EsClient;
  /** Verifies signed attendee session tokens (auth/token.ts). Required for the schedule routes. */
  tokens?: TokenService;
  /** Test seam: overrides token verification. Production uses `tokenResolver(tokens)`. */
  resolveAttendee?: AttendeeResolver;
  scheduleStore?: ScheduleStore;
  now?: () => Date;
  /** Records search outcomes for GET /api/status (counts and timings only). */
  tracker?: StatusTracker;
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

function isIso(v: unknown): v is string {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

/** Validates onboarding answers; returns an error message or the cleaned answers. */
export function parseAnswers(raw: unknown): { error: string } | { answers: OnboardingAnswers } {
  const a = raw as Partial<OnboardingAnswers> | undefined;
  if (!a || typeof a !== "object" || !Array.isArray(a.topics) || !a.topics.every((t) => typeof t === "string")) {
    return { error: "answers.topics is required" };
  }
  if (a.experience !== undefined && !LEVELS.has(a.experience)) {
    return { error: "answers.experience must be beginner, intermediate or advanced" };
  }
  if (a.goals !== undefined && (!Array.isArray(a.goals) || !a.goals.every((g) => typeof g === "string"))) {
    return { error: "answers.goals must be an array of strings" };
  }
  if (a.freeText !== undefined && typeof a.freeText !== "string") return { error: "answers.freeText must be a string" };
  if (a.availableFrom !== undefined && !isIso(a.availableFrom)) return { error: "answers.availableFrom must be ISO 8601" };
  if (a.availableTo !== undefined && !isIso(a.availableTo)) return { error: "answers.availableTo must be ISO 8601" };
  const answers: OnboardingAnswers = {
    topics: a.topics.slice(0, 20),
    experience: a.experience ?? "intermediate",
    goals: (a.goals ?? []).slice(0, 20),
    freeText: a.freeText?.slice(0, MAX_QUERY_LENGTH),
    availableFrom: a.availableFrom,
    availableTo: a.availableTo,
  };
  return { answers };
}

/** Registers search, onboarding and schedule routes in their own plugin scope (own error handler). */
export function registerSearchRoutes(root: FastifyInstance, deps: SearchRouteDeps): void {
  root.register(async (app) => addRoutes(app, deps));
}

function addRoutes(app: FastifyInstance, deps: SearchRouteDeps): void {
  const { es } = deps;
  const resolveAttendee = deps.resolveAttendee ?? (deps.tokens ? tokenResolver(deps.tokens) : rejectAll);
  const store = deps.scheduleStore ?? createScheduleStore(es);
  const now = deps.now ?? (() => new Date());

  /** Runs a search and tells the status tracker how it went (never what it was). */
  async function observed<T>(mode: SearchMode, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const out = await fn();
      deps.tracker?.recordSearch(mode, performance.now() - start, "ok");
      return out;
    } catch (err) {
      deps.tracker?.recordSearch(mode, performance.now() - start, err instanceof EsError && isEsOverload(err) ? "overloaded" : "error");
      throw err;
    }
  }

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof EsError) {
      const overloaded = isEsOverload(err);
      // One diagnostic line with the ES error type and status only. Never the
      // message/body (can contain query text), the URL query, attendee ids or credentials.
      // Attributes are limited to allowlisted keys (error.type, http.route); the numeric
      // ES status goes in the message text so no new attribute is needed.
      req.log.warn(
        { "error.type": err.errorType, "http.route": req.routeOptions?.url },
        `elasticsearch request failed with status ${err.status}${overloaded ? " (overloaded)" : ""}`,
      );
      // Do not echo ES error bodies to clients; they can contain query text.
      if (overloaded) {
        return reply
          .code(503)
          .header("Retry-After", String(RETRY_AFTER_SECONDS))
          .send({ error: "search_overloaded" });
      }
      return reply.code(502).send({ error: "search_unavailable" });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "invalid_request", message: err.message });
    }
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get<{ Querystring: { q?: string; mode?: string; debug?: string; size?: string } }>(
    routes.search.path,
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
      return observed(mode, () => searchTalks(es, q, mode, size, req.query.debug === "1"));
    },
  );

  app.post<{ Body: OnboardingRequest; Querystring: { debug?: string } }>(
    routes.onboarding.path,
    async (req, reply): Promise<OnboardingResponse | void> => {
      const parsed = parseAnswers(req.body?.answers);
      if ("error" in parsed) return reply.code(400).send(bad(parsed.error));
      return observed("hybrid", () => onboardingSearch(es, parsed.answers, req.query.debug === "1"));
    },
  );

  /**
   * Request-level span for the schedule routes, so rejected (401/400) requests
   * are traced too. Allowlisted attributes only: never the attendee id.
   */
  const scheduleSpan = <T>(name: string, method: string, path: string, reply: FastifyReply, fn: () => Promise<T>) =>
    withSpan(name, { "http.request.method": method, "url.path": path }, async (span) => {
      try {
        const out = await fn();
        span.setAttribute("http.response.status_code", reply.statusCode);
        return out;
      } catch (err) {
        span.setAttribute("http.response.status_code", err instanceof EsError ? 502 : 500);
        throw err;
      }
    });

  app.post<{ Body: SaveScheduleRequest }>(routes.saveSchedule.path, async (req, reply) =>
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
        const res = await onboardingSearch(es, parsed.answers, false);
        const candidates: ScoredTalk[] = (res.hits ?? []).map((h) => ({ talk: h.talk, score: h.score, matched: h.matched }));
        return buildAndSaveSchedule(candidates, [], opts);
      }

      const ids = body.talkIds;
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === "string") || ids.length > MAX_SCHEDULE_IDS) {
        return reply.code(400).send(bad(`talkIds (array of up to ${MAX_SCHEDULE_IDS} strings) or answers is required`));
      }
      const talks = await getTalksByIds(es, ids);
      const known = new Set(talks.map((t) => t.id));
      const unknown = ids.filter((i) => !known.has(i));
      // Caller order is priority order: earlier ids win conflicts.
      const candidates: ScoredTalk[] = talks.map((talk, i) => ({ talk, score: talks.length - i }));
      return buildAndSaveSchedule(candidates, unknown, opts);
    }),
  );

  app.get(routes.getSchedule.path, async (req, reply) =>
    scheduleSpan("schedule.get", "GET", routes.getSchedule.path, reply, async (): Promise<ScheduleResponse | void> => {
      const attendeeId = await resolveAttendee(req, reply);
      if (attendeeId === null) return reply;
      return loadSchedule(es, store, attendeeId, now());
    }),
  );
}
