import { routes, type RouteDef } from "@cc/shared";
import { offlineExpiry, offlineSession, resetOfflineSession } from "./offline.js";
import type {
  AccessTokenResponse,
  AuthCallbackResponse,
  AuthProvidersResponse,
  RoomOccupancyResponse,
  RoomPlacementResponse,
  CatalogTopicsResponse,
  InterestAggregateResponse,
  InterestClustersResponse,
  OnboardingRequest,
  OnboardingResponse,
  RegisterRequest,
  RegisterResponse,
  SaveScheduleRequest,
  ScanRequest,
  ScanResponse,
  ScheduleResponse,
  SearchMode,
  SearchFilterParams,
  SearchResponse,
  StatusResponse,
} from "@cc/shared";
import { searchFilterQuery } from "./searchFilters.js";

const TOKEN_KEY = "cc.token";
let memoryToken: string | null = null;

export function getToken(): string | null {
  try {
    return memoryToken ?? sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return memoryToken;
  }
}

export function setToken(token: string): void {
  if (token !== getToken()) resetOfflineSession();
  memoryToken = token;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable; token only lives for this page view
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(
  route: RouteDef,
  opts: { body?: unknown; query?: Record<string, string | string[]>; headers?: Record<string, string> } = {},
): Promise<T> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
  const qs = opts.query ? `?${params.toString()}` : "";
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${route.path}${qs}`, {
    method: route.method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) throw new ApiError(`${route.method} ${route.path} failed: ${res.status}`, res.status);
  return (await res.json()) as T;
}

/**
 * The scan endpoint answers an expired or invalid token with 401 and a deny
 * body ({decision, room, reason}); that is a result to show, not a failure.
 * The kiosk is not an attendee, so no session token is sent.
 */
async function scanRoom(body: ScanRequest): Promise<ScanResponse> {
  const res = await fetch(routes.accessScan.path, {
    method: routes.accessScan.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok || res.status === 401) {
    const data = (await res.json()) as Partial<ScanResponse>;
    if (data.decision === "allow" || data.decision === "deny") return data as ScanResponse;
  }
  throw new Error(`${routes.accessScan.method} ${routes.accessScan.path} failed: ${res.status}`);
}

/** Finishes OAuth: receives display fields plus either a session or a one-time identity claim. */
async function authCallback(provider: string, body: { code: string; state: string }): Promise<AuthCallbackResponse> {
  const path = routes.authCallback.path.replace(":provider", encodeURIComponent(provider));
  const res = await fetch(path, {
    method: routes.authCallback.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(`${routes.authCallback.method} ${routes.authCallback.path} failed: ${res.status}`, res.status);
  return (await res.json()) as AuthCallbackResponse;
}

export const api = {
  authCallback,
  authProviders: async (): Promise<AuthProvidersResponse> => {
    const res = await fetch("/api/auth/providers", { headers: { accept: "application/json" } });
    if (!res.ok) throw new ApiError(`GET /api/auth/providers failed: ${res.status}`, res.status);
    return (await res.json()) as AuthProvidersResponse;
  },
  roomOccupancy: () => call<RoomOccupancyResponse>(routes.roomOccupancy),
  catalogTopics: () => call<CatalogTopicsResponse>(routes.catalogTopics),
  status: () => call<StatusResponse>(routes.status),
  register: (body: RegisterRequest) => call<RegisterResponse>(routes.register, { body }),
  onboarding: (body: OnboardingRequest) => call<OnboardingResponse>(routes.onboarding, { body }),
  search: (q: string, mode: SearchMode, debug = false, filters: SearchFilterParams = {}) =>
    call<SearchResponse & { debug?: unknown }>(routes.search, {
      query: { q, mode, ...(debug ? { debug: "1" } : {}), ...searchFilterQuery(filters) },
    }),
  getSchedule: async (): Promise<ScheduleResponse & { offlineSavedAt?: string }> => {
    const token = getToken();
    const session = token ? offlineSession() : null;
    const res = await fetch(routes.getSchedule.path, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(session ? { "x-cc-offline-session": session, "x-cc-offline-until": String(offlineExpiry(token!)) } : {}) },
      cache: "no-store",
    });
    if (!res.ok) throw new ApiError(`GET ${routes.getSchedule.path} failed: ${res.status}`, res.status);
    const data = await res.json() as ScheduleResponse;
    const saved = res.headers.get("x-cc-offline-saved-at");
    return saved ? { ...data, offlineSavedAt: saved } : data;
  },
  calendar: async (talkId?: string): Promise<Blob> => {
    const token = getToken();
    const query = talkId === undefined ? "" : `?${new URLSearchParams({ talkId })}`;
    const res = await fetch(`${routes.exportCalendar.path}${query}`, {
      headers: { accept: "text/calendar", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      cache: "no-store",
    });
    if (!res.ok) throw new ApiError(`Calendar export failed: ${res.status}`, res.status);
    return res.blob();
  },
  saveSchedule: (body: SaveScheduleRequest) => call<ScheduleResponse>(routes.saveSchedule, { body }),
  accessToken: () => call<AccessTokenResponse>(routes.accessToken, { body: {} }),
  scan: scanRoom,
  aggregate: () => call<InterestAggregateResponse>(routes.interestsAggregate),
  /** Latest k-means run for organizers; `organizerKey` is sent as x-organizer-key when set. */
  clusters: (organizerKey = "") =>
    call<InterestClustersResponse>(routes.interestsClusters, { headers: organizerKey ? { "x-organizer-key": organizerKey } : {} }),
  /** Room placement suggestions for organizers; `organizerKey` is sent as x-organizer-key when set. */
  roomPlacement: (organizerKey = "") =>
    call<RoomPlacementResponse>(routes.roomPlacement, { headers: organizerKey ? { "x-organizer-key": organizerKey } : {} }),
};
