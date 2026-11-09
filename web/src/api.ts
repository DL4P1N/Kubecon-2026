import { routes, type RouteDef } from "@cc/shared";
import type {
  AccessTokenResponse,
  CatalogTopicsResponse,
  InterestAggregateResponse,
  OnboardingRequest,
  OnboardingResponse,
  RegisterRequest,
  RegisterResponse,
  SaveScheduleRequest,
  ScanRequest,
  ScanResponse,
  ScheduleResponse,
  SearchMode,
  SearchResponse,
} from "@cc/shared";

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
  memoryToken = token;
  try {
    sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // storage unavailable; token only lives for this page view
  }
}

async function call<T>(route: RouteDef, opts: { body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : "";
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${route.path}${qs}`, {
    method: route.method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (!res.ok) throw new Error(`${route.method} ${route.path} failed: ${res.status}`);
  return (await res.json()) as T;
}

export const api = {
  catalogTopics: () => call<CatalogTopicsResponse>(routes.catalogTopics),
  register: (body: RegisterRequest) => call<RegisterResponse>(routes.register, { body }),
  onboarding: (body: OnboardingRequest) => call<OnboardingResponse>(routes.onboarding, { body }),
  search: (q: string, mode: SearchMode, debug = false) => call<SearchResponse & { debug?: unknown }>(routes.search, {
    query: { q, mode, ...(debug ? { debug: "1" } : {}) },
  }),
  getSchedule: () => call<ScheduleResponse>(routes.getSchedule),
  saveSchedule: (body: SaveScheduleRequest) => call<ScheduleResponse>(routes.saveSchedule, { body }),
  accessToken: () => call<AccessTokenResponse>(routes.accessToken, { body: {} }),
  scan: (body: ScanRequest) => call<ScanResponse>(routes.accessScan, { body }),
  aggregate: () => call<InterestAggregateResponse>(routes.interestsAggregate),
};
