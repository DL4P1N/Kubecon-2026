import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e", testMatch: "**/*.offline.ts", workers: 1,
  use: { baseURL: "http://127.0.0.1:4174", browserName: "chromium",
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  webServer: { command: "node e2e/offline-server.mjs", url: "http://127.0.0.1:4174", reuseExistingServer: false },
});
