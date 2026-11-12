import { SpanStatusCode, trace } from "@opentelemetry/api";
import { SPAN_ATTRIBUTE_ALLOWLIST, pickAllowed } from "./allowlist.js";

/**
 * Tracing seam for application code: `withSpan(name, attrs, fn)`.
 *
 * The default runner starts a real OpenTelemetry span (a no-op when the SDK in
 * instrument.ts is not running, e.g. in tests). Attribute keys that are not on
 * SPAN_ATTRIBUTE_ALLOWLIST (docs/telemetry-allowlist.md) are dropped, both at
 * start and via `span.setAttribute`, so e.g. `attendee.id` can never be
 * attached by accident. Errors set status ERROR and `error.type` (class name
 * only, never the message, which may echo user input) and are rethrown.
 *
 * Tests can swap the implementation with `setSpanRunner(fake)` and restore
 * the default with `setSpanRunner()`.
 */
export type SpanAttributes = Record<string, string | number | boolean>;

export interface ActiveSpan {
  setAttribute(key: string, value: string | number | boolean): void;
}

export type SpanRunner = <T>(name: string, attrs: SpanAttributes, fn: (span: ActiveSpan) => Promise<T>) => Promise<T>;

export const TRACER_NAME = "companion-api";

/** Safe `errorType` set on a database error by `runQuery` (a SQLSTATE or Node error code), if any. */
const errorTypeOf = (err: unknown): string | undefined => {
  const t = (err as { errorType?: unknown } | null)?.errorType;
  return typeof t === "string" ? t : undefined;
};

const isAllowed = (key: string) => (SPAN_ATTRIBUTE_ALLOWLIST as readonly string[]).includes(key);

export const otelRunner: SpanRunner = (name, attrs, fn) =>
  trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(name, { attributes: pickAllowed(attrs, SPAN_ATTRIBUTE_ALLOWLIST) }, async (span) => {
      const active: ActiveSpan = {
        setAttribute(key, value) {
          if (isAllowed(key)) span.setAttribute(key, value);
        },
      };
      try {
        return await fn(active);
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        // Prefer the SQLSTATE/error code (e.g. 57P01) over the generic class name.
        span.setAttribute("error.type", errorTypeOf(err) ?? (err instanceof Error ? err.name : "unknown"));
        throw err;
      } finally {
        span.end();
      }
    });

let runner: SpanRunner = otelRunner;

/** Install (or with no argument, reset to the OpenTelemetry default) the span implementation. */
export function setSpanRunner(next?: SpanRunner): void {
  runner = next ?? otelRunner;
}

/**
 * Runs `fn` in a span. When it throws an error carrying a string `errorType`
 * (database failures, see `runQuery`), that type is recorded as the
 * allowlisted `error.type` attribute before the error propagates. Only the type
 * is recorded: never the message, which can contain query text.
 */
export function withSpan<T>(name: string, attrs: SpanAttributes, fn: (span: ActiveSpan) => T | Promise<T>): Promise<T> {
  return runner(name, attrs, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      const type = errorTypeOf(err);
      if (type !== undefined) span.setAttribute("error.type", type);
      throw err;
    }
  });
}
