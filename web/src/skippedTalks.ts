import type { ScheduleItem, SkippedTalk } from "@cc/shared";

/**
 * Skipped talks from the most recent schedule build. Kept in memory only (never
 * in browser storage): a build on /onboarding hands them to /schedule within the
 * same page session; a reload simply forgets them.
 */
let lastSkipped: SkippedTalk[] = [];

export function rememberSkipped(skipped: SkippedTalk[] | undefined): void {
  lastSkipped = skipped ?? [];
}

export function recallSkipped(): SkippedTalk[] {
  return lastSkipped;
}

/** Keep only skipped entries that still make sense against the current schedule. */
export function relevantSkipped(items: ScheduleItem[], skipped: SkippedTalk[]): SkippedTalk[] {
  const kept = new Set(items.map((i) => i.talk.id));
  return skipped.filter((s) => s.talk && !kept.has(s.talkId) && s.conflictsWith.length > 0
    && s.conflictsWith.every((id) => kept.has(id)));
}

/**
 * Priority-ordered talk ids for a swap: the skipped talk first, then the rest of
 * the schedule, then the talks it displaces and the other skipped talks, so the
 * server's greedy builder keeps the swap and reports what is now skipped
 * (including the displaced talks, which can be swapped back).
 */
export function swapTalkIds(items: ScheduleItem[], skipped: SkippedTalk[], target: SkippedTalk): string[] {
  const displaced = new Set(target.conflictsWith);
  const kept = items.map((i) => i.talk.id).filter((id) => !displaced.has(id));
  const others = skipped.map((s) => s.talkId).filter((id) => id !== target.talkId);
  return [...new Set([target.talkId, ...kept, ...target.conflictsWith, ...others])];
}
