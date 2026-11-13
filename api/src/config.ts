/**
 * Runtime configuration, read from environment variables only.
 * Secrets (DATABASE_URL, TOKEN_SIGNING_KEY) come from a Kubernetes Secret in
 * deployment and must never be committed.
 */
import { parseRetentionHours } from "./retentionPolicy.js";

export type OAuthProviderId = "github";

/** One provider's OAuth app settings; present only when id, secret and redirect URI are all set. */
export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface Config {
  port: number;
  host: string;
  /** DATABASE_URL: Postgres connection string (PostgreSQL 15+ with pgvector). Required in production; contains the password, never log it. */
  databaseUrl: string;
  /** DATABASE_CA_FILE: PEM CA for the database server certificate; unset uses the system roots. */
  databaseCaFile: string | undefined;
  tokenSigningKey: string;
  /** IDENTITY_HASH_KEY: HMAC key for the provider-account -> attendee link (identities table). Required when any OAuth provider is configured. */
  identityHashKey: string;
  otelExporterOtlpEndpoint: string | undefined;
  /** NODE_ENV; "production" turns on strict secret checks. */
  nodeEnv: string;
  /** Max POST /api/register requests per client IP per minute. */
  registerRateLimitPerMinute: number;
  /** Number of trusted reverse-proxy hops; zero ignores forwarded client IPs. */
  trustProxyHops: number;
  apiTlsCertFile?: string;
  apiTlsKeyFile?: string;
  /** "auto" (default outside production): Claude CLI when found on PATH, else scripted. "scripted" (default in production): never spawn the CLI. */
  chatMode: "auto" | "scripted";
  /** Path to the Claude Code CLI (CLAUDE_BIN); unset means look for `claude` on PATH. */
  claudeBin: string | undefined;
  /** EVENTS_SHOW_NAMES=on: GET /api/events carries the sanitised first name instead of "Guest". Demo-only. */
  eventsShowNames: boolean;
  /** ROOM_CAPACITIES: JSON map of room name to seats. Rooms not listed have unknown capacity (never guessed). */
  roomCapacities: Record<string, number>;
  /** GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_OAUTH_REDIRECT_URI; GitHub is disabled unless all three are set. Secrets never leave the server. */
  oauth: Partial<Record<OAuthProviderId, OAuthProviderConfig>>;
  /** ATTENDEE_RETENTION_HOURS: 0 or unset keeps attendee profiles indefinitely; a positive value restores timed deletion. */
  attendeeRetentionHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  if (env.NODE_ENV === "production") {
    // Fail closed: never run production with the public dev key or without a database.
    const missing = ["TOKEN_SIGNING_KEY", "DATABASE_URL"].filter((k) => !env[k]);
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables in production: ${missing.join(", ")}`);
    }
  }
  const trustProxyHops = Number(env.TRUST_PROXY ?? 0);
  if (Boolean(env.API_TLS_CERT_FILE) !== Boolean(env.API_TLS_KEY_FILE)) {
    throw new Error("API_TLS_CERT_FILE and API_TLS_KEY_FILE must be set together");
  }
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 10) {
    throw new Error("TRUST_PROXY must be an integer from 0 to 10");
  }
  const chatMode = env.CHAT_MODE ?? (env.NODE_ENV === "production" ? "scripted" : "auto");
  if (chatMode !== "auto" && chatMode !== "scripted") throw new Error(`Invalid CHAT_MODE: ${chatMode} (use auto or scripted)`);
  const roomCapacities = parseRoomCapacities(env.ROOM_CAPACITIES);
  const oauth = loadOAuth(env);
  const identityHashKey = env.IDENTITY_HASH_KEY?.trim() ?? "";
  if (Object.keys(oauth).length > 0 && identityHashKey.length < 32) {
    throw new Error("IDENTITY_HASH_KEY (>=32 chars) is required when an OAuth provider is configured");
  }
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    databaseUrl: env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres",
    databaseCaFile: env.DATABASE_CA_FILE || undefined,
    tokenSigningKey: env.TOKEN_SIGNING_KEY || "dev-only-insecure-key",
    otelExporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    nodeEnv: env.NODE_ENV ?? "development",
    registerRateLimitPerMinute: positiveInt(env.REGISTER_RATE_LIMIT_PER_MINUTE, 120, "REGISTER_RATE_LIMIT_PER_MINUTE"),
    trustProxyHops,
    apiTlsCertFile: env.API_TLS_CERT_FILE || undefined,
    apiTlsKeyFile: env.API_TLS_KEY_FILE || undefined,
    chatMode,
    claudeBin: env.CLAUDE_BIN || undefined,
    eventsShowNames: env.EVENTS_SHOW_NAMES === "on",
    roomCapacities,
    oauth,
    identityHashKey,
    attendeeRetentionHours: parseRetentionHours(env.ATTENDEE_RETENTION_HOURS),
  };
}

/** Parses ROOM_CAPACITIES, e.g. {"Hall A": 400, "Room 2": 80}. Unset or blank means no capacities are known. */
export function parseRoomCapacities(raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid ROOM_CAPACITIES: not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid ROOM_CAPACITIES: expected a JSON object of room name to seat count");
  }
  const out: Record<string, number> = {};
  for (const [room, seats] of Object.entries(parsed)) {
    if (room.trim() === "" || typeof seats !== "number" || !Number.isInteger(seats) || seats < 1) {
      throw new Error("Invalid ROOM_CAPACITIES: every room needs a positive whole number of seats");
    }
    out[room] = seats;
  }
  return out;
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid ${name}: ${raw}`);
  return n;
}

function loadOAuth(env: NodeJS.ProcessEnv): Partial<Record<OAuthProviderId, OAuthProviderConfig>> {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const redirectUri = env.GITHUB_OAUTH_REDIRECT_URI?.trim();
  return clientId && clientSecret && redirectUri ? { github: { clientId, clientSecret, redirectUri } } : {};
}
