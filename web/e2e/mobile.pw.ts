import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const before = process.env.MOBILE_CAPTURE_BEFORE === "1";
const capture = before || process.env.MOBILE_CAPTURE === "1";
const talk = { id: "mobile-demo", title: "Synthetic mobile layout: Kubernetes security", speaker: "Demo speaker",
  abstract: "Synthetic fixture for a viewport test.", room: "Demo Room A", track: "Security",
  start: "2026-11-09T20:00:00Z", end: "2026-11-09T20:30:00Z", tags: ["kubernetes"] };
const status = { status: "ok", generatedAt: new Date().toISOString(), windowSeconds: 300,
  api: { up: true, version: "demo" }, elasticsearch: { reachable: true },
  search: { keyword: { samples: 5, p95Ms: 25 }, hybrid: { state: "ready", samples: 5, p95Ms: 120 } },
  errorRate: { requests: 20, serverErrors: 0, ratio: 0 } };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("cc.token", "synthetic-mobile-session"));
  await page.route("**/otlp/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path === "/api/status" ? status
      : path === "/api/catalog/topics" ? { topics: talk.tags }
      : path === "/api/search" ? { q: "security", mode: "hybrid", tookMs: 1, hits: [{ talk, score: 1 }] }
      : path === "/api/schedule" ? { items: [{ talk, reason: "Synthetic layout fixture" }], updatedAt: "" }
      : path === "/api/access/token" ? { token: "synthetic-mobile-qr-not-valid", expiresAt: new Date(Date.now() + 60000).toISOString() }
      : path === "/api/interests/aggregate" ? { topics: [{ topic: "kubernetes", count: 10 }], suppressedBelow: 5, totalOptedIn: 10, generatedAt: "" }
      : { rooms: [], source: "in-process-scan-activity", windowMinutes: 10 };
    return route.fulfill({ json });
  });
});

for (const width of [375, 768]) {
  for (const path of ["onboarding", "schedule", "search", "map", "status", "kiosk"]) {
    test(`mobile ${path} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 1024 });
      await page.goto(`/${path}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.getByRole("link", { name: /All systems normal/ })).toBeVisible();
      if (path === "onboarding") await expect(page.getByLabel("kubernetes", { exact: true })).toBeVisible();
      if (path === "schedule") {
        await page.getByRole("button", { name: "Show room QR" }).click();
        const qr = page.getByAltText("Short-lived room check-in QR code");
        await expect(qr).toBeVisible();
        expect((await qr.boundingBox())!.width).toBeGreaterThanOrEqual(240);
        await expect(page.getByText("Text alternative for the kiosk")).toBeVisible();
      }
      if (path === "search") {
        await page.getByLabel("Query", { exact: true }).fill("security");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await expect(page.getByText("Comparison ready.")).toBeVisible();
        if (width === 375) {
          const keyword = await page.getByRole("region", { name: "Keyword", exact: true }).boundingBox();
          const hybrid = await page.getByRole("region", { name: "Hybrid", exact: true }).boundingBox();
          expect(hybrid!.y).toBeGreaterThan(keyword!.y + keyword!.height - 1);
        }
      }
      if (path === "map") await expect(page.getByRole("table")).toBeVisible();
      if (path === "status") await expect(page.getByRole("table")).toBeVisible();
      if (capture) {
        const folder = resolve("../docs/demo"); mkdirSync(folder, { recursive: true });
        await page.screenshot({ path: resolve(folder, `mobile-${before ? "before" : "after"}-${path}-${width}.png`), fullPage: true });
      }
      if (before) return; // Capture the baseline only, not a claim that old targets passed.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const tooSmall = await page.locator("a,button,input,select,textarea,summary").evaluateAll((elements) => elements.flatMap((element) => {
        const target = element instanceof HTMLInputElement && element.type === "checkbox" ? element.closest("label") ?? element : element;
        const rectangle = target.getBoundingClientRect();
        const style = getComputedStyle(target);
        if (rectangle.width === 0 || rectangle.height === 0 || style.visibility === "hidden" || rectangle.bottom < 0) return [];
        return rectangle.width < 44 || rectangle.height < 44 ? [`${element.tagName}:${element.textContent?.trim().slice(0, 30)} ${rectangle.width}x${rectangle.height}`] : [];
      }));
      expect(tooSmall).toEqual([]);
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(axe.violations.filter((issue) => issue.impact === "serious" || issue.impact === "critical")).toEqual([]);
    });
  }
}
