import { EVENT_UTC_OFFSET, SEARCH_FILTER_LIMITS, type ExperienceLevel, type SearchFilterParams } from "@cc/shared";

/** Time slots offered once a day is selected; local conference time. */
export const TIME_SLOTS = {
  morning: { label: "Morning", from: "08:00", to: "12:00" },
  afternoon: { label: "Afternoon", from: "12:00", to: "17:00" },
  evening: { label: "Evening", from: "17:00", to: "23:00" },
} as const;
export type TimeSlot = keyof typeof TIME_SLOTS;

const LEVELS: readonly ExperienceLevel[] = ["beginner", "intermediate", "advanced"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What the /search page keeps in its URL: the query plus the selected chips. */
export interface SearchPageState {
  q: string;
  day?: string;
  slot?: TimeSlot;
  level: ExperienceLevel[];
  track: string[];
}

export const emptyState = (q = ""): SearchPageState => ({ q, level: [], track: [] });

/** Reads page state from a query string, dropping anything malformed. */
export function readSearchState(search: string): SearchPageState {
  const p = new URLSearchParams(search);
  const day = p.get("day") ?? undefined;
  const slot = p.get("slot") ?? undefined;
  const validDay = day && DAY_RE.test(day) ? day : undefined;
  return {
    q: (p.get("q") ?? "").slice(0, 1000),
    ...(validDay ? { day: validDay } : {}),
    ...(validDay && slot && slot in TIME_SLOTS ? { slot: slot as TimeSlot } : {}),
    level: [...new Set(p.getAll("level"))].filter((l): l is ExperienceLevel => LEVELS.includes(l as ExperienceLevel)),
    track: [...new Set(p.getAll("track"))]
      .map((t) => t.trim())
      .filter((t) => t !== "" && t.length <= SEARCH_FILTER_LIMITS.maxTrackLength)
      .slice(0, SEARCH_FILTER_LIMITS.maxTracks),
  };
}

/** Serializes page state to a query string (no leading `?`). */
export function writeSearchState(s: SearchPageState): string {
  const p = new URLSearchParams();
  if (s.q) p.set("q", s.q);
  if (s.day) p.set("day", s.day);
  if (s.day && s.slot) p.set("slot", s.slot);
  for (const l of s.level) p.append("level", l);
  for (const t of s.track) p.append("track", t);
  return p.toString();
}

/** API filters for the page state: the slot becomes a from/to window on the chosen day. */
export function toFilterParams(s: SearchPageState): SearchFilterParams {
  const f: SearchFilterParams = {};
  if (s.day) {
    f.day = s.day;
    if (s.slot) {
      const slot = TIME_SLOTS[s.slot];
      f.from = `${s.day}T${slot.from}:00${EVENT_UTC_OFFSET}`;
      f.to = `${s.day}T${slot.to}:00${EVENT_UTC_OFFSET}`;
    }
  }
  if (s.level.length > 0) f.level = s.level;
  if (s.track.length > 0) f.track = s.track;
  return f;
}

/** Query params for GET /api/search; `level`/`track` repeat once per value. */
export function searchFilterQuery(f: SearchFilterParams): Record<string, string | string[]> {
  const q: Record<string, string | string[]> = {};
  if (f.day) q.day = f.day;
  if (f.from) q.from = f.from;
  if (f.to) q.to = f.to;
  if (f.level && f.level.length > 0) q.level = f.level;
  if (f.track && f.track.length > 0) q.track = f.track;
  return q;
}

/** "Mon, Nov 9" for a `YYYY-MM-DD` day, independent of the viewer's time zone. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(d.getTime())) return day;
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}
