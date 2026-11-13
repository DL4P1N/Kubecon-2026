// Where the sign-in API lives. Same origin by default; a separate host can be set without a rebuild.
// Set with <meta name="cc-auth-base" content="..."> (a valid http(s) origin), else '' (same origin).
// Nothing in browser storage can change it: a script injected into a page must not be able to redirect sign-in links.

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
    const meta = document.querySelector('meta[name="cc-auth-base"]');
    return normalizeAuthBase(meta?.getAttribute("content"));
  } catch { return ""; }
}

/** `/api/auth/...` prefixed with the base. */
export const authUrl = (path, base = authBase()) => `${base}${path}`;
