import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
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
import { registerCatalogRoutes } from "./routes/catalog.js";
import { registerRoutes } from "./routes/register.js";
import { registerClusterRoutes } from "./routes/clusters.js";
import { alternativesRoutes } from "./routes/alternatives.js";
import { suggestRoutes } from "./routes/suggest.js";
import { registerStatusRoutes } from "./routes/status.js";
import { createStatusTracker, type StatusTracker } from "./status/tracker.js";
import { registerSearchRoutes, type SearchRouteDeps } from "./routes/search.js";
import { resolveRateLimits, type RateLimitPolicy } from "./http/rateLimit.js";
import { RoomActivityCounter } from "./rooms/activity.js";
import { registerRoomRoutes } from "./routes/rooms.js";

const VERSION = "0.1.0";

export interface ServerDeps {
  /** Elasticsearch client; tests inject a fake. Defaults to one built from config. */
  es?: EsClient;
  /** Overrides for the search/onboarding/schedule routes (attendee resolver, store, clock). */
  search?: Omit<SearchRouteDeps, "es">;
  /** Attendee token service; defaults to HS256 with TOKEN_SIGNING_KEY. */
  tokens?: TokenService;
  roomActivity?: RoomActivityCounter;
  /** In-process counters behind GET /api/status; tests inject one to control time. */
  status?: StatusTracker;
  /** Per-IP rate limits (http/rateLimit.ts); tests lower them. /healthz is never limited. */
  rateLimits?: Partial<RateLimitPolicy>;
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
  const roomActivity = deps.roomActivity ?? new RoomActivityCounter();
  const app = Fastify({
    ...(config.apiTlsCertFile ? { https: {
      cert: readFileSync(config.apiTlsCertFile),
      key: readFileSync(config.apiTlsKeyFile!),
      minVersion: "TLSv1.2" as const,
    } } : {}),
    logger: loggerOptions,
    trustProxy: config.trustProxyHops > 0
      ? (_address: string, hop: number) => hop < config.trustProxyHops
      : false,
  });

  // Rolling counters for GET /api/status: status codes only, never paths, bodies or ids.
  const tracker = deps.status ?? createStatusTracker();
  const limits = resolveRateLimits(deps.rateLimits);

  // Fastify's default 404 body echoes the method and raw URL (including the query
  // string); answer with a fixed JSON shape instead.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found", message: "route not found" }));
  app.addHook("onResponse", async (req, reply) => {
    const path = req.routeOptions?.url;
    if (path === routes.health.path || path === routes.status.path) return;
    tracker.recordRequest(reply.statusCode);
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

  registerSearchRoutes(app, { es, tokens, tracker, rateLimits: limits, ...deps.search });
  app.register(alternativesRoutes, { es, tracker, now: deps.search?.now ? () => deps.search!.now!().getTime() : undefined }); // GET /api/talks/:id/alternatives
  registerStatusRoutes(app, { es, tracker, version: VERSION, rateLimit: limits.status, now: deps.search?.now ? () => deps.search!.now!().getTime() : undefined }); // GET /api/status
  registerClusterRoutes(app, { es, rateLimit: limits.interestsClusters }); // Module 4: GET /api/interests/clusters
  app.register(suggestRoutes, { es, now: deps.search?.now ? () => deps.search!.now!().getTime() : undefined }); // GET /api/suggest
  registerCatalogRoutes(app, es, { rateLimit: limits.catalogTopics, now: deps.search?.now ? () => deps.search!.now!().getTime() : undefined });

  // Module 3: POST /api/access/token + POST /api/access/scan (routes/access.ts).
  app.register(accessRoutes, { es, tokens, roomActivity });
  registerRoomRoutes(app, es, roomActivity);

  registerInterestRoutes(app, { es, now: deps.search?.now, rateLimit: limits.interestsAggregate });

  // `config` is wired for later tasks (ES client, token signing, OTel).
  app.decorate("config", config);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}
