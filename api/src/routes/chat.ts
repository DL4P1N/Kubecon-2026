import type { FastifyPluginAsync } from "fastify";
import { routes, type ChatResponse } from "@cc/shared";
import {
  MAX_CONCURRENT_PER_CLIENT,
  MAX_CONCURRENT_TOTAL,
  BODY_LIMIT_BYTES,
  MIN_USER_TURNS_FOR_PROFILE,
  MIN_USER_TURNS_RETURNING,
  buildPrompt,
  parseAskMarker,
  parseProfileMarker,
  validateChatBody,
  type ClaudeRunner,
} from "../chat/model.js";
import type { ChatProfile } from "../chat/types.js";
import { askFields, scriptedTurn, validateKnown } from "../chat/script.js";
import { DEFAULT_RATE_LIMITS, applyRateLimit, clientKey, limitFor, rateLimitedBody, type RouteLimit } from "../http/rateLimit.js";
import { withSpan } from "../telemetry/span.js";

export interface ChatRouteOptions {
  /** Spawns the Claude CLI; null/undefined means scripted mode (no CLI on this host, or CHAT_MODE=scripted). */
  runClaude?: ClaudeRunner | null;
  rateLimit?: RouteLimit;
}

/**
 * POST /api/chat (no auth, rate limited): one turn of the registration chat.
 *
 * Stateless: the page sends the whole transcript every time. In `claude` mode the turn is answered by
 * the Claude Code CLI (chat/model.ts, locked down: no tools, no settings, one turn); on any failure, or
 * in `scripted` mode, the deterministic flow shared with the browser answers instead (chat/script.js).
 * Nothing is stored. Message text and profiles are never logged or put on spans.
 */
export const chatRoutes: FastifyPluginAsync<ChatRouteOptions> = async (app, opts) => {
  const runClaude = opts.runClaude ?? null;
  const activePerClient = new Map<string, number>();
  let activeTotal = 0;

  await applyRateLimit(app);

  app.post(
    routes.chat.path,
    { bodyLimit: BODY_LIMIT_BYTES, ...limitFor(opts.rateLimit ?? DEFAULT_RATE_LIMITS.chat) },
    async (req, reply) =>
      withSpan("chat", { "http.request.method": "POST", "http.route": routes.chat.path }, async (span) => {
        const parsed = validateChatBody(req.body);
        if (!parsed.ok) {
          span.setAttribute("http.response.status_code", 400);
          // The field name only, never the submitted value.
          return reply.code(400).send({ error: "invalid_request", message: `invalid ${parsed.error}` });
        }
        const { conference, via, messages, known } = parsed.value;
        const scripted = (): ChatResponse => ({
          ...(scriptedTurn({ conference: { name: conference.name, topics: conference.topics }, via, messages, known }) as Omit<ChatResponse, "mode">),
          mode: "scripted",
        });

        let out: ChatResponse | undefined;
        if (runClaude) {
          const ip = clientKey(req.ip);
          if ((activePerClient.get(ip) ?? 0) >= MAX_CONCURRENT_PER_CLIENT || activeTotal >= MAX_CONCURRENT_TOTAL) {
            span.setAttribute("http.response.status_code", 429);
            return reply.code(429).header("retry-after", "2").send(rateLimitedBody("a reply is already in progress, retry in 2 seconds"));
          }
          activePerClient.set(ip, (activePerClient.get(ip) ?? 0) + 1);
          activeTotal++;
          try {
            const text = await runClaude(buildPrompt({ conferenceName: conference.name, via, messages, known }));
            const userTurns = messages.filter((m) => m.role === "user").length;
            const { text: noAsk, ask } = parseAskMarker(text);
            const marker = parseProfileMarker(noAsk, { userTurns, minTurns: known ? MIN_USER_TURNS_RETURNING : MIN_USER_TURNS_FOR_PROFILE });
            let profile: ChatProfile | null = marker.profile;
            if (profile && known) {
              // A returning visitor's details stand as remembered; only the topics may have changed.
              profile = (validateKnown({ ...known, interests: profile.interests }).profile as ChatProfile | undefined) ?? known;
            }
            if (profile) {
              out = { reply: marker.text || `You're all set, ${profile.name}.`, done: true, profile, ask: null, mode: "claude" };
            } else if (marker.text) {
              out = {
                reply: marker.text,
                done: false,
                mode: "claude",
                ...(askFields(ask, {
                  conferenceTopics: conference.topics,
                  returning: Boolean(known),
                  selected: ask === "topics" && known ? known.interests : undefined,
                }) as Pick<ChatResponse, "ask" | "options" | "selected">),
              };
            }
          } catch {
            // CLI missing, failed, refused or timed out: fall through to the scripted flow. Never logged: errors may echo text.
          } finally {
            const n = (activePerClient.get(ip) ?? 1) - 1;
            if (n <= 0) activePerClient.delete(ip);
            else activePerClient.set(ip, n);
            activeTotal--;
          }
        }
        span.setAttribute("http.response.status_code", 200);
        reply.header("cache-control", "no-store");
        return out ?? scripted();
      }),
  );
};
