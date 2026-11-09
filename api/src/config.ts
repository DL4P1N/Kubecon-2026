/**
 * Runtime configuration, read from environment variables only.
 * Secrets (ES_PASSWORD, TOKEN_SIGNING_KEY) come from a Kubernetes Secret in
 * deployment and must never be committed.
 */
export interface Config {
  port: number;
  host: string;
  esUrl: string;
  esUsername: string;
  esPassword: string;
  tokenSigningKey: string;
  otelExporterOtlpEndpoint: string | undefined;
  /** NODE_ENV; "production" turns on strict secret checks. */
  nodeEnv: string;
  /** Max POST /api/register requests per client IP per minute. */
  registerRateLimitPerMinute: number;
  /** Number of trusted reverse-proxy hops; zero ignores forwarded client IPs. */
  trustProxyHops: number;
  apiTlsCertFile?: string;
  apiTlsKeyFile?: string;
  /** "auto" (default): Claude CLI when found on PATH, else scripted. "scripted": never spawn the CLI. */
  chatMode: "auto" | "scripted";
  /** Path to the Claude Code CLI (CLAUDE_BIN); unset means look for `claude` on PATH. */
  claudeBin: string | undefined;
  /** ROOM_CAPACITIES: JSON map of room name to seats. Rooms not listed have unknown capacity (never guessed). */
  roomCapacities: Record<string, number>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  if (env.NODE_ENV === "production") {
    // Fail closed: never run production with the public dev key or without ES credentials.
    const missing = ["TOKEN_SIGNING_KEY", "ES_URL", "ES_USERNAME", "ES_PASSWORD"].filter((k) => !env[k]);
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
  const chatMode = env.CHAT_MODE ?? "auto";
  if (chatMode !== "auto" && chatMode !== "scripted") throw new Error(`Invalid CHAT_MODE: ${chatMode} (use auto or scripted)`);
  const roomCapacities = parseRoomCapacities(env.ROOM_CAPACITIES);
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    esUrl: env.ES_URL ?? "http://localhost:9200",
    esUsername: env.ES_USERNAME ?? "",
    esPassword: env.ES_PASSWORD ?? "",
    tokenSigningKey: env.TOKEN_SIGNING_KEY || "dev-only-insecure-key",
    otelExporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    nodeEnv: env.NODE_ENV ?? "development",
    registerRateLimitPerMinute: positiveInt(env.REGISTER_RATE_LIMIT_PER_MINUTE, 120, "REGISTER_RATE_LIMIT_PER_MINUTE"),
    trustProxyHops,
    apiTlsCertFile: env.API_TLS_CERT_FILE || undefined,
    apiTlsKeyFile: env.API_TLS_KEY_FILE || undefined,
    chatMode,
    claudeBin: env.CLAUDE_BIN || undefined,
    roomCapacities,
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
