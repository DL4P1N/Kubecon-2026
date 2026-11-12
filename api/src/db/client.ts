import { readFileSync } from "node:fs";
import pg from "pg";

/**
 * The only database handle the API uses. Production wraps a `pg` Pool (Supabase
 * or any Postgres 15+ with pgvector); tests wrap an in-process PGlite. Callers
 * pass `$1`-style parameters and never build SQL from user text.
 */
export interface Db {
  query<T extends object = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  /** Runs several statements with no parameters (migrations). */
  exec(text: string): Promise<void>;
  /** Runs `fn` in one transaction on one connection; rolls back when it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** pgvector text form of a vector: `[0.1,0.2,...]`, used as `$n::vector`. */
export function vectorLiteral(v: readonly number[]): string {
  return `[${v.join(",")}]`;
}

/** Parses the text form pgvector returns (`[1,2,3]`) back into numbers. */
export function parseVector(text: string | null | undefined): number[] | null {
  if (!text) return null;
  return text.slice(1, -1).split(",").map(Number);
}

const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE",
  "57P01", "57P02", "57P03", // admin shutdown, crash shutdown, cannot connect now
  "53300", "53400", // too many connections, configuration limit
  "08000", "08001", "08003", "08004", "08006", // connection exception class
]);

/** True when the database is unreachable or shedding load: callers answer 503 and the client retries later. */
export function isDbUnavailable(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && UNAVAILABLE_CODES.has(code)) return true;
  const msg = err instanceof Error ? err.message : "";
  return /timeout exceeded when trying to connect|Connection terminated|connection timeout/i.test(msg);
}

/** SQLSTATE 23505: unique_violation (a replayed claim, a duplicate attendee id). */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505";
}

export interface PgDbOptions {
  /** Pool size. The Supabase session pooler allows few connections; the default keeps one API pod well under it. */
  max?: number;
  /** PEM file of the CA that signed the server certificate (Supabase publishes its own root CA). When set it is the only trust root for this connection. */
  caFile?: string;
}

type Queryable = pg.Pool | pg.PoolClient;

function wrap(q: Queryable, tx: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown>, close: () => Promise<void>): Db {
  return {
    async exec(text: string) {
      await q.query(text);
    },
    async query<T extends object>(text: string, params: readonly unknown[] = []) {
      const r = await q.query(text, params as unknown[]);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    transaction: tx as Db["transaction"],
    close,
  };
}

/** Pooled Postgres connection. TLS is on for any non-local host and certificates are verified. */
export function createPgDb(databaseUrl: string, opts: PgDbOptions = {}): Db {
  const url = new URL(databaseUrl);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  // `sslmode` in the URL is stripped: node-postgres would otherwise override the ssl object below.
  url.searchParams.delete("sslmode");
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: opts.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: local ? false : { rejectUnauthorized: true, ...(opts.caFile ? { ca: readFileSync(opts.caFile, "utf8") } : {}) },
  });
  // An idle client erroring must not crash the process; the next query reconnects.
  pool.on("error", () => undefined);
  const db: Db = wrap(
    pool,
    async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(wrap(client, (inner) => inner(db), async () => undefined));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    () => pool.end(),
  );
  return db;
}
