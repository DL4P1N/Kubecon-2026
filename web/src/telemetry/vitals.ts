import type { Meter } from "@opentelemetry/api";
import { onCLS, onINP, onLCP, onTTFB } from "web-vitals";

/** Bounded templates only: never emit a path segment supplied by a user. */
export function pageRoute(pathname: string): string {
  if (["/", "/register", "/onboarding", "/schedule", "/search", "/kiosk", "/map", "/clusters", "/status", "/nav-demo"].includes(pathname)) return pathname;
  if (/^\/talks\/[^/]+$/.test(pathname)) return "/talks/:id";
  return "/unknown";
}

/** Document-level measurements stay attributed to the initial document route. */
export function registerVitals(meter: Meter, pathname: string, flush: () => Promise<void>): void {
  const attributes = { "http.route": pageRoute(pathname) };
  const latencyBuckets = [0, 0.025, 0.05, 0.1, 0.2, 0.5, 0.8, 1, 2.5, 4, 10];
  for (const [name, register] of [["lcp", onLCP], ["inp", onINP], ["cls", onCLS], ["ttfb", onTTFB]] as const) {
    const histogram = meter.createHistogram(`companion.web.vitals.${name}`, {
      unit: name === "cls" ? "1" : "s",
      description: `Document ${name.toUpperCase()} reported by web-vitals`,
      advice: { explicitBucketBoundaries: name === "cls" ? [0, 0.01, 0.05, 0.1, 0.25, 0.5, 1] : latencyBuckets },
    });
    register(({ value }) => {
      if (!Number.isFinite(value) || value < 0) return;
      histogram.record(name === "cls" ? value : value / 1000, attributes);
      // Callbacks may run after visibilitychange; flush the new sample too.
      void flush().catch(() => {});
    });
  }
}
