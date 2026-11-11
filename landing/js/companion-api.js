// Glue between the landing pages and the existing Conference Companion app/API.
// Plain ES module, no dependencies. Never throws to the caller: when the
// landing server (or the real API behind it) is missing, it falls back to
// static defaults and reports "unknown".
//
// Auto-runs on DOM ready:
//  - a[data-app-link="/path"]   -> href = appBase + "/path"
//  - [data-status-badge]        -> text + data-status="ok|degraded|down|unknown", polled every 30 s
//                                  (same wording and interval as web/src/components/status.ts)

import { ASK_KINDS, LIMITS, validateProfile } from "./chat-script.js";

export const STATUS_POLL_MS = 30_000; // STATUS_POLL_MS in web/src/components/status.ts
export const DEFAULT_APP_BASE = "http://localhost:5173";
export const DEFAULT_API_BASE = "http://localhost:3000";

/**
 * Two ways this module is served:
 *  - "site": under /site/ of the web app, same origin as the real API. Requests go to /api/... with the real
 *    contract (web/src/api.ts), the app lives at the origin root ("/schedule"), and no config endpoint exists.
 *  - "preview": landing/server.mjs on its own port (standalone preview). It proxies a small /api/... of its own.
 */
export function isSite(pathname = typeof location !== "undefined" ? location?.pathname : "") {
  return typeof pathname === "string" && (pathname === "/site" || pathname.startsWith("/site/"));
}

/**
 * URL of an API route: always the absolute, same-origin `/api/<name>`. On the site that is the real API; the
 * preview server serves the pages at `/`, so `/api/...` is its own API there. (Never module-relative: under
 * /site/ that would resolve to /site/api/.)
 */
export const apiUrl = (name) => `/api/${name}`;

export function onReady(fn) {
  if (typeof document === "undefined") return;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
  else fn();
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

// ------------------------------------------------------------------ config

export function fallbackConfig() {
  if (isSite()) {
    // No /api/config on the real API: everything is same-origin, so derive it.
    return { events: true, appBase: "", apiBase: "", publicUrl: location.origin, chat: "auto" };
  }
  return {
    events: false,
    appBase: DEFAULT_APP_BASE,
    apiBase: DEFAULT_API_BASE,
    publicUrl: typeof location !== "undefined" ? location.origin : "",
    chat: "scripted",
  };
}

let configPromise = null;

/** Cached GET /api/config; static fallback when the endpoint is missing or malformed. */
export function getConfig() {
  configPromise ??= (async () => {
    if (isSite()) return fallbackConfig();
    try {
      const r = await fetch(apiUrl("config"), { signal: timeoutSignal(2500), headers: { accept: "application/json" } });
      if (!r.ok) throw new Error("config");
      const j = await r.json();
      const str = (v) => typeof v === "string" && /^https?:\/\//.test(v);
      if (!j || !str(j.appBase)) throw new Error("config");
      const fb = fallbackConfig();
      return {
        appBase: j.appBase,
        apiBase: str(j.apiBase) ? j.apiBase : fb.apiBase,
        publicUrl: str(j.publicUrl) ? j.publicUrl : fb.publicUrl,
        chat: j.chat === "claude" ? "claude" : "scripted",
        events: j.events === true, // GET /api/events (Server-Sent Events) is available
      };
    } catch {
      return fallbackConfig();
    }
  })();
  return configPromise;
}

/** Test hook: forget the cached config. */
export function resetConfigCache() {
  configPromise = null;
}

// ------------------------------------------------------------------ status

/** Wording mirrors describeStatus() in web/src/components/status.ts. */
export function describeStatus(status) {
  if (!status || status.ok === false || !["ok", "degraded", "down"].includes(status.status)) {
    return { tone: "unknown", symbol: "?", label: "Status unavailable" };
  }
  if (status.status === "down") return { tone: "down", symbol: "✕", label: "Search is unavailable, retrying" };
  if (status.status === "degraded") {
    return status.search?.hybrid?.state === "warming_up"
      ? { tone: "degraded", symbol: "!", label: "Search is warming up, try keyword" }
      : { tone: "degraded", symbol: "!", label: "Some requests are failing, we are looking into it" };
  }
  return { tone: "ok", symbol: "✓", label: "All systems normal" };
}

/** GET /api/status (the real API on the site, via the preview server otherwise). Always resolves: `{ok:false, reason}` when unreachable. */
export async function getStatus() {
  try {
    const r = await fetch(apiUrl("status"), { signal: timeoutSignal(4000), cache: "no-store" });
    if (!r.ok) return { ok: false, reason: "unreachable" };
    const j = await r.json();
    return j && typeof j === "object" ? j : { ok: false, reason: "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

// ------------------------------------------------------------------ tickets

function randomBytes(n) {
  const b = new Uint8Array(n);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256); // very old browsers only
  return b;
}

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");

/** In-browser demo ticket, same shape as the server's local ticket. Never claims to come from the API. */
export function localTicket(now = Date.now()) {
  const h = hex(randomBytes(16));
  return {
    source: "local",
    attendeeId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
    token: `demo.${b64url(randomBytes(24))}`,
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Registers a finished profile. Resolves `{source: "api"|"local", attendeeId, token, expiresAt}`.
 * "api" only when the real API answered (through the landing server); otherwise a local demo ticket.
 */
export async function register(conference, profile, { returning = false } = {}) {
  try {
    const r = await fetch(apiUrl("register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conference: { slug: conference?.slug, name: conference?.name }, profile, returning: returning === true }),
      signal: timeoutSignal(8000),
    });
    if (r.ok) {
      const j = await r.json();
      if ((j?.source === "api" || j?.source === "local") && typeof j.attendeeId === "string" && typeof j.token === "string" && typeof j.expiresAt === "string") {
        return { source: j.source, attendeeId: j.attendeeId, token: j.token, expiresAt: j.expiresAt };
      }
    }
  } catch {
    // fall through to the local ticket
  }
  return localTicket();
}

// ------------------------------------------------- real-backend sign-up (site)

/** sessionStorage key the React app keeps the attendee token under (web/src/api.ts TOKEN_KEY). */
export const TOKEN_KEY = "cc.token";
const OFFLINE_KEY = "cc.offline-session"; // web/src/offline.ts
export const DEFAULT_EXPERIENCE = "intermediate";

/**
 * Stores the attendee token exactly like setToken() in web/src/api.ts, so the React pages are signed in
 * afterwards. When the token changes, the offline-schedule session is reset like resetOfflineSession() does.
 */
export function storeToken(token) {
  try {
    const previous = sessionStorage.getItem(TOKEN_KEY);
    if (token !== previous) {
      const session = sessionStorage.getItem(OFFLINE_KEY);
      sessionStorage.removeItem(OFFLINE_KEY);
      if (session) navigator.serviceWorker?.controller?.postMessage({ type: "forget-schedule", session });
    }
    sessionStorage.setItem(TOKEN_KEY, token);
    return true;
  } catch {
    return false; // storage unavailable: the ticket still works, the app pages need a new sign-in
  }
}

/** Chat profile -> RegisterRequest (web/shared contract). Registering implies both consents; email is never collected. */
export function toRegisterRequest(profile, conference) {
  let identityClaim;
  try {
    const claim = JSON.parse(sessionStorage.getItem("cc.identity-claim") || "null");
    if (claim && typeof claim.token === "string") identityClaim = claim.token;
  } catch { /* no browser storage */ }
  return {
    ...(identityClaim !== undefined ? { identityClaim } : {}),
    name: profile.name,
    email: "",
    interests: profile.interests,
    consent: { clusterMap: true, qrCheckin: true },
    ...(conference?.slug ? { conference: conference.slug } : {}),
  };
}

/** Chat profile -> OnboardingAnswers (shared contract). */
export function toOnboardingAnswers(profile) {
  const freeText = [profile.role, profile.formats && `formats: ${profile.formats}`].filter(Boolean).join("; ").slice(0, 1000);
  return {
    topics: profile.interests,
    experience: DEFAULT_EXPERIENCE,
    goals: profile.goal ? [profile.goal] : [],
    ...(freeText ? { freeText } : {}),
  };
}

/** Talk ids with valid times in score order, overlaps left in (the server drops them): selectTalks() in web Onboarding.tsx. */
export function selectTalks(hits) {
  return [...hits].sort((a, b) => b.score - a.score).filter(({ talk }) => {
    const start = Date.parse(talk?.start);
    const end = Date.parse(talk?.end);
    return Number.isFinite(start) && Number.isFinite(end) && start < end;
  }).map(({ talk }) => talk.id);
}

async function apiCall(path, { method = "POST", body, token, timeout = 8000 } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: timeoutSignal(timeout) });
  if (!r.ok) {
    const error = new Error(`${method} ${path} ${r.status}`);
    error.status = r.status;
    try {
      const body = await r.json();
      if (typeof body?.error === "string") error.code = body.error;
    } catch { /* non-JSON error response */ }
    throw error;
  }
  return r.json();
}

/** Short-lived room check-in token (POST /api/access/token). This is what the ticket QR encodes and the Kiosk scans. */
export async function fetchAccessToken(attendeeToken = sessionToken()) {
  const j = await apiCall("/api/access/token", { body: {}, token: attendeeToken });
  if (typeof j?.token !== "string" || !Number.isFinite(Date.parse(j.expiresAt))) throw new Error("access_shape");
  return { token: j.token, expiresAt: j.expiresAt };
}

export function sessionToken() {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}

/**
 * Finishes a sign-up against the real API (site mode): register, store the token for the React app, build the
 * personal schedule (onboarding -> search -> save, the same three calls as the Onboarding page), then fetch the
 * short-lived check-in token for the QR. Resolves a ticket:
 *   { source: "api", attendeeId, token: <check-in token for the QR, or null>, expiresAt: <registration expiry>,
 *     qrExpiresAt, scheduleSaved }
 * or, when registration itself fails (API unreachable), a local demo ticket `{ source: "local", ... }`.
 */
export async function signUp(conference, profile, { returning = false } = {}) {
  const registration = { ...toRegisterRequest(profile, conference), returning: returning === true };
  let reg;
  try {
    reg = await apiCall("/api/register", { body: registration });
    if (typeof reg?.token !== "string" || typeof reg.attendeeId !== "string" || typeof reg.expiresAt !== "string") throw new Error("register_shape");
  } catch (error) {
    if (error?.status === 409) {
      try { sessionStorage.removeItem("cc.identity-claim"); } catch { /* storage unavailable */ }
      return { source: "error", error: "already_registered" };
    }
    if (error?.code === "invalid_identity_claim") {
      try { sessionStorage.removeItem("cc.identity-claim"); } catch { /* storage unavailable */ }
      return { source: "error", error: "identity_claim_invalid" };
    }
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      return { source: "error", error: "registration_failed" };
    }
    return localTicket();
  }
  const attendeeToken = reg.token;
  storeToken(attendeeToken);
  try { sessionStorage.removeItem("cc.identity-claim"); } catch { /* storage unavailable */ }
  const ticket = { source: "api", attendeeId: reg.attendeeId, token: null, expiresAt: reg.expiresAt, qrExpiresAt: null, scheduleSaved: false };

  try {
    const result = await apiCall("/api/onboarding", { body: { answers: toOnboardingAnswers(profile) }, token: attendeeToken });
    const qs = new URLSearchParams({ q: result.query.text, mode: result.query.mode });
    const found = await apiCall(`/api/search?${qs}`, { method: "GET", token: attendeeToken });
    const talkIds = selectTalks(found.hits ?? []);
    if (talkIds.length) {
      await apiCall("/api/schedule", { body: { talkIds }, token: attendeeToken });
      ticket.scheduleSaved = true;
    }
  } catch {
    // The attendee is registered; the schedule can still be built on the app's onboarding page.
  }
  try {
    const access = await fetchAccessToken(attendeeToken);
    ticket.token = access.token;
    ticket.qrExpiresAt = access.expiresAt;
  } catch {
    // No QR now; the schedule page can create one.
  }
  return ticket;
}

/**
 * The one call the chat page makes when the chat is done. On the site it runs the real-backend sign-up;
 * on the standalone preview server it uses that server's register endpoint. Never throws.
 */
export function completeSignup(conference, profile, opts = {}) {
  return isSite() ? signUp(conference, profile, opts) : register(conference, profile, opts);
}

// ------------------------------------------------------- live organiser numbers

/**
 * Real aggregates for the organiser overlay, in the shape of data/demo-aggregates.json where the real API has the
 * numbers, or null when it is unavailable (not on the site, API down, or fewer opted-in attendees than the
 * k-anonymity floor, in which case the API returns nothing to show).
 *
 *  - attendeeCount, topicCounts, clusters: from GET /api/interests/aggregate (opted-in attendees; topics below the
 *    API's suppression floor are already merged into "other"). Each topic is its own group: the API's k-means
 *    clusters (/api/interests/clusters) need the organiser key and are not read from the browser.
 *  - roomOccupancy: always [] (the demo file has expected/scanned/capacity per slot; the real route only gives a
 *    coarse level per room). Those levels are returned as `roomLevels: [{room, level}]` instead.
 */
export async function getLiveAggregates() {
  if (!isSite()) return null;
  try {
    const [agg, rooms] = await Promise.all([
      fetch("/api/interests/aggregate", { signal: timeoutSignal(4000), cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/rooms/occupancy", { signal: timeoutSignal(4000), cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!agg || !Array.isArray(agg.topics) || !(agg.totalOptedIn > 0)) return null;
    const topics = agg.topics.filter((t) => typeof t?.topic === "string" && Number.isFinite(t.count));
    return {
      synthetic: false,
      conference: null,
      attendeeCount: agg.totalOptedIn,
      clusters: topics.map((t) => (t.topic === "other"
        ? { id: "other", label: `Other (groups under ${agg.suppressedBelow ?? 5})`, count: t.count }
        : { id: t.topic.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), label: t.topic, count: t.count, topTags: [t.topic] })),
      suppressedGroups: 0,
      topicCounts: topics.map((t) => ({ tag: t.topic, count: t.count })),
      roomOccupancy: [],
      roomLevels: Array.isArray(rooms?.rooms) ? rooms.rooms.filter((r) => typeof r?.room === "string" && typeof r.level === "string") : [],
    };
  } catch {
    return null;
  }
}

// ---- pure mappings for the organiser overlay (js/demo.js keeps the DOM thin; tested in test/live-overlay.test.mjs)

/** The three coarse levels of GET /api/rooms/occupancy (shared/src/contract.ts RoomActivity) -> bar step (of 3) and short text. */
export const ROOM_LEVELS = Object.freeze({
  "quiet": { step: 1, text: "Quiet" },
  "some recent check-ins": { step: 2, text: "Some" },
  "many recent check-ins": { step: 3, text: "Many" },
});
export const ROOM_LEVEL_STEPS = 3;

/** 1..3 for a known level, 0 for anything else (the route may grow levels; unknown ones are never drawn). */
export function levelStep(level) {
  return typeof level === "string" && Object.hasOwn(ROOM_LEVELS, level) ? ROOM_LEVELS[level].step : 0;
}

/** getLiveAggregates().roomLevels -> [{room, name, level, step, text}] in API order; unknown levels dropped. `names` maps room ids to display names. */
export function liveRoomRows(roomLevels, names = {}) {
  if (!Array.isArray(roomLevels)) return [];
  const rows = [];
  for (const r of roomLevels) {
    const step = levelStep(r?.level);
    if (!step || typeof r.room !== "string" || !r.room) continue;
    rows.push({ room: r.room, name: Object.hasOwn(names, r.room) ? names[r.room] : r.room, level: r.level, step, text: ROOM_LEVELS[r.level].text });
  }
  return rows;
}

/**
 * getLiveAggregates() -> what the clusters overlay draws: the `top` largest named topics (default 6), the "other"
 * bucket separately, and the suppressed-group count. null when there is nothing to draw. No invented numbers.
 */
export function liveClusterRows(live, top = 6) {
  const list = (Array.isArray(live?.clusters) ? live.clusters : [])
    .filter((c) => c && typeof c === "object" && Number.isFinite(c.count) && c.count >= 0)
    .map((c) => ({ id: String(c.id ?? ""), label: String(c.label ?? c.id ?? ""), count: c.count }));
  const rows = list.filter((c) => c.id !== "other").sort((a, b) => b.count - a.count).slice(0, top);
  const otherCount = list.filter((c) => c.id === "other").reduce((n, c) => n + c.count, 0);
  if (!rows.length) return null;
  const sg = Number.isFinite(live.suppressedGroups) && live.suppressedGroups > 0 ? live.suppressedGroups : 0;
  return { rows, other: list.some((c) => c.id === "other") ? { count: otherCount } : null, suppressedGroups: sg };
}

// -------------------------------------------------------------------- chat

/**
 * One chat turn via POST /api/chat. Resolves `{reply, done, profile?, mode}`; rejects when the endpoint
 * is missing or broken (the caller then switches to the in-browser scripted flow). One retry on 429.
 */
export async function sendChat({ conference, via, messages, known = null }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(apiUrl("chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conference: { slug: conference.slug, name: conference.name, ...(Array.isArray(conference.topics) ? { topics: conference.topics.slice(0, 30) } : {}) }, via: via ?? null, messages, ...(known ? { known } : {}) }),
      signal: timeoutSignal(60_000),
    });
    if (r.status === 429 && attempt === 0) {
      const wait = Math.min(3, Math.max(1, Number(r.headers.get("retry-after")) || 1));
      await new Promise((res) => setTimeout(res, wait * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`chat_${r.status}`);
    const j = await r.json();
    if (!j || typeof j.reply !== "string" || typeof j.done !== "boolean") throw new Error("chat_shape");
    const out = { reply: j.reply, done: j.done, mode: j.mode === "claude" ? "claude" : "scripted", ask: null };
    if (!j.done && ASK_KINDS.includes(j.ask) && Array.isArray(j.options)) {
      const clean = (list, n) => list.filter((x) => typeof x === "string" && x.trim() && x.length <= 40).slice(0, n);
      const options = clean(j.options, 14);
      if (options.length) {
        out.ask = j.ask;
        out.options = options;
        if (j.ask === "topics" && Array.isArray(j.selected)) out.selected = clean(j.selected, LIMITS.maxTags);
      }
    }
    if (j.done) {
      const checked = validateProfile(j.profile);
      if (!checked.ok) throw new Error("chat_profile");
      out.profile = checked.profile;
    }
    return out;
  }
  throw new Error("chat_busy");
}

// ------------------------------------------------------------- DOM wiring

export async function applyAppLinks(root = document) {
  const links = root.querySelectorAll("a[data-app-link]");
  if (!links.length) return;
  const { appBase } = await getConfig();
  for (const a of links) {
    const p = a.dataset.appLink || "/";
    a.href = appBase.replace(/\/+$/, "") + (p.startsWith("/") ? p : `/${p}`); // appBase "" on the site: "/schedule"
  }
}

export function renderStatusBadges(status, root = document) {
  const view = describeStatus(status);
  for (const el of root.querySelectorAll("[data-status-badge]")) {
    el.textContent = view.label;
    el.dataset.status = view.tone;
  }
}

let pollTimer = null;

export function startStatusBadges(root = document) {
  const badges = root.querySelectorAll("[data-status-badge]");
  if (!badges.length || pollTimer) return;
  for (const el of badges) {
    if (!el.hasAttribute("aria-live")) el.setAttribute("aria-live", "polite");
    el.textContent = "Checking status…";
    el.dataset.status = "unknown";
  }
  const tick = async () => renderStatusBadges(await getStatus(), root);
  tick();
  pollTimer = setInterval(tick, STATUS_POLL_MS);
}

onReady(() => {
  applyAppLinks().catch(() => {});
  startStatusBadges();
});
