// Linked accounts: GitHub, Google and LinkedIn sign-in done by the API (/api/auth/*).
// A completed sign-in leaves localStorage `cc.linked.v1` = { [provider]: { displayName, handle, avatarUrl, linkedAt } }.
// Provider avatar images are never loaded: initials only. Pure helpers first, DOM glue for conference.html at the end.

import { authUrl } from "./auth.js";

export const LINKED_KEY = "cc.linked.v1";
export const PROVIDERS = [
  { id: "github", name: "GitHub" },
  { id: "google", name: "Google" },
  { id: "linkedin", name: "LinkedIn" },
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

// ------------------------------------------------------------------ conference.html: the sign-in buttons become real where the provider is enabled
if (typeof document !== "undefined" && document.querySelector("a[data-via][data-c-link]")) {
  fetchProviders().then((enabled) => {
    const slug = new URLSearchParams(location.search).get("c") || "cloud-native-hackathon-slc-2026";
    let any = false;
    for (const a of document.querySelectorAll("a[data-via][data-c-link]")) {
      const id = a.getAttribute("data-via");
      if (!enabled[id]) continue;
      any = true;
      const target = startUrl(id, registerReturnPath(slug, id));
      const apply = () => { if (a.getAttribute("href") !== target) a.setAttribute("href", target); };
      apply();
      new MutationObserver(apply).observe(a, { attributes: true, attributeFilter: ["href"] }); // pages.js sets the href again once the conference loads
    }
    const note = document.querySelector(".cc-note");
    if (any && note) note.textContent = "Sign in with an enabled provider to link this account to your conference profile across devices.";
  });
}

// Sign-in entry on register.html. Keep the original conference and page return path through OAuth.
const signIn = typeof document !== "undefined" ? document.querySelector("[data-auth-providers]") : null;
if (signIn) {
  fetchProviders().then((enabled) => {
    const links = PROVIDERS.filter(({ id }) => enabled[id]);
    if (!links.length) return;
    const label = document.createElement("p");
    label.textContent = "Already have a profile? Sign in with ";
    for (const [i, provider] of links.entries()) {
      if (i) label.append(document.createTextNode(" / "));
      const link = document.createElement("a");
      link.href = startUrl(provider.id, `${location.pathname}${location.search}`);
      link.textContent = provider.name;
      label.append(link);
    }
    signIn.replaceChildren(label);
    signIn.hidden = false;
  });
}
