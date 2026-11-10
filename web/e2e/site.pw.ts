import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// The static front door (landing/, served under /site/) and the redirects into it.
const pages = [
  { path: "/site/index.html", title: /Conference Companion/, heading: "h1" },
  { path: "/site/conference.html?c=cloud-native-hackathon-slc-2026", title: /./, heading: "h1" },
  { path: "/site/register.html?c=cloud-native-hackathon-slc-2026", title: /./, heading: "h1" },
  { path: "/site/profile.html", title: /Your profile/, heading: "h1" },
];

// The pages call /site/api/* (config, status, chat, register, events) and fall back to local behaviour when the
// endpoint is missing; with no API running those 404s are expected, so /api/ is excluded from the checks below.
const isApi = (url: string) => /\/api\//.test(new URL(url).pathname);

function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url;
    if (url && isApi(url)) return;
    problems.push(`console.error: ${message.text()} ${url}`);
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (new URL(url).origin === new URL(page.url() === "about:blank" ? url : page.url()).origin && !isApi(url)) {
      problems.push(`requestfailed: ${url} ${request.failure()?.errorText}`);
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.startsWith("http://127.0.0.1") && !isApi(url) && response.status() >= 400) problems.push(`HTTP ${response.status()}: ${url}`);
  });
  return problems;
}

test("/ redirects to /site/ and shows the static home page", async ({ page }) => {
  const response = await page.request.get("/", { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers()["location"]).toBe("/site/");
  await page.goto("/");
  await expect(page).toHaveURL(/\/site\/$/);
  await expect(page.locator("h1").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Skip to content" })).toHaveCount(1);
});

test("/site and /site/ both serve the static index, not the SPA shell", async ({ page }) => {
  for (const path of ["/site", "/site/"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/site\/$/);
    expect(await page.locator("#root").count()).toBe(0);
  }
});

test("/register sends the browser to /site/register.html and keeps the query string", async ({ page }) => {
  await page.goto("/register?c=cloud-native-hackathon-slc-2026&via=github");
  await expect(page).toHaveURL(/\/site\/register\.html\?c=cloud-native-hackathon-slc-2026&via=github$/);
  await page.goto("/register");
  await expect(page).toHaveURL(/\/site\/register\.html$/);
});

test("React routes still work beside the site (SPA fallback)", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.goto("/search");
  await expect(page.getByRole("heading", { level: 1, name: "Search talks" })).toBeVisible();
  await expect(page).toHaveURL(/\/search$/);
  // The app header's logo leads back to the static home.
  await page.getByRole("link", { name: "Conference Companion" }).first().click();
  await expect(page).toHaveURL(/\/site\/$/);
});

for (const { path, title, heading } of pages) {
  test(`${path.split("?")[0]} loads with no console errors and no failed same-origin requests`, async ({ page }) => {
    const problems = watch(page);
    await page.goto(path, { waitUntil: "load" });
    await expect(page).toHaveTitle(title);
    await expect(page.locator(heading).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(problems).toEqual([]);
  });

  for (const width of [375, 1280]) {
    test(`${path.split("?")[0]} at ${width}px has no serious or critical accessibility violations`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path, { waitUntil: "load" });
      await expect(page.locator(heading).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(report.violations.filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target.join(" ")).slice(0, 6) }))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}
