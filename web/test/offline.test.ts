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

function stubServiceWorker(value: unknown) {
  Object.defineProperty(navigator, "serviceWorker", { value, configurable: true });
}

it("forget-schedule posts to the controller when there is one", () => {
  const postMessage = vi.fn();
  const getRegistration = vi.fn();
  stubServiceWorker({ controller: { postMessage }, getRegistration });
  const previous = offlineSession();
  resetOfflineSession();
  expect(postMessage).toHaveBeenCalledWith({ type: "forget-schedule", session: previous });
  expect(getRegistration).not.toHaveBeenCalled();
});

it("forget-schedule falls back to the registration's active, waiting or installing worker", async () => {
  for (const state of ["active", "waiting", "installing"] as const) {
    const postMessage = vi.fn();
    stubServiceWorker({ controller: null, getRegistration: async () => ({ [state]: { postMessage } }) });
    sessionStorage.clear();
    const previous = offlineSession();
    resetOfflineSession();
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledWith({ type: "forget-schedule", session: previous }));
  }
  stubServiceWorker({ controller: null, getRegistration: async () => undefined });
  offlineSession();
  expect(() => resetOfflineSession()).not.toThrow();
});
