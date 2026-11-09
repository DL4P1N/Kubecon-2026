import { afterEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), run: vi.fn() }));
vi.mock("../src/telemetry/sdk.js", () => ({ startTelemetry: hooks.start, shutdownTelemetry: hooks.stop }));
vi.mock("../src/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../src/es/client.js", () => ({ createEsClient: () => ({}) }));
vi.mock("../src/retention.js", () => ({ runRetention: hooks.run }));
const originalExitCode = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.resetModules(); process.exitCode = originalExitCode; });

it("starts telemetry before cleanup and flushes after success", async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  hooks.run.mockResolvedValueOnce(3);
  await import("../src/retention-cli.js");
  expect(hooks.start).toHaveBeenCalledWith("companion-retention");
  expect(hooks.stop).toHaveBeenCalledOnce();
  expect(hooks.start.mock.invocationCallOrder[0]).toBeLessThan(hooks.run.mock.invocationCallOrder[0]!);
  expect(hooks.run.mock.invocationCallOrder[0]).toBeLessThan(hooks.stop.mock.invocationCallOrder[0]!);
});
it("flushes on failure without printing ES error details", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  hooks.run.mockRejectedValueOnce(new Error("private document data"));
  await import("../src/retention-cli.js");
  expect(process.exitCode).toBe(1);
  expect(hooks.stop).toHaveBeenCalledOnce();
  expect(errorLog).toHaveBeenCalledWith("Retention cleanup failed");
});
