/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev: forward API calls to the Fastify server.
    proxy: {
      "/api": process.env.API_URL ?? "http://localhost:3000",
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
  },
});
