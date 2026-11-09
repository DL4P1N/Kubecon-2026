/**
 * API contract shared by api/ and web/. Types here are the source of truth;
 * the `routes` table lists every endpoint so both sides can reference paths
 * without string duplication.
 *
 * Auth: endpoints other than /healthz, GET /api/catalog/topics and POST /api/register expect
 * `Authorization: Bearer <attendee token>`. Tokens are short-lived, signed,
 * and carry the attendee ID only (see design doc section 6).
 */

// ---------------------------------------------------------------- common

export type HttpMethod = "GET" | "POST";

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

export interface SearchQuery {
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

export interface ScheduleResponse {
  items: ScheduleItem[];
  updatedAt: string; // ISO 8601
  /** Talks that were left out because they overlap a higher-priority one. */
  droppedTalkIds?: string[];
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

// ---------------------------------------------------------------- route table

export const routes = {
  catalogTopics: { method: "GET", path: "/api/catalog/topics" },
  health: { method: "GET", path: "/healthz" },
  status: { method: "GET", path: "/api/status" },
  register: { method: "POST", path: "/api/register" },
  me: { method: "GET", path: "/api/me" },
  onboarding: { method: "POST", path: "/api/onboarding" },
  search: { method: "GET", path: "/api/search" },
  saveSchedule: { method: "POST", path: "/api/schedule" },
  getSchedule: { method: "GET", path: "/api/schedule" },
  exportCalendar: { method: "GET", path: "/api/schedule.ics" },
  accessToken: { method: "POST", path: "/api/access/token" },
  accessScan: { method: "POST", path: "/api/access/scan" },
  interestsAggregate: { method: "GET", path: "/api/interests/aggregate" },
  interestsClusters: { method: "GET", path: "/api/interests/clusters" },
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof routes;
