import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import QRCode from "qrcode";
import type { AccessTokenResponse, ScheduleResponse } from "@cc/shared";
import { api, ApiError, getToken } from "../api.js";
import { Alternatives } from "../components/Alternatives.js";
import { talkHref } from "../talksApi.js";
import { SkippedTalks } from "../components/SkippedTalks.js";
import { recallSkipped, rememberSkipped } from "../skippedTalks.js";
import "./discovery.css";
import { RoomActivityBadge, useRoomActivity } from "./RoomActivity.js";

export function Schedule() {
  const { activity } = useRoomActivity();
  const [schedule, setSchedule] = useState<(ScheduleResponse & { offlineSavedAt?: string }) | null>(null);
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const connected = () => { setOnline(true); setRetry(0); };
    const disconnected = () => { setOnline(false); setAccess(null); };
    window.addEventListener("online", connected);
    window.addEventListener("offline", disconnected);
    return () => { window.removeEventListener("online", connected); window.removeEventListener("offline", disconnected); };
  }, []);
  // Bumped to re-request the schedule while a worker-saved copy is shown although the browser reports being online.
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  // Schedules are personal: without a session token from /register there is nothing to load.
  const [needsRegistration, setNeedsRegistration] = useState(() => !getToken());
  const [qrError, setQrError] = useState("");
  const [pending, setPending] = useState(false);
  const [access, setAccess] = useState<(AccessTokenResponse & { image: string }) | null>(null);
  const [now, setNow] = useState(Date.now());
  const [calendarPending, setCalendarPending] = useState(false);
  const [calendarError, setCalendarError] = useState("");
  const [skipped, setSkipped] = useState(recallSkipped);
  async function exportCalendar(talkId?: string) {
    if (calendarPending) return;
    setCalendarPending(true);
    setCalendarError("");
    try {
      const blob = await api.calendar(talkId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = talkId ? "conference-talk.ics" : "conference-schedule.ics";
      document.body.append(link);
      try { link.click(); } finally {
        link.remove();
        // Let the browser start the download before releasing its object URL.
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setNeedsRegistration(true);
        setSchedule(null);
        setAccess(null);
      } else setCalendarError("Your calendar could not be downloaded. Please try again.");
    } finally { setCalendarPending(false); }
  }
  useEffect(() => {
    if (needsRegistration) return;
    let active = true;
    let timer: number | undefined;
    api.getSchedule().then((result) => {
      if (!active) return;
      setSchedule(result); setError("");
      // The worker's network can lag the page's "online" event and answer from its saved copy; keep asking
      // (with backoff) so a rejected session or fresh data replaces the offline view without a manual reload.
      if (result.offlineSavedAt && online) timer = window.setTimeout(() => setRetry((n) => n + 1), Math.min(1000 * 2 ** Math.min(retry, 4), 15000));
    }, (err: unknown) => {
      if (!active) return;
      // Discard personal state when the server rejects this session.
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setNeedsRegistration(true);
        setSchedule(null);
        setAccess(null);
      }
      else setError("Your schedule could not be loaded. Please reload or register again if your session expired.");
    });
    return () => { active = false; window.clearTimeout(timer); };
  }, [needsRegistration, online, retry]);
  useEffect(() => {
    if (!access) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [access]);
  async function showQr() {
    if (!navigator.onLine) { setQrError("QR needs a connection."); return; }
    if (pending) return;
    setPending(true);
    setQrError("");
    setAccess(null);
    try {
      const token = await api.accessToken();
      if (!Number.isFinite(Date.parse(token.expiresAt))) throw new Error("Invalid expiry");
      const svg = await QRCode.toString(token.token, { type: "svg", width: 256, margin: 4 });
      const image = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      setNow(Date.now());
      if (navigator.onLine) setAccess({ ...token, image });
    } catch {
      setQrError("Room check-in is unavailable. Make sure you opted in to QR check-in and your registration has not expired.");
    } finally { setPending(false); }
  }
  const validQr = online && access && now < Date.parse(access.expiresAt);
  return <section className="discovery">
    <h1>My schedule</h1>
    {schedule?.offlineSavedAt && <p role="status">Offline: showing schedule saved at {new Date(schedule.offlineSavedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>}
    {!online && <p role="status">QR needs a connection. Reconnect to create a fresh check-in code.</p>}
    <p>All session times use your device’s local time zone.</p>
    <p>Room activity reflects recent check-ins, not a headcount.</p>
    {needsRegistration && <p role="status">Register to build your personal schedule. <Link to="/register">Register now</Link>.</p>}
    {error && <p role="alert">{error}</p>}
    {!schedule && !error && !needsRegistration && <p role="status">Loading your schedule…</p>}
    {schedule && schedule.items.length === 0 && <p>No talks scheduled yet. <Link to="/onboarding">Find your talks</Link>.</p>}
    {schedule && schedule.items.length > 0 && <button type="button" disabled={calendarPending} onClick={() => void exportCalendar()}>
      {calendarPending ? "Preparing calendar…" : "Add to calendar"}
    </button>}
    {calendarError && <p role="alert">{calendarError}</p>}
    {schedule && <SkippedTalks items={schedule.items} skipped={skipped}
      onSwapped={(next) => { rememberSkipped(next.skipped); setSkipped(next.skipped ?? []); setSchedule(next); }}
      onUnauthorized={() => { setNeedsRegistration(true); setSchedule(null); }} />}
    <ol className="schedule-timeline">{[...(schedule?.items ?? [])].sort((a, b) => Date.parse(a.talk.start) - Date.parse(b.talk.start)).map(({ talk, reason }) =>
      <li key={talk.id}>
        <p><time dateTime={talk.start}>{new Date(talk.start).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>
          {" – "}<time dateTime={talk.end}>{new Date(talk.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p>
        <h2><Link to={talkHref(talk.id)}>{talk.title}</Link></h2><p>{talk.room} · {talk.speaker}</p>
        <p><RoomActivityBadge room={talk.room} activity={activity} /></p>
        {reason && <p><strong>Why recommended:</strong> {reason}</p>}
        <button type="button" disabled={calendarPending} aria-label={`Add ${talk.title} to calendar`}
          onClick={() => void exportCalendar(talk.id)}>Add this talk to calendar</button>
        <Alternatives talk={talk} />
      </li>)}</ol>
    <section aria-labelledby="checkin-heading">
      <h2 id="checkin-heading">Room check-in</h2>
      <p>For attendees who opted in. Each scan checks your room access; the code expires shortly after it is issued.</p>
      <button type="button" disabled={pending || !online} onClick={showQr}>{pending ? "Creating code…" : "Show room QR"}</button>
      {qrError && <p role="alert">{qrError}</p>}
      {validQr && <div>
        <img src={access.image} width={256} height={256} alt="Short-lived room check-in QR code" />
        <p>Expires at {new Date(access.expiresAt).toLocaleTimeString()}.</p>
        <details><summary>Text alternative for the kiosk</summary><p>Copy this token into the kiosk’s token field.</p><code className="checkin-token">{access.token}</code></details>
        <button type="button" onClick={() => setAccess(null)}>Hide code</button>
      </div>}
      {access && !validQr && <p role="status">Code expired. Select “Show room QR” to create a new one.</p>}
    </section>
  </section>;
}
