// Where the sign-in API lives. Same origin by default; a separate host can be set without a rebuild.
// Order: localStorage `cc.auth-base` (a valid http(s) origin), then <meta name="cc-auth-base" content="...">, else '' (same origin).

export const AUTH_BASE_KEY = "cc.auth-base";

/** An http(s) URL becomes its bare origin (no path, query, hash or trailing slash); anything else gives ''. */
export function normalizeAuthBase(value) {
  const v = String(value ?? "").trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : "";
  } catch { return ""; }
}

export function authBase() {
  try {
    const stored = normalizeAuthBase(localStorage.getItem(AUTH_BASE_KEY));
    if (stored) return stored;
  } catch { /* storage unavailable */ }
  try {
    const meta = document.querySelector('meta[name="cc-auth-base"]');
    return normalizeAuthBase(meta?.getAttribute("content"));
  } catch { return ""; }
}

/** `/api/auth/...` prefixed with the base. */
export const authUrl = (path, base = authBase()) => `${base}${path}`;
