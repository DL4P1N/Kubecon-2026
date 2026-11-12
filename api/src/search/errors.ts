import type { FastifyReply, FastifyRequest } from "fastify";
import { isDbUnavailable, type Db } from "../db/client.js";

/** Seconds clients should wait before retrying after the database is unreachable or shedding load (503). */
export const RETRY_AFTER_SECONDS = 5;

/** Safe, low-cardinality label for a database failure: the SQLSTATE or Node error code, never the message (it can echo query text). */
export function dbErrorType(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  return isDbUnavailable(err) ? "db_unavailable" : "db_error";
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** True for failures raised by the database layer (a five-character SQLSTATE or an unreachable server), not Fastify's own errors or bugs. */
export function isDbError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (typeof code === "string" && SQLSTATE.test(code)) || isDbUnavailable(err);
}

/**
 * Runs one parameterised statement. A failure is tagged with `errorType` so
 * `withSpan` records it as the allowlisted `error.type` attribute (the type
 * only, never the message) before it propagates.
 */
export async function runQuery<T extends object>(db: Db, text: string, params: readonly unknown[] = []): Promise<T[]> {
  try {
    return (await db.query<T>(text, params)).rows;
  } catch (err) {
    if (err !== null && typeof err === "object") (err as { errorType?: string }).errorType = dbErrorType(err);
    throw err;
  }
}

/**
 * Error-handler helper shared by the public catalog and search routes. Replies
 * 503 + Retry-After (`search_overloaded`) when the database is unreachable and
 * 502 (`search_unavailable`) for any other database failure, after one log line
 * with the error type and route only. Returns false for errors that are not the
 * database's, so the caller continues with its own mapping.
 */
export function sendDbError(err: unknown, req: FastifyRequest, reply: FastifyReply): boolean {
  if (!isDbError(err)) return false;
  const unavailable = isDbUnavailable(err);
  // The message and SQL text are never logged or echoed: they can contain query text.
  req.log.warn(
    { "error.type": dbErrorType(err), "http.route": req.routeOptions?.url },
    `database request failed${unavailable ? " (unavailable)" : ""}`,
  );
  if (unavailable) void reply.code(503).header("Retry-After", String(RETRY_AFTER_SECONDS)).send({ error: "search_overloaded" });
  else void reply.code(502).send({ error: "search_unavailable" });
  return true;
}
