import { useState } from "react";
import type { ScheduleItem, ScheduleResponse, SkippedTalk } from "@cc/shared";
import { api, ApiError } from "../api.js";
import { relevantSkipped, swapTalkIds } from "../skippedTalks.js";

interface Props {
  items: ScheduleItem[];
  skipped: SkippedTalk[];
  /** Called with the re-saved schedule after a successful swap. */
  onSwapped: (schedule: ScheduleResponse) => void;
  /** Called when the session has expired during a swap. */
  onUnauthorized?: () => void;
}

function timeRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  return `${s.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} – ${e.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/** "We skipped N talks that overlapped", each with its conflict and a one-click swap. */
export function SkippedTalks({ items, skipped, onSwapped, onUnauthorized }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const shown = relevantSkipped(items, skipped);
  const titles = new Map(items.map((i) => [i.talk.id, i.talk.title]));

  async function swap(target: SkippedTalk) {
    if (pending) return;
    setPending(target.talkId);
    setMessage("");
    setError("");
    try {
      const result = await api.saveSchedule({ talkIds: swapTalkIds(items, skipped, target) });
      const added = result.items.some((i) => i.talk.id === target.talkId);
      const removed = target.conflictsWith.map((id) => titles.get(id) ?? id).join(" and ");
      setMessage(added
        ? `Swapped: ${target.talk?.title ?? target.talkId} is now in your schedule instead of ${removed}.`
        : `Your schedule was saved, but ${target.talk?.title ?? target.talkId} could not be added.`);
      onSwapped(result);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onUnauthorized?.();
      else setError("The swap could not be saved. Your schedule is unchanged. Please try again.");
    } finally { setPending(null); }
  }

  // The live region stays mounted so the swap result is announced even when the list empties.
  return <section aria-labelledby={shown.length > 0 ? "skipped-heading" : undefined} className="skipped-talks">
    <div role="status" aria-live="polite">{message}</div>
    {error && <p role="alert">{error}</p>}
    {shown.length > 0 && <>
      <h2 id="skipped-heading">
        We skipped {shown.length} {shown.length === 1 ? "talk" : "talks"} that overlapped
      </h2>
      <p>Prefer one of these? Swap it in, and watch the recording of the talk it replaces later.</p>
      <ul>{shown.map((s) => {
        const conflicts = s.conflictsWith.map((id) => titles.get(id) ?? id).join(" and ");
        const title = s.talk?.title ?? s.talkId;
        return <li key={s.talkId}>
          <h3>{title}</h3>
          {s.talk && <p><time dateTime={s.talk.start}>{timeRange(s.talk.start, s.talk.end)}</time> · {s.talk.room}</p>}
          <p>Overlaps <strong>{conflicts}</strong>, which is in your schedule.</p>
          <button type="button" disabled={pending !== null} aria-label={`Swap ${title} in for ${conflicts}`}
            onClick={() => void swap(s)}>{pending === s.talkId ? "Swapping…" : "Swap"}</button>
          <p className="skipped-note">Not swapping? Watch the recording later.</p>
        </li>;
      })}</ul>
    </>}
  </section>;
}
