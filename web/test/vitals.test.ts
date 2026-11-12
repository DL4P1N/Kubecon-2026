import { beforeEach, expect, it, vi } from "vitest";
import type { Meter } from "@opentelemetry/api";
import { readFileSync } from "node:fs";
import { onCLS, onINP, onLCP, onTTFB } from "web-vitals";
import { pageRoute, registerVitals } from "../src/telemetry/vitals.js";

vi.mock("web-vitals", () => ({ onCLS: vi.fn(), onINP: vi.fn(), onLCP: vi.fn(), onTTFB: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it("registers all four callbacks and exports only values and allowlisted templates", async () => {
  const records = new Map<string, ReturnType<typeof vi.fn>>();
  const createHistogram = vi.fn((name: string) => {
    const record = vi.fn();
    records.set(name, record);
    return { record };
  });
  const flush = vi.fn().mockResolvedValue(undefined);
  registerVitals({ createHistogram } as unknown as Meter, "/talks/private-id", flush);
  for (const [name, callback] of [["cls", onCLS], ["inp", onINP], ["lcp", onLCP], ["ttfb", onTTFB]] as const) {
    expect(callback).toHaveBeenCalledTimes(1);
    const handler = vi.mocked(callback).mock.calls[0]![0];
    handler({ value: name === "cls" ? 0.1 : 250, id: "secret", entries: [{ name: "private-url?token=secret" }] } as never);
    const record = records.get(`companion.web.vitals.${name}`)!;
    expect(record).toHaveBeenCalledWith(name === "cls" ? 0.1 : 0.25, { "http.route": "/talks/:id" });
    handler({ value: NaN } as never);
    handler({ value: -1 } as never);
    expect(record).toHaveBeenCalledTimes(1);
  }
  expect(flush).toHaveBeenCalledTimes(4);
  // This exact attribute is already permitted by the API's in-process metric allowlist.
  expect(readFileSync("../api/src/telemetry/allowlist.ts", "utf8")).toContain('"http.route"');
  const clsOptions = createHistogram.mock.calls.find(([name]) => name.endsWith(".cls"));
  expect(clsOptions).toBeDefined();
});

it("bounds route cardinality and rejects query-bearing or unknown paths", () => {
  expect(pageRoute("/search")).toBe("/search");
  for (const path of ["/secret-id", "/search?email=private", "/talks/private/more"]) expect(pageRoute(path)).toBe("/unknown");
});
