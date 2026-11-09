import Fastify, { type FastifyInstance } from "fastify";
import {
  MIN_CLUSTER_SIZE,
  routes,
  type AccessTokenResponse,
  type HealthResponse,
  type InterestAggregateResponse,
  type MeResponse,
  type OnboardingRequest,
  type OnboardingResponse,
  type RegisterRequest,
  type RegisterResponse,
  type SaveScheduleRequest,
  type ScanRequest,
  type ScanResponse,
  type ScheduleResponse,
  type SearchMode,
  type SearchResponse,
} from "@cc/shared";
import type { Config } from "./config.js";
import { MOCK_TALKS } from "./mock-data.js";

const VERSION = "0.1.0";
const STUB_ATTENDEE_ID = "attendee-stub-1";
const TOKEN_TTL_MS = 5 * 60 * 1000;

const inMinutes = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * Builds the Fastify app. All /api routes are STUBS returning contract-shaped
 * mock data; real implementations (Elasticsearch, signed tokens, rate
 * limiting, telemetry) land in later tasks.
 */
export function buildServer(config: Config): FastifyInstance {
  const app = Fastify({ logger: false });

  // Stub state, in memory only.
  let scheduleIds: string[] = [MOCK_TALKS[0]!.id];

  app.get(routes.health.path, async (): Promise<HealthResponse> => ({
    status: "ok",
    version: VERSION,
    time: new Date().toISOString(),
  }));

  app.post<{ Body: RegisterRequest }>(routes.register.path, async (req, reply) => {
    const body = req.body;
    if (!body || typeof body.name !== "string" || body.name.trim() === "") {
      return reply.code(400).send({ error: "invalid_request", message: "name is required" });
    }
    const res: RegisterResponse = {
      attendeeId: STUB_ATTENDEE_ID,
      token: `stub.${STUB_ATTENDEE_ID}`,
      expiresAt: inMinutes(TOKEN_TTL_MS),
    };
    return reply.code(201).send(res);
  });

  app.get(routes.me.path, async (): Promise<MeResponse> => ({
    attendeeId: STUB_ATTENDEE_ID,
    name: "Stub Attendee",
    interests: ["kubernetes", "observability"],
    consent: { clusterMap: true, qrCheckin: true },
    onboarded: false,
  }));

  app.post<{ Body: OnboardingRequest }>(
    routes.onboarding.path,
    async (req, reply): Promise<OnboardingResponse | void> => {
      const answers = req.body?.answers;
      if (!answers || !Array.isArray(answers.topics)) {
        return reply.code(400).send({ error: "invalid_request", message: "answers.topics is required" });
      }
      const text = [...answers.topics, ...(answers.goals ?? []), answers.freeText ?? ""]
        .filter(Boolean)
        .join(" ");
      return { query: { text, topics: answers.topics, mode: "hybrid" } };
    },
  );

  app.get<{ Querystring: { q?: string; mode?: SearchMode } }>(
    routes.search.path,
    async (req, reply): Promise<SearchResponse | void> => {
      const q = req.query.q ?? "";
      const mode = req.query.mode ?? "hybrid";
      if (mode !== "hybrid" && mode !== "keyword") {
        return reply.code(400).send({ error: "invalid_request", message: "mode must be hybrid or keyword" });
      }
      const needle = q.toLowerCase();
      const matches = MOCK_TALKS.filter(
        (t) =>
          needle === "" ||
          `${t.title} ${t.abstract} ${t.tags.join(" ")}`.toLowerCase().includes(needle),
      );
      return {
        q,
        mode,
        tookMs: 1,
        hits: matches.map((talk, i) => ({ talk, score: 1 - i * 0.1 })),
      };
    },
  );

  app.get(routes.getSchedule.path, async (): Promise<ScheduleResponse> => ({
    items: MOCK_TALKS.filter((t) => scheduleIds.includes(t.id)).map((talk) => ({
      talk,
      reason: "Matches your interests (stub)",
    })),
    updatedAt: new Date().toISOString(),
  }));

  app.post<{ Body: SaveScheduleRequest }>(
    routes.saveSchedule.path,
    async (req, reply): Promise<ScheduleResponse | void> => {
      const ids = req.body?.talkIds;
      if (!Array.isArray(ids)) {
        return reply.code(400).send({ error: "invalid_request", message: "talkIds is required" });
      }
      scheduleIds = ids.filter((id) => typeof id === "string");
      return {
        items: MOCK_TALKS.filter((t) => scheduleIds.includes(t.id)).map((talk) => ({ talk })),
        updatedAt: new Date().toISOString(),
      };
    },
  );

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
