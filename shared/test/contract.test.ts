import { describe, expect, it } from "vitest";
import { MIN_CLUSTER_SIZE, routes } from "../src/index.js";

describe("contract", () => {
  it("lists every endpoint with an absolute path", () => {
    const paths = Object.values(routes).map((r) => r.path);
    expect(paths).toContain("/healthz");
    expect(paths).toContain("/api/access/scan");
    expect(paths.every((p) => p.startsWith("/"))).toBe(true);
  });

  it("keeps the k-anonymity minimum at 5", () => {
    expect(MIN_CLUSTER_SIZE).toBe(5);
  });
});
