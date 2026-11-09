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
    },
  },
  test: {
    environment: "jsdom",
  },
});
