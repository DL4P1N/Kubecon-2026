import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthProviderId, AuthCallbackResponse } from "@cc/shared";
import type { OAuthProviderConfig } from "../config.js";

/**
 * Pure OAuth helpers. Provider tokens are used only to fetch display fields and a stable subject;
 * callers HMAC the subject before persistence. No email scope is requested, and nothing here logs
 * codes, tokens, subjects, or profile fields.
 */

export const DEFAULT_RETURN = "/site/profile.html";
export const STATE_TTL_MS = 10 * 60 * 1000;
export const STATE_MAX_ENTRIES = 2000;
const FETCH_TIMEOUT_MS = 8000;

interface ProviderSpec {
  authorizeUrl: string;
  tokenUrl: string;
  profileUrl: string;
  scope: string;
}

export const PROVIDER_IDS = ["github"] as const satisfies readonly AuthProviderId[];

const SPECS: Record<AuthProviderId, ProviderSpec> = {
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    profileUrl: "https://api.github.com/user",
    scope: "read:user",
  },
};

export const isProviderId = (v: unknown): v is AuthProviderId => typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);

/**
 * A same-origin relative path or null. Rejects anything a browser could read as another origin:
 * not starting with a single "/", "//", backslashes, any scheme, control characters.
 */
export function sanitizeReturn(raw: unknown): string | null {
  if (raw === undefined || raw === "") return DEFAULT_RETURN;
  if (typeof raw !== "string" || raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  // Resolve against a throwaway origin: it must come back to that origin with the same path.
  try {
    const u = new URL(raw, "http://same-origin.invalid");
    if (u.origin !== "http://same-origin.invalid" || u.pathname.startsWith("//")) return null;
  } catch {
    return null;
  }
  return raw;
}

export interface PendingState {
  provider: AuthProviderId;
  return: string;
  app: boolean;
  /** Random value also set as an HttpOnly cookie at start; the callback must present it (browser binding). */
  nonce: string;
}

export const NONCE_COOKIE = "cc_oauth";

/** HttpOnly, SameSite=Lax (survives the provider's top-level redirect back), ten minutes, scoped to /api/auth. */
export const nonceCookie = (nonce: string, secure: boolean) =>
  `${NONCE_COOKIE}=${nonce}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=${STATE_TTL_MS / 1000}${secure ? "; Secure" : ""}`;

export const clearNonceCookie = () => `${NONCE_COOKIE}=; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=0`;

/** Constant-time check of the nonce cookie against the one stored with the state. */
export function nonceMatches(expected: string, cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== NONCE_COOKIE) continue;
    const a = Buffer.from(part.slice(i + 1).trim());
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  return false;
}

/** One-time `state` values held in memory for ten minutes. Bounded: the oldest entries go first. */
export function createStateStore(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
  const ttl = opts.ttlMs ?? STATE_TTL_MS;
  const max = opts.max ?? STATE_MAX_ENTRIES;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, { expires: number; value: PendingState }>();
  const sweep = () => {
    const t = now();
    for (const [k, v] of entries) if (v.expires <= t) entries.delete(k);
  };
  return {
    create(value: Omit<PendingState, "nonce">): { state: string; nonce: string } {
      sweep();
      while (entries.size >= max) entries.delete(entries.keys().next().value as string);
      const state = randomBytes(24).toString("base64url");
      const nonce = randomBytes(24).toString("base64url");
      entries.set(state, { expires: now() + ttl, value: { ...value, nonce } });
      return { state, nonce };
    },
    /** Single use: a state is gone after the first lookup, valid or not. */
    consume(state: string, provider: AuthProviderId): PendingState | null {
      const hit = entries.get(state);
      entries.delete(state);
      if (!hit || hit.expires <= now() || hit.value.provider !== provider) return null;
      return hit.value;
    },
    get size() {
      return entries.size;
    },
  };
}

export function buildAuthorizeUrl(provider: AuthProviderId, cfg: OAuthProviderConfig, state: string): string {
  const spec = SPECS[provider];
  const u = new URL(spec.authorizeUrl);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("scope", spec.scope);
  u.searchParams.set("state", state);
  return u.toString();
}

/** Thrown for every provider-side failure; the message is fixed and never carries provider text. */
export class ProviderError extends Error {
  constructor() {
    super("provider request failed");
    this.name = "ProviderError";
  }
}

const str = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t.slice(0, max);
};

const httpsUrl = (v: unknown): string | undefined => {
  const s = str(v, 1024);
  if (!s) return undefined;
  try {
    return new URL(s).protocol === "https:" ? s : undefined;
  } catch {
    return undefined;
  }
};

async function json(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) throw new ProviderError();
  const body = (await res.json()) as unknown;
  if (typeof body !== "object" || body === null) throw new ProviderError();
  return body as Record<string, unknown>;
}

/**
 * Exchanges the code with the client secret, reads the profile and returns it. The access token lives
 * only inside this function. Any failure (network, status, shape) becomes a ProviderError.
 */
export async function fetchProfile(
  provider: AuthProviderId,
  cfg: OAuthProviderConfig,
  code: string,
  fetchFn: typeof fetch,
): Promise<Pick<AuthCallbackResponse, "provider" | "displayName" | "handle" | "avatarUrl"> & { subject: string }> {
  const spec = SPECS[provider];
  try {
    const form = new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
    });
    const tokenRes = await fetchFn(spec.tokenUrl, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const accessToken = str((await json(tokenRes)).access_token, 4096);
    if (!accessToken) throw new ProviderError();
    const profileRes = await fetchFn(spec.profileUrl, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": "conference-companion",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const p = await json(profileRes);
    const handle = str(p.login, 80);
    const displayName = str(p.name, 80) ?? handle;
    if (!displayName) throw new ProviderError();
    if (typeof p.id !== "number" || !Number.isInteger(p.id) || p.id <= 0) throw new ProviderError();
    return { provider, subject: String(p.id), displayName, ...(handle ? { handle } : {}), ...(httpsUrl(p.avatar_url) ? { avatarUrl: httpsUrl(p.avatar_url)! } : {}) };
  } catch (err) {
    throw err instanceof ProviderError ? err : new ProviderError();
  }
}

/** Stable, non-reversible account key: hex HMAC-SHA256 over provider and provider subject. Only this is stored. */
export function identityId(key: string, provider: AuthProviderId, subject: string): string {
  return createHmac("sha256", key).update(`${provider}:${subject}`).digest("hex");
}
