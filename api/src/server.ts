import Fastify, { type FastifyInstance } from "fastify";
import {
  routes,
  type HealthResponse,
} from "@cc/shared";
import type { Config } from "./config.js";
import { createEsClient, type EsClient } from "./es/client.js";
import { createTokenService, type TokenService } from "./auth/token.js";
import { createEmbedder } from "./es/embeddings.js";
import { loggerOptions } from "./telemetry/logger.js";
import { accessRoutes } from "./routes/access.js";
import { registerInterestRoutes } from "./routes/interests.js";
import { registerRoutes } from "./routes/register.js";
import { registerSearchRoutes, type SearchRouteDeps } from "./routes/search.js";

const VERSION = "0.1.0";

export interface ServerDeps {
  /** Elasticsearch client; tests inject a fake. Defaults to one built from config. */
  es?: EsClient;
  /** Overrides for the search/onboarding/schedule routes (attendee resolver, store, clock). */
  search?: Omit<SearchRouteDeps, "es">;
  /** Attendee token service; defaults to HS256 with TOKEN_SIGNING_KEY. */
  tokens?: TokenService;
}

/**
 * Builds the Fastify app. Search, onboarding and schedule are real
 * (Elasticsearch, see routes/search.ts), as are registration and /api/me
 * (routes/register.ts); the remaining /api routes are STUBS
 * returning contract-shaped mock data until their tasks land.
 */
export function buildServer(config: Config, deps: ServerDeps = {}): FastifyInstance {
  // Refuses to start with a missing (or, in production, placeholder) signing key.
  const tokens = deps.tokens ?? createTokenService({ key: config.tokenSigningKey, nodeEnv: config.nodeEnv });
  const es = deps.es ?? createEsClient(config);
  const embedder = createEmbedder(process.env, es);
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: config.trustProxyHops > 0
      ? (_address: string, hop: number) => hop < config.trustProxyHops
      : false,
  });

  app.get(routes.health.path, async (): Promise<HealthResponse> => ({
    status: "ok",
    version: VERSION,
    time: new Date().toISOString(),
  }));

  // Module 1: POST /api/register + GET /api/me (routes/register.ts).
  app.register(registerRoutes, {
    es,
    tokens,
    embed: (text) => embedder.embed(text),
    rateLimitPerMinute: config.registerRateLimitPerMinute,
  });

  registerSearchRoutes(app, { es, tokens, ...deps.search });

  // Module 3: POST /api/access/token + POST /api/access/scan (routes/access.ts).
  app.register(accessRoutes, { es, tokens });

  registerInterestRoutes(app, { es, now: deps.search?.now });

  // `config` is wired for later tasks (ES client, token signing, OTel).
  app.decorate("config", config);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}
