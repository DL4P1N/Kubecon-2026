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
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    esUrl: env.ES_URL ?? "http://localhost:9200",
    esUsername: env.ES_USERNAME ?? "",
    esPassword: env.ES_PASSWORD ?? "",
    tokenSigningKey: env.TOKEN_SIGNING_KEY || "dev-only-insecure-key",
    otelExporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    nodeEnv: env.NODE_ENV ?? "development",
    registerRateLimitPerMinute: positiveInt(env.REGISTER_RATE_LIMIT_PER_MINUTE, 60, "REGISTER_RATE_LIMIT_PER_MINUTE"),
    trustProxyHops,
    apiTlsCertFile: env.API_TLS_CERT_FILE || undefined,
    apiTlsKeyFile: env.API_TLS_KEY_FILE || undefined,
  };
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid ${name}: ${raw}`);
  return n;
}
