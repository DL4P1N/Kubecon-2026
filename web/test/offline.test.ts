import { beforeEach, expect, it, vi } from "vitest";
import { offlineExpiry, offlineSession, resetOfflineSession } from "../src/offline.js";
beforeEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });

it("uses random stable tab namespaces and rotates them when registration changes", () => {
  const first = offlineSession();
  expect(first).toMatch(/^[0-9a-f-]{36}$/);
  expect(offlineSession()).toBe(first);
  resetOfflineSession();
  expect(offlineSession()).not.toBe(first);
});

it("caps saved schedules by JWT expiry and 24 hours", () => {
  vi.spyOn(Date, "now").mockReturnValue(100000);
  const jwt = (exp: number) => `header.${btoa(JSON.stringify({ exp }))}.signature`;
  expect(offlineExpiry(jwt(150))).toBe(150000);
  expect(offlineExpiry(jwt(999999999))).toBe(86500000);
  expect(offlineExpiry(jwt(1))).toBe(1000);
});
