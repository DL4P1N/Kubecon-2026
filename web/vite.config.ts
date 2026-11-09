/// <reference types="vitest/config" />
import { cpSync, lstatSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, "public");
const siteLink = join(publicDir, "site");

// The static front door lives in ../landing and is served under /site/. In dev the live files
// are reached through the gitignored symlink web/public/site -> ../../landing (recreated here if a
// fresh checkout or CI does not have it yet). Production copies a filtered subset instead
// (scripts/sync-site.mjs), so the symlink is never copied into dist.
function ensureSiteLink() {
  try {
    lstatSync(siteLink);
  } catch {
    try { symlinkSync("../../landing", siteLink, "dir"); } catch { /* read-only checkout: /site/ is simply absent */ }
  }
}
ensureSiteLink();

function siteFrontDoor(): Plugin {
  const handler = (req: { method?: string; url?: string }, res: any, next: () => void) => {
    const path = (req.url ?? "/").split(/[?#]/)[0]!;
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (isRead && path === "/") {
      res.statusCode = 302;
      res.setHeader("location", "/site/");
      return res.end();
    }
    if (isRead && path === "/site") {
      res.statusCode = 302;
      res.setHeader("location", "/site/");
      return res.end();
    }
    // /site/ serves the landing index (Vite's public middleware does not serve directory indexes).
    if (isRead && path === "/site/") {
      req.url = "/site/index.html" + (req.url!.slice(path.length));
    }
    next();
  };
  return {
    name: "cc-site-front-door",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

// Build only: copy public/ without the `site` symlink (landing is 37 MB of kit, previews and tests;
// scripts/sync-site.mjs publishes only what the pages use into dist/site).
function copyPublicWithoutSite(): Plugin {
  let outDir = "";
  return {
    name: "cc-copy-public-without-site",
    apply: "build",
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      for (const entry of readdirSync(publicDir)) {
        if (entry === "site") continue;
        cpSync(join(publicDir, entry), join(outDir, entry), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), siteFrontDoor(), copyPublicWithoutSite()],
  build: { copyPublicDir: false },
  define: { "import.meta.env.NAV_ESTIMATOR": JSON.stringify(process.env.NAV_ESTIMATOR === "on" ? "on" : "off") },
  server: {
    port: 5173,
    // Dev: forward API calls to the Fastify server.
    proxy: {
      "/api": process.env.API_URL ?? "http://localhost:3000",
      // The static pages resolve their endpoints relative to the module (../api/x from /site/js/ = /site/api/x):
      // map them onto the real API's /api/x (same as nginx).
      "/site/api": {
        target: process.env.API_URL ?? "http://localhost:3000",
        rewrite: (path) => path.replace(/^\/site/, ""),
      },
      "/healthz": process.env.API_URL ?? "http://localhost:3000",
      // Browser RUM -> local OTel collector (OTLP/HTTP).
      "/otlp": {
        target: process.env.OTLP_URL ?? "http://localhost:4318",
        rewrite: (path) => path.replace(/^\/otlp/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    // Only the web app's own tests: web/public/site is a symlink to ../landing, which has its own node:test suite.
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
