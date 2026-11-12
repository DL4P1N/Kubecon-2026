import { z } from "zod";
import {
  EVENT_UTC_OFFSET,
  SEARCH_FILTER_LIMITS,
  type FacetBucket,
  type SearchFacets,
} from "@cc/shared";
import type { SearchFilters, SearchPlan, SqlQuery } from "./queries.js";

/**
 * Facet counts for GET /api/search (task #54): GROUP BY queries over the
 * candidate talks of one search (see SearchPlan.withClause).
 */

export const TRACK_FACET_SIZE = 30;
export const LEVEL_FACET_SIZE = 5;

/**
 * One statement counting the plan's candidates by track, level and local
 * conference day (talk start shifted by EVENT_UTC_OFFSET, computed on the UTC
 * wall clock so it does not depend on the session time zone).
 */
export function facetQuery(plan: SearchPlan): SqlQuery {
  const offset = `$${plan.params.length + 1}::interval`;
  const text =
    `${plan.withClause} ` +
    `select 'track' as facet, t.track as value, count(*)::int as n from cand join talks t on t.id = cand.id where t.track <> '' group by t.track ` +
    `union all select 'level', t.level, count(*)::int from cand join talks t on t.id = cand.id where t.level is not null group by t.level ` +
    `union all select 'day', to_char((t.start_at at time zone 'UTC') + ${offset}, 'YYYY-MM-DD'), count(*)::int ` +
    `from cand join talks t on t.id = cand.id where t.start_at is not null group by 2`;
  return { text, params: [...plan.params, EVENT_UTC_OFFSET] };
}

export interface FacetRow {
  facet: string;
  value: string | null;
  n: number | string;
}

/** Most talks first, ties by value; the day facet is chronological. */
function bucketsOf(rows: FacetRow[], facet: string, limit: number, chronological = false): FacetBucket[] {
  const out = rows
    .filter((r) => r.facet === facet && typeof r.value === "string" && r.value !== "" && Number(r.n) > 0)
    .map((r) => ({ value: r.value as string, count: Number(r.n) }));
  out.sort(chronological ? (a, b) => a.value.localeCompare(b.value) : (a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return out.slice(0, limit);
}

/** Facets from the rows of `facetQuery`. */
export function parseFacets(rows: FacetRow[]): SearchFacets {
  return {
    track: bucketsOf(rows, "track", TRACK_FACET_SIZE),
    level: bucketsOf(rows, "level", LEVEL_FACET_SIZE),
    day: bucketsOf(rows, "day", Number.MAX_SAFE_INTEGER, true),
  };
}

// ---------------------------------------------------------------- request validation

/** A query param given once (string) or repeated (array), as an array of at most `max` items. */
const many = <T extends z.ZodTypeAny>(schema: T, max: number, label: string) =>
  z.preprocess((v) => (Array.isArray(v) ? v : [v]), z.array(schema).max(max, `at most ${max} ${label}`));

const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "day must be YYYY-MM-DD")
  .refine((d) => {
    const t = Date.parse(`${d}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().startsWith(d);
  }, "day must be a valid date");

const isoDateTime = z.iso.datetime({ offset: true, message: "must be an ISO 8601 datetime" });

/** Query-string filters. `level`/`track` arrive as a string or (when repeated) an array. */
export const searchFiltersSchema = z
  .object({
    day: isoDay.optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    level: many(z.enum(["beginner", "intermediate", "advanced"]), 3, "levels").optional(),
    track: many(
      z.string().trim().min(1, "track must not be empty").max(SEARCH_FILTER_LIMITS.maxTrackLength),
      SEARCH_FILTER_LIMITS.maxTracks,
      "tracks",
    ).optional(),
  })
  .refine((f) => !f.from || !f.to || Date.parse(f.from) <= Date.parse(f.to), {
    message: "from must not be after to",
    path: ["from"],
  });

/** Validates search filters from the query string; returns an error message or the filters. */
export function parseSearchFilters(query: Record<string, unknown>): { error: string } | { filters: SearchFilters } {
  const r = searchFiltersSchema.safeParse({
    day: query.day,
    from: query.from,
    to: query.to,
    level: query.level,
    track: query.track,
  });
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue?.path[0];
    return { error: `${typeof field === "string" ? `${field}: ` : ""}${issue?.message ?? "invalid filters"}` };
  }
  const f = r.data;
  const dedupe = <T>(xs: T[] | undefined) => (xs && xs.length > 0 ? [...new Set(xs)] : undefined);
  const filters: SearchFilters = {};
  if (f.day) filters.day = f.day;
  if (f.from) filters.from = f.from;
  if (f.to) filters.to = f.to;
  const levels = dedupe(f.level);
  if (levels) filters.levels = levels;
  const tracks = dedupe(f.track);
  if (tracks) filters.tracks = tracks;
  return { filters };
}
