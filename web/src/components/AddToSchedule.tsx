import { useState } from "react";
import { Link } from "react-router-dom";
import type { ScheduleResponse } from "@cc/shared";
import { api, getToken } from "../api.js";

type ScheduleApi = Pick<typeof api, "getSchedule" | "saveSchedule">;
type State = "idle" | "saving" | "added" | "already" | "conflict" | "register" | "error";

/**
 * Adds a talk to the attendee's personal schedule with the existing schedule API.
 * Existing talks keep priority, so adding never silently displaces one: if the
 * new talk overlaps a talk already scheduled, the server leaves it out and we say so.
 */
export function AddToSchedule({ talkId, schedule = api, hasSession = () => !!getToken() }: { talkId: string; schedule?: ScheduleApi; hasSession?: () => boolean }) {
  const [state, setState] = useState<State>(() => (hasSession() ? "idle" : "register"));

  async function onClick() {
    if (state === "saving") return;
    setState("saving");
    try {
      const current: ScheduleResponse = await schedule.getSchedule();
      const ids = current.items.map((i) => i.talk.id);
      if (ids.includes(talkId)) return setState("already");
      const saved = await schedule.saveSchedule({ talkIds: [...ids, talkId], maxTalks: Math.min(50, Math.max(12, ids.length + 1)) });
      setState(saved.items.some((i) => i.talk.id === talkId) ? "added" : "conflict");
    } catch (err) {
      // api.ts reports the HTTP status at the end of the message; 401 means a missing or expired session.
      setState(err instanceof Error && / 401$/.test(err.message) ? "register" : "error");
    }
  }

  if (state === "register") {
    return <p role="status"><a href="/site/register.html">Register</a> to add talks to your schedule.</p>;
  }
  return <div className="add-to-schedule">
    <button type="button" disabled={state === "saving" || state === "added" || state === "already"} onClick={onClick}>
      {state === "saving" ? "Adding…" : "Add to my schedule"}
    </button>
    <div aria-live="polite">
      {state === "added" && <p>Added to your schedule. <Link to="/schedule">View schedule</Link></p>}
      {state === "already" && <p>This talk is already in your schedule. <Link to="/schedule">View schedule</Link></p>}
      {state === "conflict" && <p role="alert">This talk overlaps one already in your schedule, so it was not added.</p>}
      {state === "error" && <p role="alert">Your schedule could not be updated. Please try again.</p>}
    </div>
  </div>;
}
