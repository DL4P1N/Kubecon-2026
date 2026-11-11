/**
 * API contract shared by api/ and web/. Types here are the source of truth;
 * the `routes` table lists every endpoint so both sides can reference paths
 * without string duplication.
 *
 * Auth: endpoints other than /healthz, GET /api/catalog/topics and POST /api/register expect
 * `Authorization: Bearer <attendee token>`. Tokens are short-lived, signed,
 * and carry the attendee ID only (see design doc section 6).
 */

import type { SearchFacets, SearchFilterParams } from "./facets.js";

// ---------------------------------------------------------------- common

export type HttpMethod = "GET" | "POST" | "DELETE";

export interface RouteDef {
  readonly method: HttpMethod;
  readonly path: string;
}

export interface ApiError {
  error: string;
  message?: string;
}

/** Minimum number of attendees in a cluster before it may be displayed. */
export const MIN_CLUSTER_SIZE = 5;

export interface RoomActivity {
  room: string;
  level: "quiet" | "some recent check-ins" | "many recent check-ins";
}
export interface RoomOccupancyResponse {
  source: "in-process-scan-activity";
  windowMinutes: number;
  rooms: RoomActivity[];
}

// ---------------------------------------------------------------- health

export interface HealthResponse {
  status: "ok";
  version: string;
  time: string; // ISO 8601
}

// ---------------------------------------------------------------- status

/** Overall service state shown in the header badge. */
export type ServiceState = "ok" | "degraded" | "down";

/** Hybrid search readiness: "unknown" until a hybrid search has run recently. */
export type HybridState = "ready" | "warming_up" | "unknown";

export interface SearchLatencyStat {
  /** Number of searches in the window. */
  samples: number;
  /** 95th percentile in milliseconds; null when there are no samples. */
  p95Ms: number | null;
}

/**
 * Public service status. Aggregates only: no attendee data, ids or query text.
 * Computed from in-process counters, so it reflects this API replica.
 */
export interface StatusResponse {
  status: ServiceState;
  generatedAt: string; // ISO 8601
  windowSeconds: number;
  api: { up: true; version: string };
  elasticsearch: { reachable: boolean };
  search: {
    keyword: SearchLatencyStat;
    hybrid: SearchLatencyStat & { state: HybridState };
  };
  /** Share of HTTP responses in the window that were 5xx (0 to 1). */
  errorRate: { requests: number; serverErrors: number; ratio: number };
}

// ---------------------------------------------------------------- register / me

export interface Consent {
  /** Opt-in: include interests in the aggregate cluster map. */
  clusterMap: boolean;
  /** Opt-in: allow QR check-in per room. */
  qrCheckin: boolean;
}

export interface RegisterRequest {
  name: string;
  email: string;
  interests: string[];
  consent: Consent;
  /** Optional, never stored: conference slug and returning-visitor flag, used only for the live demo stream (GET /api/events). */
  conference?: string;
  returning?: boolean;
  /** From the sign-in callback `claim`: links the new profile to the signed-in provider account. */
  identityClaim?: string;
}

export interface RegisterResponse {
  attendeeId: string;
  /** Signed, short-lived attendee token. */
  token: string;
  expiresAt: string; // ISO 8601
}

export interface MeResponse {
  attendeeId: string;
  name: string;
  interests: string[];
  consent: Consent;
  onboarded: boolean;
}

// ---------------------------------------------------------------- onboarding

export type ExperienceLevel = "beginner" | "intermediate" | "advanced";

export interface OnboardingAnswers {
  topics: string[];
  experience: ExperienceLevel;
  goals: string[];
  freeText?: string;
  /** Only suggest talks starting at or after this time. ISO 8601. */
  availableFrom?: string;
  /** Only suggest talks ending at or before this time. ISO 8601. */
  availableTo?: string;
}

export interface OnboardingRequest {
  answers: OnboardingAnswers;
}

/** The query generated from the onboarding answers, plus the ranked talks. */
export interface OnboardingResponse {
  query: {
    text: string;
    topics: string[];
    mode: SearchMode;
  };
  /** Ranked talks for the generated query (level and time filters applied). */
  hits?: SearchHit[];
  /** Elasticsearch request body, only when `?debug=1`. */
  debug?: unknown;
}

// ---------------------------------------------------------------- talks / search

export type SearchMode = "hybrid" | "keyword";

export interface Talk {
  id: string;
  level?: ExperienceLevel;
  title: string;
  speaker: string;
  abstract: string;
  track: string;
  room: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  tags: string[];
}

/** Which retriever leg produced a hit. */
export type SearchLeg = "keyword" | "semantic";

export interface SearchHit {
  talk: Talk;
  /** keyword mode: BM25 score. hybrid mode: RRF fused score. */
  score: number;
  /** Which legs matched this talk (keyword = BM25, semantic = content_semantic). */
  matched?: SearchLeg[];
}

export interface SearchQuery extends SearchFilterParams {
  q: string;
  mode?: SearchMode;
  /** `1` returns the Elasticsearch request body in `debug`. */
  debug?: "0" | "1";
  /** Page size, 1-50 (default 10). */
  size?: number;
}

export interface SearchResponse {
  q: string;
  mode: SearchMode;
  tookMs: number;
  hits: SearchHit[];
  /** Track/level/day counts for this query and its filters (optional: older servers omit it). */
  facets?: SearchFacets;
  /** Elasticsearch request body, only when `?debug=1`. */
  debug?: unknown;
}

/** Public talk-catalog tags, available before attendee registration. */
export interface CatalogTopicsResponse {
  topics: string[];
}

// ---------------------------------------------------------------- schedule

/**
 * Provide `talkIds` (in priority order) to save those talks, or `answers` to
 * build a schedule from onboarding. In both cases overlapping talks are
 * dropped greedily, highest priority/score first.
 */
export interface SaveScheduleRequest {
  talkIds?: string[];
  answers?: OnboardingAnswers;
  /** Cap on the number of talks (default 12). */
  maxTalks?: number;
}

export interface ScheduleItem {
  talk: Talk;
  /** Why this talk was recommended, when known. */
  reason?: string;
}

/** A talk left out of a built schedule because it overlaps one that was kept. */
export interface SkippedTalk {
  talkId: string;
  /** Ids of the kept talks it overlaps (at least one). */
  conflictsWith: string[];
  /** The skipped talk itself, so clients can show it without another fetch. */
  talk?: Talk;
}

export interface ScheduleResponse {
  items: ScheduleItem[];
  updatedAt: string; // ISO 8601
  /** Talks that were left out because they overlap a higher-priority one. */
  droppedTalkIds?: string[];
  /**
   * Overlap-only subset of `droppedTalkIds` with what each one conflicts with.
   * Only present on schedule builds (POST), never on reads (GET).
   */
  skipped?: SkippedTalk[];
}

// ---------------------------------------------------------------- access (QR per room)

export interface AccessTokenResponse {
  /** Short-lived signed token for the QR code. Carries attendee ID only. */
  token: string;
  expiresAt: string; // ISO 8601
}

export interface ScanRequest {
  token: string;
  room: string;
}

export type ScanDecision = "allow" | "deny";

export interface ScanResponse {
  decision: ScanDecision;
  room: string;
  reason?: string;
}

// ---------------------------------------------------------------- aggregate interests

export interface InterestCluster {
  label: string;
  count: number;
}

/** Label of the bucket that merges every topic below the minimum group size. */
export const OTHER_TOPIC = "other";

export interface InterestTopicCount {
  /** Interest topic, or OTHER_TOPIC for the merged small groups. */
  topic: string;
  /** Opted-in attendees with this interest (always >= suppressedBelow). */
  count: number;
}

/**
 * Aggregate interests of attendees who opted in to the cluster map. Topics
 * with fewer than `suppressedBelow` attendees are merged into OTHER_TOPIC,
 * which is itself dropped when below the threshold. Never contains attendee IDs.
 */
export interface InterestAggregateResponse {
  /** Sorted by count, descending. */
  topics: InterestTopicCount[];
  /** Attendees who opted in (0 when fewer than `suppressedBelow`). */
  totalOptedIn: number;
  suppressedBelow: number;
  generatedAt: string; // ISO 8601
}

// ---------------------------------------------------------------- cluster map (Module 4)

export interface InterestClusterNode {
  /** Stable within one run only ("c1", "c2", ... or "other"). */
  id: string;
  label: string;
  /** Always at least `minClusterSize`. */
  size: number;
  /** Interests held by at least `minClusterSize` members of this cluster. */
  topInterests: string[];
  /** True for the merged "other" bucket (small clusters pooled together). */
  other: boolean;
}

/** Latest completed k-means batch run (`npm run clusters`). Aggregates only. */
export interface InterestClustersResponse {
  /** Null until the first run has completed. */
  runId: string | null;
  computedAt: string | null; // ISO 8601
  clusters: InterestClusterNode[];
  /** Opted-in attendees left out because their group was below the minimum. */
  suppressed: number;
  minClusterSize: number;
}

// ---------------------------------------------------------------- room placement (organizers)

/** One talk in a time slot with its estimated demand and a room suggestion. No attendee data. */
export interface RoomPlacementTalk {
  talkId: string;
  title: string;
  /** Sum of the aggregate counts of this talk's tags that appear in the k-anonymised aggregate. A relative score, not a headcount. */
  demand: number;
  /** 1 = highest demand in the slot (ties are ordered by current room capacity, then talk id). */
  demandRank: number;
  currentRoom: string;
  /** Capacity configured for the current room; null when none is configured. */
  currentCapacity: number | null;
  /** False when the current room has no configured capacity: no room suggestion is made for this talk. */
  capacityKnown: boolean;
  /** Null when capacity is unknown, so only `demandRank` is meaningful. */
  suggestedRoom: string | null;
  /** The suggestion differs from the current room. */
  moved: boolean;
  /** Demand exceeds the current room's configured capacity (never true when capacity is unknown). */
  overCapacity: boolean;
}

export interface RoomPlacementSlot {
  start: string; // ISO 8601
  end: string; // ISO 8601
  /** Highest demand first. */
  talks: RoomPlacementTalk[];
}

/** GET /api/rooms/placement (organizer key). Aggregates only; no attendee IDs. */
export interface RoomPlacementResponse {
  generatedAt: string; // ISO 8601
  /** Topics under this many attendees never appear in the aggregate, so they add nothing to demand. */
  suppressedBelow: number;
  /** True when at least one room capacity is configured (ROOM_CAPACITIES). */
  capacitiesConfigured: boolean;
  slots: RoomPlacementSlot[];
  /** Talks left out because their start or end time could not be read. */
  skippedTalks: number;
}

// ---------------------------------------------------------------- registration chat + live demo stream

export type ChatAsk = "topics" | "goal" | "confirm";
export type ChatVia = "github" | "google" | "linkedin" | "qr";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** The profile a finished chat produces. Maps onto RegisterRequest and OnboardingAnswers in the browser. */
export interface ChatProfile {
  name: string;
  role: string;
  interests: string[];
  goal: string;
  formats: string;
}

/** POST /api/chat (no auth). Stateless: send the whole transcript every turn. */
export interface ChatRequest {
  conference: { slug: string; name?: string; topics?: string[] };
  via?: ChatVia | null;
  messages: ChatMessage[];
  /** Profile this browser remembered from an earlier registration (returning visitor). */
  known?: ChatProfile | null;
}

export interface ChatResponse {
  reply: string;
  done: boolean;
  /** "claude" when the Claude Code CLI answered, "scripted" for the built-in flow. */
  mode: "claude" | "scripted";
  /** Closed question the reply asks, rendered as quick-reply chips; null when none. */
  ask: ChatAsk | null;
  options?: string[];
  /** Options pre-selected (returning visitor's topics). */
  selected?: string[];
  /** Present when `done`. */
  profile?: ChatProfile;
}

/** One `registered` frame on GET /api/events (text/event-stream). First name only; nothing else about the attendee. */
export interface RegisteredEvent {
  label: string;
  conference: string;
  returning: boolean;
  interests: number;
}

// ---------------------------------------------------------------- sign in with GitHub / Google / LinkedIn

export type AuthProviderId = "github" | "google" | "linkedin";

/** GET /api/auth/providers: which sign-in buttons can work (client id, secret and redirect URI all configured). */
export interface AuthProvidersResponse {
  providers: { id: AuthProviderId; enabled: boolean }[];
}

/** POST /api/auth/:provider/callback (no auth). `code` and `state` are the provider's redirect query parameters. */
export interface AuthCallbackRequest {
  code: string;
  state: string;
}

/**
 * The linked account as the provider reported it, plus exactly one of:
 * `session` (this account already has a profile: a normal attendee token) or
 * `claim` (new account: a 15-minute token that POST /api/register consumes as `identityClaim`).
 * The provider's own tokens and subject id are never returned; the server stores only an HMAC of the account.
 */
interface AuthCallbackResponseBase {
  provider: AuthProviderId;
  displayName: string;
  handle?: string;
  avatarUrl?: string;
  /** Same-origin relative path the visitor started from (validated when the flow began). */
  return: string;
  /** True when the flow began in the native app (`app=1`). */
  app: boolean;
}

export type AuthCallbackResponse = AuthCallbackResponseBase & (
  | { session: { token: string; expiresAt: string }; claim?: never }
  | { claim: { token: string; expiresAt: string }; session?: never }
);

// ---------------------------------------------------------------- route table

export const routes = {
  roomOccupancy: { method: "GET", path: "/api/rooms/occupancy" },
  roomPlacement: { method: "GET", path: "/api/rooms/placement" },
  catalogTopics: { method: "GET", path: "/api/catalog/topics" },
  health: { method: "GET", path: "/healthz" },
  status: { method: "GET", path: "/api/status" },
  register: { method: "POST", path: "/api/register" },
  me: { method: "GET", path: "/api/me" },
  /** Bearer session token. Deletes the caller's profile, saved schedule and entitlement; 204 with no body, 401 if already gone. */
  deleteMe: { method: "DELETE", path: "/api/me" },
  onboarding: { method: "POST", path: "/api/onboarding" },
  search: { method: "GET", path: "/api/search" },
  saveSchedule: { method: "POST", path: "/api/schedule" },
  getSchedule: { method: "GET", path: "/api/schedule" },
  exportCalendar: { method: "GET", path: "/api/schedule.ics" },
  accessToken: { method: "POST", path: "/api/access/token" },
  accessScan: { method: "POST", path: "/api/access/scan" },
  interestsAggregate: { method: "GET", path: "/api/interests/aggregate" },
  interestsClusters: { method: "GET", path: "/api/interests/clusters" },
  chat: { method: "POST", path: "/api/chat" },
  events: { method: "GET", path: "/api/events" },
  authProviders: { method: "GET", path: "/api/auth/providers" },
  /** 302 to the provider. Query: `return` (relative path), `app=1`. */
  authStart: { method: "GET", path: "/api/auth/:provider/start" },
  authCallback: { method: "POST", path: "/api/auth/:provider/callback" },
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof routes;
