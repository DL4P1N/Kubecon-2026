import type { SearchLeg, Talk } from "@cc/shared";

export interface ScoredTalk {
  talk: Talk;
  score: number;
  matched?: SearchLeg[];
}

export interface ScheduleResult {
  /** Chosen talks, ordered by start time. */
  chosen: ScoredTalk[];
  /** Ids of candidates skipped (overlap, invalid times, or over the cap). */
  dropped: string[];
}

export const DEFAULT_MAX_TALKS = 12;

/** Half-open interval overlap: a talk ending exactly when another starts does not conflict. */
export function overlaps(a: Pick<Talk, "start" | "end">, b: Pick<Talk, "start" | "end">): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
}

function validTimes(t: Talk): boolean {
  const s = Date.parse(t.start);
  const e = Date.parse(t.end);
  return Number.isFinite(s) && Number.isFinite(e) && s < e;
}

/**
 * Greedy schedule: walk candidates from highest score to lowest (input order
 * breaks ties, so callers can pass a priority order with equal scores) and
 * keep a talk only if it overlaps nothing already kept. Duplicate ids count
 * once.
 */
export function buildSchedule(candidates: ScoredTalk[], maxTalks = DEFAULT_MAX_TALKS): ScheduleResult {
  const ranked = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.score - a.c.score || a.i - b.i)
    .map((x) => x.c);

  const chosen: ScoredTalk[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const cand of ranked) {
    if (seen.has(cand.talk.id)) continue;
    seen.add(cand.talk.id);
    if (chosen.length >= maxTalks || !validTimes(cand.talk) || chosen.some((c) => overlaps(c.talk, cand.talk))) {
      dropped.push(cand.talk.id);
      continue;
    }
    chosen.push(cand);
  }
  chosen.sort((a, b) => Date.parse(a.talk.start) - Date.parse(b.talk.start));
  return { chosen, dropped };
}
