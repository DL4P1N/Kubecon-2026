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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    esUrl: env.ES_URL ?? "http://localhost:9200",
    esUsername: env.ES_USERNAME ?? "",
    esPassword: env.ES_PASSWORD ?? "",
    tokenSigningKey: env.TOKEN_SIGNING_KEY ?? "dev-only-insecure-key",
    otelExporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
    nodeEnv: env.NODE_ENV ?? "development",
    registerRateLimitPerMinute: positiveInt(env.REGISTER_RATE_LIMIT_PER_MINUTE, 60, "REGISTER_RATE_LIMIT_PER_MINUTE"),
  };
}

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid ${name}: ${raw}`);
  return n;
}
