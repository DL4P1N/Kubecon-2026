import { z } from "zod";
import {
  EVENT_UTC_OFFSET,
  SEARCH_FILTER_LIMITS,
  type FacetBucket,
  type SearchFacets,
} from "@cc/shared";
import type { SearchFilters } from "./queries.js";

/**
 * Filters and facet aggregations for GET /api/search (task #54).
 * Field names come from the talks mapping (api/src/es/mappings.ts):
 * `track` and `level` are keyword fields, `start` is a date.
 */

export const TRACK_FACET_SIZE = 30;
export const LEVEL_FACET_SIZE = 5;

/** Terms aggs on track and level plus a per-local-day histogram on `start`. */
export function facetAggs(): Record<string, unknown> {
  return {
    track: { terms: { field: "track", size: TRACK_FACET_SIZE } },
    level: { terms: { field: "level", size: LEVEL_FACET_SIZE } },
    day: {
      date_histogram: {
        field: "start",
        calendar_interval: "day",
        time_zone: EVENT_UTC_OFFSET,
        format: "yyyy-MM-dd",
        min_doc_count: 1,
      },
    },
  };
}

function buckets(agg: unknown, useKeyString: boolean): FacetBucket[] {
  const raw = (agg as { buckets?: unknown } | null | undefined)?.buckets;
  if (!Array.isArray(raw)) return [];
  const out: FacetBucket[] = [];
  for (const b of raw as Record<string, unknown>[]) {
    const value = useKeyString ? b?.key_as_string : b?.key;
    const count = b?.doc_count;
    if (typeof value !== "string" || value === "" || typeof count !== "number" || count <= 0) continue;
    out.push({ value, count });
  }
  return out;
}

/** Facets from an ES `aggregations` object; undefined when ES returned none. */
export function parseFacets(aggregations: unknown): SearchFacets | undefined {
  if (!aggregations || typeof aggregations !== "object") return undefined;
  const a = aggregations as Record<string, unknown>;
  return {
    track: buckets(a.track, false),
    level: buckets(a.level, false),
    day: buckets(a.day, true),
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

/** Validates search filters from the query string; returns an error message or ES filters. */
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
