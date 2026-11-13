import { defineConfig } from "vitest/config";

// Most API tests start an in-process Postgres (PGlite with pgvector); under parallel load that takes
// longer than the 5 s default.
export default defineConfig({ test: { testTimeout: 20_000, hookTimeout: 30_000 } });
