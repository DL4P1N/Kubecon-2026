import {
  type OnboardingAnswers,
  type OnboardingResponse,
  type ScheduleResponse,
  type SearchHit,
  type SearchLeg,
  type SearchMode,
  type SearchFacets,
  type SearchResponse,
  type Talk,
} from "@cc/shared";
import { vectorLiteral, type Db } from "../db/client.js";
import type { Embedder } from "../embed/embedder.js";
import { withSpan } from "../telemetry/span.js";
import { timeSearch } from "../telemetry/metrics.js";
import {
  TALK_COLUMNS,
  buildHybridPlan,
  buildKeywordPlan,
  expandedText,
  onboardingFilters,
  onboardingText,
  DEFAULT_TUNING,
  type SearchFilters,
  type SearchPlan,
  type SearchTuning,
} from "./queries.js";
import { DEFAULT_MAX_TALKS, buildSchedule, type ScoredTalk } from "./schedule.js";
import { facetQuery, parseFacets, type FacetRow } from "./facets.js";
import { runQuery } from "./errors.js";
import { expiresAtFor } from "../retentionPolicy.js";

export const ONBOARDING_RESULT_SIZE = 50;

/** A `talks` row as the driver returns it (timestamptz arrive as Date; strings are accepted too). */
export interface TalkRow {
  id: string;
  title: string;
  abstract: string | null;
  speaker: string | null;
  track: string | null;
  level: string | null;
  room: string | null;
  start_at: Date | string | null;
  end_at: Date | string | null;
  tags: string[] | null;
}

const iso = (v: Date | string | null | undefined): string => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString();
  if (typeof v === "string") return v;
  return "";
};

/** Map a `talks` row to the API `Talk` (`start_at`/`end_at` become ISO `start`/`end`). */
export function toTalk(row: TalkRow): Talk {
  const level = row.level;
  return {
    id: row.id,
    title: row.title,
    speaker: row.speaker ?? "",
    abstract: row.abstract ?? "",
    track: row.track ?? "",
    room: row.room ?? "",
    start: iso(row.start_at),
    end: iso(row.end_at),
    tags: Array.isArray(row.tags) ? row.tags : [],
    ...(level === "beginner" || level === "intermediate" || level === "advanced" ? { level } : {}),
  };
}

interface HitRow extends TalkRow {
  score: number | string;
  in_keyword: boolean;
  in_semantic: boolean;
}

function legsOf(row: HitRow): SearchLeg[] {
  const legs: SearchLeg[] = [];
  if (row.in_keyword) legs.push("keyword");
  if (row.in_semantic) legs.push("semantic");
  return legs;
}

export interface RunSearchOptions {
  text: string;
  mode: SearchMode;
  size: number;
  filters?: SearchFilters;
  /** Adds track/level/day facet counts (GET /api/search only). */
  facets?: boolean;
  /** Ranking knobs; production always uses DEFAULT_TUNING, the offline eval passes variants. */
  tuning?: SearchTuning;
}

/** What `?debug=1` returns: the engine, mode and parameter count. Never SQL text, parameter values or query text. */
export interface SearchDebug {
  engine: "postgres";
  mode: SearchMode;
  paramCount: number;
}

export interface RunSearchResult {
  hits: SearchHit[];
  facets?: SearchFacets;
  tookMs: number;
  debug: SearchDebug;
}

/** Runs one search against the talks table inside a `search` span. */
export async function runSearch(db: Db, embedder: Embedder, opts: RunSearchOptions): Promise<RunSearchResult> {
  return timeSearch(opts.mode, () => withSpan("search", { "search.mode": opts.mode }, async (span) => {
    const started = Date.now();
    const tuning = opts.tuning ?? DEFAULT_TUNING;
    let plan: SearchPlan;
    if (opts.mode === "hybrid") {
      // Same expanded text for both legs: the keyword leg ranks it, the semantic leg embeds it.
      const vector = await withSpan("embed", {}, () => embedder.embed(expandedText(opts.text, tuning), "query"));
      plan = buildHybridPlan(opts.text, vectorLiteral(vector), opts.size, opts.filters, tuning);
    } else {
      plan = buildKeywordPlan(opts.text, opts.size, opts.filters, tuning);
    }
    const facetSql = opts.facets ? facetQuery(plan) : undefined;
    const [rows, facetRows] = await Promise.all([
      runQuery<HitRow>(db, plan.hits.text, plan.hits.params),
      facetSql ? runQuery<FacetRow>(db, facetSql.text, facetSql.params) : Promise.resolve(undefined),
    ]);
    const hits: SearchHit[] = rows.map((r) => ({ talk: toTalk(r), score: Number(r.score), matched: legsOf(r) }));
    span.setAttribute("search.hits", hits.length);
    return {
      hits,
      tookMs: Date.now() - started,
      debug: { engine: "postgres" as const, mode: opts.mode, paramCount: plan.hits.params.length },
      ...(facetRows ? { facets: parseFacets(facetRows) } : {}),
    };
  }));
}

export async function searchTalks(
  db: Db,
  embedder: Embedder,
  q: string,
  mode: SearchMode,
  size: number,
  debug: boolean,
  filters: SearchFilters = {},
): Promise<SearchResponse> {
  const r = await runSearch(db, embedder, { text: q, mode, size, filters, facets: true });
  return {
    q,
    mode,
    tookMs: r.tookMs,
    hits: r.hits,
    ...(r.facets ? { facets: r.facets } : {}),
    ...(debug ? { debug: r.debug } : {}),
  };
}

export async function onboardingSearch(
  db: Db,
  embedder: Embedder,
  answers: OnboardingAnswers,
  debug: boolean,
): Promise<OnboardingResponse> {
  const text = onboardingText(answers);
  const query = { text, topics: answers.topics, mode: "hybrid" as const };
  if (text === "") return { query, hits: [] };
  const r = await runSearch(db, embedder, {
    text,
    mode: "hybrid",
    size: ONBOARDING_RESULT_SIZE,
    filters: onboardingFilters(answers),
  });
  return { query, hits: r.hits, ...(debug ? { debug: r.debug } : {}) };
}

/** Fetch talks by id, keeping the caller's order; unknown ids are omitted. */
export function getTalksByIds(db: Db, ids: string[]): Promise<Talk[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return withSpan("talks.fetch", {}, () => fetchTalksByIds(db, ids));
}

async function fetchTalksByIds(db: Db, ids: string[]): Promise<Talk[]> {
  const rows = await runQuery<TalkRow>(db, `select ${TALK_COLUMNS} from talks where id = any($1::text[])`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, toTalk(r)]));
  return ids.flatMap((id) => {
    const t = byId.get(id);
    return t ? [t] : [];
  });
}

export interface ScheduleStore {
  save(attendeeId: string, talkIds: string[], now: Date): Promise<void>;
  /** Returns undefined when nothing is saved or the saved schedule has expired. */
  load(attendeeId: string, now?: Date): Promise<{ talkIds: string[]; updatedAt: string } | undefined>;
}

/** `schedules` table store, one row per attendee. */
export function createScheduleStore(db: Db): ScheduleStore {
  return {
    async save(attendeeId, talkIds, now) {
      await runQuery(
        db,
        `insert into schedules (attendee_id, talk_ids, updated_at, expires_at)
         values ($1, $2::text[], $3::timestamptz, $4::timestamptz)
         on conflict (attendee_id) do update set
           talk_ids = excluded.talk_ids, updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
        // expires_at follows ATTENDEE_RETENTION_HOURS (kept by default; NO_EXPIRY sentinel).
        [attendeeId, talkIds, now.toISOString(), expiresAtFor(now.getTime())],
      );
    },
    async load(attendeeId, now = new Date()) {
      const [row] = await runQuery<{ talk_ids: string[] | null; updated_at: Date | string; expires_at: Date | string }>(
        db,
        "select talk_ids, updated_at, expires_at from schedules where attendee_id = $1",
        [attendeeId],
      );
      if (!row) return undefined;
      // Expired schedules are treated as missing; the real purge is the retention job.
      const expires = Date.parse(iso(row.expires_at));
      if (Number.isFinite(expires) && expires <= now.getTime()) return undefined;
      return { talkIds: row.talk_ids ?? [], updatedAt: iso(row.updated_at) };
    },
  };
}

export interface BuildAndSaveOptions {
  attendeeId: string;
  store: ScheduleStore;
  now?: Date;
  maxTalks?: number;
}

/**
 * Build an overlap-free schedule from ranked candidates and persist it. Wrapped
 * in a `schedule.build` span.
 */
export async function buildAndSaveSchedule(
  candidates: ScoredTalk[],
  extraDropped: string[],
  opts: BuildAndSaveOptions,
): Promise<ScheduleResponse> {
  const now = opts.now ?? new Date();
  const { chosen, dropped, skipped } = await withSpan("schedule.build", {}, async () =>
    buildSchedule(candidates, opts.maxTalks ?? DEFAULT_MAX_TALKS),
  );
  await opts.store.save(
    opts.attendeeId,
    chosen.map((c) => c.talk.id),
    now,
  );
  const allDropped = [...extraDropped, ...dropped];
  return {
    items: chosen.map((c) => ({ talk: c.talk, reason: reasonFor(c) })),
    updatedAt: now.toISOString(),
    ...(allDropped.length > 0 ? { droppedTalkIds: allDropped } : {}),
    ...(skipped.length > 0
      ? { skipped: skipped.map((s) => ({ talkId: s.talk.id, conflictsWith: s.conflictsWith, talk: s.talk })) }
      : {}),
  };
}

function reasonFor(c: ScoredTalk): string | undefined {
  return c.matched && c.matched.length > 0 ? `Matched ${c.matched.join(" + ")}` : undefined;
}

export async function loadSchedule(
  db: Db,
  store: ScheduleStore,
  attendeeId: string,
  now: Date = new Date(),
): Promise<ScheduleResponse> {
  // No attributes: the attendee id must never appear on spans.
  const saved = await withSpan("schedule.load", {}, () => store.load(attendeeId, now));
  if (!saved) return { items: [], updatedAt: new Date(0).toISOString() };
  const talks = await getTalksByIds(db, saved.talkIds);
  return { items: talks.map((talk) => ({ talk })), updatedAt: saved.updatedAt };
}
