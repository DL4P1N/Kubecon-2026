import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// An explicitly labelled UI fallback, never evidence of live backend behavior.
test("record labelled offline UI fallback", async ({ browser }) => {
  test.skip(process.env.RECORD_DEMO !== "1", "Set RECORD_DEMO=1 to generate fallback artifacts");
  test.setTimeout(90_000);
  const output = resolve("../docs/demo");
  mkdirSync(output, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 },
    recordVideo: { dir: resolve("test-results/demo-video"), size: { width: 1280, height: 900 } } });
  const page = await context.newPage();
  const video = page.video()!;
  const talk = { id: "synthetic-talk", title: "DEMO: Secure a Kubernetes supply chain", speaker: "Synthetic demo speaker",
    abstract: "A synthetic session for the offline UI fallback.", room: "DEMO Room A", track: "Security",
    start: "2026-11-09T20:00:00Z", end: "2026-11-09T20:30:00Z", tags: ["kubernetes", "security"] };
  let scans = 0;
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const banner = document.createElement("aside");
      banner.textContent = "OFFLINE UI FALLBACK — Mock API + synthetic data. Not live Elasticsearch, access-control or telemetry evidence.";
      banner.style.cssText = "position:fixed;bottom:0;left:0;right:0;z-index:9999;background:#111827;color:white;padding:16px;font:16px system-ui;text-align:center";
      document.body.append(banner);
    });
  });
  await page.route("**/otlp/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path === "/api/catalog/topics" ? { topics: talk.tags }
      : path === "/api/register" ? { attendeeId: "synthetic", token: "synthetic-session-not-valid", expiresAt: "" }
      : path === "/api/onboarding" ? { query: { text: "kubernetes security", topics: talk.tags, mode: "hybrid" } }
      : path === "/api/search" ? { q: "kubernetes security", mode: "hybrid", tookMs: 0, hits: [{ talk, score: 1 }] }
      : path === "/api/schedule" ? { items: [{ talk, reason: "Synthetic recommendation for UI rehearsal" }], updatedAt: "" }
      : path === "/api/access/token" ? { token: "synthetic-qr-not-valid", expiresAt: new Date(Date.now() + 60000).toISOString() }
      : { decision: ++scans === 1 ? "allow" : "deny", room: talk.room, reason: "not_entitled" };
    return route.fulfill({ json });
  });
  try {
    // Sign-up is the static site (/site/register.html) now; this React-app recording starts from a synthetic session.
    await page.addInitScript(() => sessionStorage.setItem("cc.token", "synthetic-session-not-valid"));
    await page.goto("http://127.0.0.1:4173/onboarding");
    await page.getByLabel("kubernetes", { exact: true }).check();
    await page.screenshot({ path: resolve(output, "fallback-onboarding.png") });
    await page.waitForTimeout(1800);
    await page.getByLabel("What would you like to learn, in your own words?").fill("Secure my Kubernetes supply chain");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Find talks" }).click();
    await expect(page.getByRole("heading", { name: "My schedule" })).toBeVisible();
    await page.getByRole("button", { name: "Show room QR" }).click();
    await expect(page.getByAltText("Short-lived room check-in QR code")).toBeVisible();
    await page.screenshot({ path: resolve(output, "fallback-schedule.png") });
    await page.waitForTimeout(1800);
    await page.getByRole("link", { name: "Search", exact: true }).click();
    await page.getByLabel("Query", { exact: true }).fill("Secure my Kubernetes supply chain");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("Comparison ready.")).toBeVisible();
    await page.screenshot({ path: resolve(output, "fallback-search.png") });
    await page.waitForTimeout(1800);
    await page.getByRole("link", { name: "Kiosk", exact: true }).click();
    await page.getByLabel("Room", { exact: true }).fill(talk.room);
    await page.getByLabel(/Token \(if/).fill("synthetic-qr-not-valid");
    await page.getByRole("button", { name: "Check access" }).click();
    await expect(page.getByText("Access granted", { exact: true })).toBeVisible();
    await page.waitForTimeout(1400);
    await page.getByRole("button", { name: "Check access" }).click();
    await expect(page.getByText("Access denied", { exact: true })).toBeVisible();
    await page.screenshot({ path: resolve(output, "fallback-kiosk.png") });
    await page.waitForTimeout(1800);
  } finally { await context.close(); }
  await video.saveAs(resolve(output, "offline-ui-fallback.webm"));
});
