import { test, expect } from "@playwright/test";

test("live catalog topics load in onboarding without API mocks", async ({ page }) => {
  test.skip(!process.env.LIVE_APP_URL, "Set LIVE_APP_URL to the deployed app origin");
  const origin = new URL(process.env.LIVE_APP_URL!).origin;
  const response = await page.request.get(`${origin}/api/catalog/topics`);
  expect(response.status()).toBe(200);
  const catalog = await response.json() as { topics: string[] };
  expect(catalog.topics.length).toBeGreaterThan(0);
  expect(new Set(catalog.topics).size).toBe(catalog.topics.length);
  const topicRequest = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/catalog/topics");
  await page.goto(`${origin}/onboarding`);
  expect((await topicRequest).status()).toBe(200);
  const checkbox = page.getByRole("checkbox", { name: catalog.topics[0]!, exact: true });
  await expect(checkbox).toBeVisible();
  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await expect(page.getByText(/Topics could not be loaded/)).toHaveCount(0);
});
