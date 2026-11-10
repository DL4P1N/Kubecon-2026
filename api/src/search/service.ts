import type {
  OnboardingAnswers,
  OnboardingResponse,
  ScheduleResponse,
  SearchHit,
  SearchLeg,
  SearchMode,
  SearchFacets,
  SearchResponse,
  Talk,
} from "@cc/shared";
import type { EsClient } from "../es/client.js";
import { withSpan } from "../telemetry/span.js";
import { timeSearch } from "../telemetry/metrics.js";
import {
  LEG_KEYWORD,
  LEG_SEMANTIC,
  SOURCE_FIELDS,
  TALKS_INDEX,
  buildHybridBody,
  buildKeywordBody,
  onboardingFilters,
  onboardingText,
  type EsBody,
  type SearchFilters,
} from "./queries.js";
import { DEFAULT_MAX_TALKS, buildSchedule, type ScoredTalk } from "./schedule.js";
import { facetAggs, parseFacets } from "./facets.js";
import { expiresAtFor } from "../retentionPolicy.js";

export const SCHEDULES_INDEX = "schedules";
export const ONBOARDING_RESULT_SIZE = 50;

interface EsHit {
  _id: string;
  _score: number | null;
  _source?: Record<string, unknown>;
  matched_queries?: string[] | Record<string, number>;
}
interface EsSearchResponse {
  took?: number;
  hits: { hits: EsHit[] };
  aggregations?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Map an indexed talk document to the API `Talk`. Accepts `speaker` or `speakers`. */
export function toTalk(id: string, src: Record<string, unknown>): Talk {
  const speakers = Array.isArray(src.speakers)
    ? src.speakers
        .map((s) => (typeof s === "string" ? s : str((s as { name?: unknown } | null)?.name)))
        .filter(Boolean)
        .join(", ")
    : "";
  const level = src.level;
  return {
    id: str(src.id) || id,
    title: str(src.title),
    speaker: str(src.speaker) || speakers,
    abstract: str(src.abstract),
    track: str(src.track),
    room: str(src.room),
    start: str(src.start),
    end: str(src.end),
    tags: strList(src.tags),
    ...(level === "beginner" || level === "intermediate" || level === "advanced" ? { level } : {}),
  };
}

function legsOf(hit: EsHit): SearchLeg[] | undefined {
  const mq = hit.matched_queries;
  if (!mq) return undefined;
  const names = Array.isArray(mq) ? mq : Object.keys(mq);
  const legs: SearchLeg[] = [];
  if (names.includes(LEG_KEYWORD)) legs.push("keyword");
  if (names.includes(LEG_SEMANTIC)) legs.push("semantic");
  return legs;
}

export interface RunSearchOptions {
  text: string;
  mode: SearchMode;
  size: number;
  filters?: SearchFilters;
  /** Adds track/level/day facet aggregations (GET /api/search only). */
  facets?: boolean;
}

export interface RunSearchResult {
  hits: SearchHit[];
  facets?: SearchFacets;
  tookMs: number;
  body: EsBody;
}

/** Runs one search against the talks index inside a `search` span. */
export async function runSearch(es: EsClient, opts: RunSearchOptions): Promise<RunSearchResult> {
  const built =
    opts.mode === "hybrid"
      ? buildHybridBody(opts.text, opts.size, opts.filters)
      : buildKeywordBody(opts.text, opts.size, opts.filters);
  const body = opts.facets ? { ...built, aggs: facetAggs() } : built;
  return timeSearch(opts.mode, () => withSpan("search", { "search.mode": opts.mode }, async (span) => {
    const started = Date.now();
    const call = () => es.request<EsSearchResponse>("POST", `/${TALKS_INDEX}/_search`, body);
    // In hybrid mode Elasticsearch embeds the query text itself (semantic_text
    // inference), so the `embed` span covers the whole inference-backed request.
    const res = opts.mode === "hybrid" ? await withSpan("embed", {}, call) : await call();
    const hits: SearchHit[] = res.body.hits.hits.map((h) => ({
      talk: toTalk(h._id, h._source ?? {}),
      score: h._score ?? 0,
      matched: legsOf(h),
    }));
    span.setAttribute("search.hits", hits.length);
    const facets = opts.facets ? parseFacets(res.body.aggregations) : undefined;
    return { hits, tookMs: res.body.took ?? Date.now() - started, body, ...(facets ? { facets } : {}) };
  }));
}

export async function searchTalks(
  es: EsClient,
  q: string,
  mode: SearchMode,
  size: number,
  debug: boolean,
  filters: SearchFilters = {},
): Promise<SearchResponse> {
  const r = await runSearch(es, { text: q, mode, size, filters, facets: true });
  return {
    q,
    mode,
    tookMs: r.tookMs,
    hits: r.hits,
    ...(r.facets ? { facets: r.facets } : {}),
    ...(debug ? { debug: r.body } : {}),
  };
}

export async function onboardingSearch(
  es: EsClient,
  answers: OnboardingAnswers,
  debug: boolean,
): Promise<OnboardingResponse> {
  const text = onboardingText(answers);
  const query = { text, topics: answers.topics, mode: "hybrid" as const };
  if (text === "") return { query, hits: [] };
  const r = await runSearch(es, {
    text,
    mode: "hybrid",
    size: ONBOARDING_RESULT_SIZE,
    filters: onboardingFilters(answers),
  });
  return { query, hits: r.hits, ...(debug ? { debug: r.body } : {}) };
}

/** Fetch talks by id, keeping the caller's order; unknown ids are omitted. */
export function getTalksByIds(es: EsClient, ids: string[]): Promise<Talk[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return withSpan("talks.fetch", {}, () => fetchTalksByIds(es, ids));
}

async function fetchTalksByIds(es: EsClient, ids: string[]): Promise<Talk[]> {
  const res = await es.request<EsSearchResponse>("POST", `/${TALKS_INDEX}/_search`, {
    size: ids.length,
    _source: SOURCE_FIELDS,
    query: { terms: { id: ids } },
  });
  const byId = new Map(res.body.hits.hits.map((h) => [str(h._source?.id) || h._id, toTalk(h._id, h._source ?? {})]));
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

/** `schedules` index store, one document per attendee (doc id = attendee id). */
export function createScheduleStore(es: EsClient): ScheduleStore {
  const path = (id: string) => `/${SCHEDULES_INDEX}/_doc/${encodeURIComponent(id)}`;
  return {
    async save(attendeeId, talkIds, now) {
      await es.request("PUT", `${path(attendeeId)}?refresh=wait_for`, {
        attendee_id: attendeeId,
        talk_ids: talkIds,
        updated_at: now.toISOString(),
        // Follows ATTENDEE_RETENTION_HOURS (kept by default; NO_EXPIRY sentinel).
        expires_at: expiresAtFor(now.getTime()),
      });
    },
    async load(attendeeId, now = new Date()) {
      const res = await es.request<{ found?: boolean; _source?: Record<string, unknown> }>(
        "GET",
        path(attendeeId),
        undefined,
        [404],
      );
      if (res.status === 404 || !res.body.found || !res.body._source) return undefined;
      const src = res.body._source;
      // Expired schedules are treated as missing; the real purge is a separate task.
      const expires = Date.parse(str(src.expires_at));
      if (Number.isFinite(expires) && expires <= now.getTime()) return undefined;
      return { talkIds: strList(src.talk_ids), updatedAt: str(src.updated_at) };
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
  es: EsClient,
  store: ScheduleStore,
  attendeeId: string,
  now: Date = new Date(),
): Promise<ScheduleResponse> {
  // No attributes: the attendee id must never appear on spans.
  const saved = await withSpan("schedule.load", {}, () => store.load(attendeeId, now));
  if (!saved) return { items: [], updatedAt: new Date(0).toISOString() };
  const talks = await getTalksByIds(es, saved.talkIds);
  return { items: talks.map((talk) => ({ talk })), updatedAt: saved.updatedAt };
}
