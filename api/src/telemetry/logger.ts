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

/** Removes query strings from URLs embedded in free-text log messages. */
export function stripQueryStrings(text: string): string {
  return text.replace(/\?[^\s"']*/g, "?[redacted]");
}

export const loggerOptions = {
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
  redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  hooks: {
    // Fastify's own messages (e.g. the 404 "Route GET:/api/x?q=... not found")
    // embed the raw URL. Scrub query strings from every string argument before
    // it reaches stdout or the OTLP log body.
    // Fastify's error handler also logs `err.message` as the message text; that
    // can echo user input or document ids, so it is replaced by the error type.
    logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
      const first = args[0] as { err?: unknown } | Error | undefined;
      const err = first instanceof Error ? first : first && typeof first === "object" ? first.err : undefined;
      const errMessage = err instanceof Error ? err.message : undefined;
      method.apply(
        this,
        args.map((a) => {
          if (typeof a !== "string") return a;
          if (errMessage !== undefined && a === errMessage) return `${(err as Error).name} (message redacted)`;
          return stripQueryStrings(a);
        }),
      );
    },
  },
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
    // Error messages and stacks can echo user input or document ids: keep type and codes only.
    err(err: { name?: string; code?: unknown; statusCode?: unknown }) {
      return {
        type: err?.name ?? "Error",
        message: "[redacted]",
        stack: "[redacted]",
        code: err?.code,
        statusCode: err?.statusCode,
      };
    },
  },
} satisfies FastifyServerOptions["logger"];
