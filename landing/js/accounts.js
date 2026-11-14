// Linked accounts: GitHub sign-in done by the API (/api/auth/*).
// A completed sign-in leaves localStorage `cc.linked.v1` = { [provider]: { displayName, handle, avatarUrl, linkedAt } }.
// Provider avatar images are never loaded: initials only. Pure helpers first, DOM glue for the header button at the end.

import { authUrl } from "./auth.js";
import { sessionToken } from "./companion-api.js";

export const LINKED_KEY = "cc.linked.v1";
export const PROVIDERS = [
  { id: "github", name: "GitHub" },
];
const IDS = PROVIDERS.map((p) => p.id);
export const providerName = (id) => PROVIDERS.find((p) => p.id === id)?.name ?? id;

/** `{providers:[{id, enabled}]}` -> `{github: true, ...}`; unknown providers and junk are ignored. */
export function parseProviders(json) {
  const out = {};
  const list = json && Array.isArray(json.providers) ? json.providers : [];
  for (const p of list) if (p && IDS.includes(p.id)) out[p.id] = p.enabled === true;
  return out;
}

export const startUrl = (id, returnPath, base) => authUrl(`/api/auth/${id}/start?return=${encodeURIComponent(returnPath)}`, base);
export const registerReturnPath = (slug, id) => `/site/register.html?c=${encodeURIComponent(slug)}&via=${id}`;

/** Keeps known providers with a usable display name; everything else is dropped. */
export function parseLinked(raw) {
  let o = raw;
  if (typeof raw === "string") { try { o = JSON.parse(raw); } catch { o = null; } }
  const out = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const id of IDS) {
    const e = o[id];
    if (!e || typeof e !== "object" || typeof e.displayName !== "string" || !e.displayName.trim()) continue;
    out[id] = {
      displayName: e.displayName.trim().slice(0, 80),
      handle: typeof e.handle === "string" ? e.handle.trim().slice(0, 80) : "",
      linkedAt: typeof e.linkedAt === "string" || typeof e.linkedAt === "number" ? e.linkedAt : null,
    };
  }
  return out;
}

export function unlinkProvider(linked, id) {
  const { [id]: _gone, ...rest } = parseLinked(linked);
  return rest;
}

/** Up to two letters for the avatar square. */
export function initials(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const first = [...words[0]][0] ?? "?";
  const last = words.length > 1 ? [...words[words.length - 1]][0] : "";
  return (first + last).toUpperCase();
}

export const readLinked = () => { try { return parseLinked(localStorage.getItem(LINKED_KEY)); } catch { return {}; } };
export const writeLinked = (linked) => { try { localStorage.setItem(LINKED_KEY, JSON.stringify(linked)); } catch { /* storage unavailable */ } };

export async function fetchProviders(fetchImpl = globalThis.fetch) {
  try {
    const r = await fetchImpl(authUrl("/api/auth/providers"), { headers: { accept: "application/json" } });
    return r.ok ? parseProviders(await r.json()) : {};
  } catch { return {}; }
}

// ------------------------------------------------------------------ header: "Sign in with GitHub" (a[data-signin]), shown when the
// provider is enabled and no session exists. A returning account goes back to the return path; a new account gets a claim and the
// app's callback sends it on to register.html?via=<provider>. On conference.html the return is that conference's registration.
const buttons = typeof document !== "undefined" ? document.querySelectorAll("a[data-signin]") : [];
if (buttons.length && !sessionToken()) {
  fetchProviders().then((enabled) => {
    const slug = new URLSearchParams(location.search).get("c") || "cloud-native-hackathon-slc-2026";
    const onConference = document.querySelector("[data-c-link]") !== null;
    for (const a of buttons) {
      const id = a.dataset.signin;
      if (!enabled[id]) continue;
      const returnPath = a.dataset.return || (onConference ? registerReturnPath(slug, id) : location.pathname + location.search);
      a.href = startUrl(id, returnPath);
      a.hidden = false;
    }
  });
}
