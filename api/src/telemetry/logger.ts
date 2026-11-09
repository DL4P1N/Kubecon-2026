import type { FastifyServerOptions } from "fastify";

/**
 * Pino options for Fastify: `Fastify({ logger: loggerOptions })`.
 *
 * - JSON to stdout. When the OTel SDK is running, @opentelemetry/instrumentation-pino
 *   adds trace_id / span_id / trace_flags to every line and also sends each
 *   record to the OTLP logs exporter (so Dash0 links logs to traces).
 * - Request/response serializers only emit method, path (no query string),
 *   route and status. Headers and bodies are never serialized.
 * - Redaction is defence in depth for anything logged by hand.
 */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "authorization",
  "req.body",
  "body",
  "token",
  "attendeeId",
  "attendee_id",
  "*.attendeeId",
  "*.token",
  "*.authorization",
];

interface ReqLike {
  method?: string;
  url?: string;
  routeOptions?: { url?: string };
}

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  serializers: {
    req(req: ReqLike) {
      return {
        method: req.method,
        path: (req.url ?? "").split("?")[0],
        route: req.routeOptions?.url,
      };
    },
    res(res: { statusCode?: number }) {
      return { statusCode: res.statusCode };
    },
  },
} satisfies FastifyServerOptions["logger"];
