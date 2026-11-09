import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const talk = { id: "synthetic", title: "Kubernetes security", speaker: "Demo", abstract: "Supply chain security",
  track: "Security", room: "Demo room", start: "2026-11-09T10:00:00Z", end: "2026-11-09T11:00:00Z", tags: ["kubernetes"] };
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const response = path === "/api/search" ? { q: "", mode: "hybrid", tookMs: 1, hits: [{ talk, score: 1 }] }
      : path === "/api/schedule" ? { items: [{ talk, reason: "Matches your interests" }], updatedAt: "" }
      : path === "/api/register" ? { token: "synthetic-token", attendeeId: "synthetic", expiresAt: "" }
      : path === "/api/onboarding" ? { query: { text: "kubernetes", topics: [], mode: "hybrid" } }
      : path === "/api/interests/clusters" ? { runId: "run-demo", computedAt: "2026-11-09T12:00:00Z", suppressed: 4, minClusterSize: 5,
        clusters: [{ id: "c1", label: "Kubernetes + Helm", size: 13, topInterests: ["kubernetes", "helm"], other: false },
          { id: "other", label: "Other", size: 6, topInterests: [], other: true }] }
      : path === "/api/access/token" ? { token: "synthetic-checkin", expiresAt: new Date(Date.now() + 60000).toISOString() }
      : { decision: "allow", room: "Demo room" };
    await route.fulfill({ json: response });
  });
});

for (const width of [375, 1280]) {
  for (const path of ["register", "onboarding", "schedule", "search", "kiosk", "map"]) {
    test(`${path} at ${width}px has no serious or critical accessibility violations`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${path}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      if (path === "register" || path === "onboarding") await expect(page.getByLabel("kubernetes", { exact: true })).toBeVisible();
      if (path === "map") await expect(page.getByText("Kubernetes + Helm")).toBeVisible();
      if (path === "schedule") {
        await expect(page.getByText(talk.title)).toBeVisible();
        await page.getByRole("button", { name: "Show room QR" }).click();
        await expect(page.getByAltText("Short-lived room check-in QR code")).toBeVisible();
      }
      if (path === "search") {
        await page.getByLabel("Query", { exact: true }).fill("security");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await expect(page.getByText("Comparison ready.")).toBeVisible();
      }
      const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(report.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}

test("keyboard-only registration follows labels and keeps optional consent off", async ({ page }) => {
  await page.goto("/register");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
  expect(await page.getByLabel("Name", { exact: true }).evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  await page.keyboard.type("Demo Attendee");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Email")).toBeFocused();
  await page.keyboard.type("demo@example.com");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("kubernetes", { exact: true })).toBeFocused();
  await page.keyboard.press("Space");
  await expect(page.getByLabel("kubernetes", { exact: true })).toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel(/Include my interests/)).not.toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel(/Allow QR/)).not.toBeChecked();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Register", exact: true })).toBeFocused();
  const registerRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/register");
  await page.keyboard.press("Enter");
  expect((await registerRequest).postDataJSON()).toMatchObject({
    interests: ["kubernetes"], consent: { clusterMap: false, qrCheckin: false },
  });
  await expect(page.getByRole("heading", { name: "Onboarding", exact: true })).toBeVisible();
});
