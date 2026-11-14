import { defineConfig } from "@playwright/test";

// E2E_PORT moves the server (default 4173). E2E_TARGET=dist serves the production build (`vite preview`,
// run `npm run build -w web` first) instead of the dev server, to prove dist/site is complete.
const port = Number(process.env.E2E_PORT ?? 4173);
const origin = `http://127.0.0.1:${port}`;
const command = process.env.E2E_TARGET === "dist"
  ? `npm run preview -- --host 127.0.0.1 --port ${port} --strictPort`
  : `npm run dev -- --host 127.0.0.1 --port ${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  use: { baseURL: origin, browserName: "chromium",
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  webServer: { command, url: origin, reuseExistingServer: !process.env.CI },
  reporter: "list",
  // axe checks contrast on both palettes: the app follows the device colour scheme
  projects: [{ name: "dark", use: { colorScheme: "dark" } }, { name: "light", use: { colorScheme: "light" } }],
});
