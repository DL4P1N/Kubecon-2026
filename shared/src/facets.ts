import type { ExperienceLevel } from "./contract.js";

/**
 * Search filters and facet counts for GET /api/search (task #54).
 * Everything here is optional on the wire, so clients that ignore it keep working.
 */

/**
 * UTC offset of the conference venue. Day filters and the per-day facet are
 * computed in this offset so a 9am talk lands on its local day.
 */
export const EVENT_UTC_OFFSET = "-07:00";

/** Request limits, enforced by the API (zod) and mirrored by the web UI. */
export const SEARCH_FILTER_LIMITS = {
  maxTracks: 10,
  maxTrackLength: 100,
} as const;

/** Optional filters on GET /api/search. Repeat `level`/`track` for several values (OR within a facet). */
export interface SearchFilterParams {
  /** Local conference day, `YYYY-MM-DD`. */
  day?: string;
  /** ISO 8601 datetime: talk starts at or after it. */
  from?: string;
  /** ISO 8601 datetime: talk ends at or before it. */
  to?: string;
  level?: ExperienceLevel[];
  track?: string[];
}

export interface FacetBucket {
  /** Track name, level, or `YYYY-MM-DD` day. */
  value: string;
  count: number;
}

/** Facet counts over the talks matching the current query and filters. */
export interface SearchFacets {
  track: FacetBucket[];
  level: FacetBucket[];
  day: FacetBucket[];
}
