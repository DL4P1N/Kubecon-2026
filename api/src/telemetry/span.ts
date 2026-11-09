/**
 * Minimal tracing seam. Application code calls `withSpan(name, attrs, fn)`;
 * until a real OpenTelemetry SDK is wired in (task #12) this is a no-op that
 * just runs `fn`. The SDK task registers an implementation with
 * `setSpanRunner`, which should start an OTel span named `name`, set the
 * attributes, run `fn`, record exceptions and end the span.
 *
 * Only attributes on the collector allowlist (docs/telemetry-allowlist.md)
 * survive export. Never put attendee IDs, locations or free text in attrs.
 */
export type SpanAttributes = Record<string, string | number | boolean>;

export interface ActiveSpan {
  setAttribute(key: string, value: string | number | boolean): void;
}

export type SpanRunner = <T>(name: string, attrs: SpanAttributes, fn: (span: ActiveSpan) => Promise<T>) => Promise<T>;

const noopSpan: ActiveSpan = { setAttribute() {} };

const noopRunner: SpanRunner = (_name, _attrs, fn) => fn(noopSpan);

let runner: SpanRunner = noopRunner;

/** Install (or with no argument, reset) the span implementation. */
export function setSpanRunner(next?: SpanRunner): void {
  runner = next ?? noopRunner;
}

export function withSpan<T>(name: string, attrs: SpanAttributes, fn: (span: ActiveSpan) => Promise<T>): Promise<T> {
  return runner(name, attrs, fn);
}
