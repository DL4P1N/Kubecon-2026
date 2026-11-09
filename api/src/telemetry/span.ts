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
        span.setAttribute("error.type", err instanceof Error ? err.name : "unknown");
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

export function withSpan<T>(name: string, attrs: SpanAttributes, fn: (span: ActiveSpan) => T | Promise<T>): Promise<T> {
  return runner(name, attrs, async (span) => fn(span));
}
