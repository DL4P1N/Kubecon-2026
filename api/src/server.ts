import Fastify, { type FastifyInstance } from "fastify";
import {
  MIN_CLUSTER_SIZE,
  routes,
  type AccessTokenResponse,
  type HealthResponse,
  type InterestAggregateResponse,
  type ScanRequest,
  type ScanResponse,
} from "@cc/shared";
import type { Config } from "./config.js";
import { createEsClient, type EsClient } from "./es/client.js";
import { createTokenService, type TokenService } from "./auth/token.js";
import { createEmbedder } from "./es/embeddings.js";
import { MOCK_TALKS } from "./mock-data.js";
import { loggerOptions } from "./telemetry/logger.js";
import { registerRoutes } from "./routes/register.js";
import { registerSearchRoutes, type SearchRouteDeps } from "./routes/search.js";

const VERSION = "0.1.0";
const STUB_ATTENDEE_ID = "attendee-stub-1";

const inMinutes = (ms: number) => new Date(Date.now() + ms).toISOString();

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
  const app = Fastify({ logger: loggerOptions });

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

  registerSearchRoutes(app, { es, ...deps.search });

  app.post(routes.accessToken.path, async (): Promise<AccessTokenResponse> => ({
    token: `stub.${STUB_ATTENDEE_ID}`,
    expiresAt: inMinutes(60 * 1000),
  }));

  app.post<{ Body: ScanRequest }>(
    routes.accessScan.path,
    async (req, reply): Promise<ScanResponse | void> => {
      const body = req.body;
      if (!body || typeof body.token !== "string" || typeof body.room !== "string") {
        return reply.code(400).send({ error: "invalid_request", message: "token and room are required" });
      }
      const known = MOCK_TALKS.some((t) => t.room === body.room);
      return known
        ? { decision: "allow", room: body.room }
        : { decision: "deny", room: body.room, reason: "unknown_room" };
    },
  );

  app.get(routes.interestsAggregate.path, async (): Promise<InterestAggregateResponse> => ({
    clusters: [
      { label: "Kubernetes", count: 42 },
      { label: "Observability", count: 31 },
      { label: "Search & data", count: 17 },
    ],
    suppressed: 3,
    minClusterSize: MIN_CLUSTER_SIZE,
    generatedAt: new Date().toISOString(),
  }));

  // `config` is wired for later tasks (ES client, token signing, OTel).
  app.decorate("config", config);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
  }
}
