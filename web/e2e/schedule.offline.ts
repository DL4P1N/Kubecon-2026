import { test, expect } from "@playwright/test";

test("production worker restores a session schedule offline, keeps QR fresh and caches no secrets", async ({ page, context }) => {
  await page.addInitScript(() => { if (!sessionStorage.getItem("cc.token")) sessionStorage.setItem("cc.token", "synthetic-session-secret"); });
  await page.goto("/schedule");
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Synthetic offline schedule" })).toBeVisible();
  await page.evaluate(async () => {
    await fetch("/api/talks/offline-demo");
    await fetch("/api/register", { method: "POST" });
    await fetch("/otlp/v1/traces", { method: "POST", body: "{}" });
  });
  await page.getByRole("button", { name: "Show room QR" }).click();
  await expect(page.getByAltText("Short-lived room check-in QR code")).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByAltText("Short-lived room check-in QR code")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Synthetic offline schedule" })).toBeVisible();
  await expect(page.getByText(/Offline: showing schedule saved at/)).toBeVisible();
  await expect(page.getByText(/QR needs a connection/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Show room QR" })).toBeDisabled();
  const detail = await page.evaluate(() => fetch("/api/talks/offline-demo").then((res) => res.json()));
  expect(detail.talk.title).toBe("Synthetic offline schedule");
  expect(await page.evaluate(async () => {
    try { await fetch("/api/access/token", { method: "POST" }); return false; } catch { return true; }
  })).toBe(true);
  expect(await page.evaluate(async () => {
    try { await fetch("/otlp/v1/traces", { method: "POST", body: "{}" }); return false; } catch { return true; }
  })).toBe(true);
  const stored = await page.evaluate(async () => {
    const entries: string[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const key of await cache.keys()) {
        entries.push(key.url, JSON.stringify([...key.headers]), await (await cache.match(key))!.text());
      }
    }
    return entries.join("\n");
  });
  for (const secret of ["synthetic-session-secret", "synthetic-qr-secret", "synthetic-registration-secret", "Private recommendation", "/api/register", "/api/access/token", "/otlp/"]) {
    // App source assets contain endpoint strings; inspect only personal/public data caches for URLs.
    if (!secret.startsWith("/")) expect(stored).not.toContain(secret);
  }
  const forbiddenKeys = await page.evaluate(async () => {
    const keys = (await Promise.all((await caches.keys()).map(async (name) => (await (await caches.open(name)).keys()).map((key) => key.url)))).flat();
    return keys.filter((url) => /\/api\/(register|access)|\/otlp\//.test(url));
  });
  expect(forbiddenKeys).toEqual([]);
  // A second tab has no namespace for this attendee's cached response.
  const other = await context.newPage();
  await other.goto("/schedule");
  await expect(other.getByRole("heading", { name: "Synthetic offline schedule" })).toHaveCount(0);
  await expect(other.getByRole("link", { name: "Register now" })).toBeVisible();
});

for (const failure of ["expired cache", "authentication rejected"] as const) {
  test(`does not restore a schedule after ${failure}`, async ({ page, context }) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem("cc.token")) sessionStorage.setItem("cc.token", "synthetic-session"); });
    await page.goto("/schedule");
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Synthetic offline schedule" })).toBeVisible();
    if (failure === "expired cache") {
      await page.evaluate(async () => {
        const cache = await caches.open("cc-schedules-v1");
        const [key] = await cache.keys();
        const response = (await cache.match(key!))!;
        const headers = new Headers(response.headers);
        headers.set("x-cc-offline-until", "1");
        await cache.put(key!, new Response(await response.text(), { headers }));
      });
    } else {
      // Establish the persisted entry, then load an actually offline document.
      // Chromium may dispatch offline before its worker network emulation flips.
      await expect.poll(() => page.evaluate(async () => {
        const cache = await caches.open("cc-schedules-v1");
        const [key] = await cache.keys();
        return key ? (await cache.match(key))?.headers.has("x-cc-offline-saved-at") : false;
      })).toBe(true);
      await context.setOffline(true);
      await page.reload();
      await expect(page.getByText(/Offline: showing schedule saved at/)).toBeVisible();
      // Record what the page asked for and how it was answered, so a failure shows whether the online event
      // fired and whether the worker answered from its saved copy or from the network.
      const trace: string[] = [];
      page.on("response", (res) => { if (new URL(res.url()).pathname === "/api/schedule") trace.push(`${res.status()} fromServiceWorker=${res.fromServiceWorker()} savedAt=${res.headers()["x-cc-offline-saved-at"] ?? "-"}`); });
      await page.evaluate(() => { (window as unknown as { onlineEvents: number }).onlineEvents = 0; window.addEventListener("online", () => { (window as unknown as { onlineEvents: number }).onlineEvents++; }); });
      await page.evaluate(() => sessionStorage.setItem("cc.token", "expired"));
      await context.setOffline(false);
      try {
        await expect(page.getByRole("link", { name: "Register now" })).toBeVisible();
      } catch (error) {
        const state = await page.evaluate(() => ({ onLine: navigator.onLine, onlineEvents: (window as unknown as { onlineEvents: number }).onlineEvents }));
        await test.info().attach("schedule-requests", { body: JSON.stringify({ ...state, trace }, null, 2), contentType: "application/json" });
        throw new Error(`${(error as Error).message}\nnavigator.onLine=${state.onLine} onlineEvents=${state.onlineEvents} /api/schedule responses: ${trace.join(" | ") || "none"}`);
      }
      await expect(page.getByRole("heading", { name: "Synthetic offline schedule" })).toHaveCount(0);
      await expect(page.getByText(/Offline: showing schedule saved at/)).toHaveCount(0);
      expect(await page.evaluate(async () => (await (await caches.open("cc-schedules-v1")).keys()).length)).toBe(0);
    }
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "My schedule", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Synthetic offline schedule" })).toHaveCount(0);
    await expect(page.getByRole("alert")).toBeVisible();
  });
}
