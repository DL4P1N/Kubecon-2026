import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), run: vi.fn() }));
vi.mock("../src/telemetry/sdk.js", () => ({ startTelemetry: hooks.start, shutdownTelemetry: hooks.stop }));
vi.mock("../src/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../src/es/client.js", () => ({ createEsClient: () => ({}) }));
vi.mock("../src/clusters/job.js", () => ({ runClusterJob: hooks.run }));
const originalExitCode = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.resetModules(); process.exitCode = originalExitCode; });

it("starts telemetry before the job and flushes after success", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  hooks.run.mockResolvedValueOnce({ runId: "run-1", attendees: 40, skipped: 0, k: 5, shown: 5, suppressed: 0 });
  await import("../src/clusters/cli.js");
  expect(hooks.start).toHaveBeenCalledWith("companion-clusters");
  expect(hooks.stop).toHaveBeenCalledOnce();
  expect(hooks.start.mock.invocationCallOrder[0]).toBeLessThan(hooks.run.mock.invocationCallOrder[0]!);
  expect(hooks.run.mock.invocationCallOrder[0]).toBeLessThan(hooks.stop.mock.invocationCallOrder[0]!);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("clusters.run run-1: 40 opted-in attendees"));
  expect(process.exitCode).toBe(originalExitCode);
});

it("flushes on failure and prints no error message or ES body", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  hooks.run.mockRejectedValueOnce(Object.assign(new Error("private document data"), { errorType: "inference_exception" }));
  await import("../src/clusters/cli.js");
  expect(process.exitCode).toBe(1);
  expect(hooks.stop).toHaveBeenCalledOnce();
  expect(errorLog).toHaveBeenCalledWith("Cluster job failed (inference_exception)");
  expect(JSON.stringify(errorLog.mock.calls)).not.toContain("private document data");
});

it("falls back to the error class name when there is no safe ES type", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  hooks.run.mockRejectedValueOnce(new TypeError("secret"));
  await import("../src/clusters/cli.js");
  expect(errorLog).toHaveBeenCalledWith("Cluster job failed (TypeError)");
});
