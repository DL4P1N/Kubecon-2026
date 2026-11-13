import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import type { Db } from "../src/db/client.js";
import { migrate } from "../src/db/schema.js";
import { seedTalks } from "../src/db/seed.js";
import type { CatalogTalk } from "../src/db/talks.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";

type Conn = Pick<PGlite, "query" | "exec">;

function adapt(conn: Conn, root: PGlite): Db {
  return {
    async query<T extends object>(text: string, params: readonly unknown[] = []) {
      const r = await conn.query<T>(text, params as unknown[]);
      return { rows: r.rows, rowCount: r.affectedRows && r.affectedRows > 0 ? r.affectedRows : r.rows.length };
    },
    async exec(text: string) {
      await conn.exec(text);
    },
    async transaction<R>(fn: (tx: Db) => Promise<R>) {
      return root.transaction((t) => fn(adapt(t as unknown as Conn, root)));
    },
    async close() {
      if (conn === root) await root.close();
    },
  };
}

/**
 * Real Postgres (PGlite, in process) with the production schema, pgvector and
 * pg_trgm: the SQL under test is the SQL that runs in production. Each call is
 * an isolated, empty database.
 */
export async function testDb(): Promise<Db> {
  const root = await PGlite.create({ extensions: { vector, pg_trgm } });
  const db = adapt(root, root);
  await migrate(db);
  return db;
}

/** Inserts talks with hashed passage embeddings (the offline embedder the tests use). */
export async function insertTalks(db: Db, talks: CatalogTalk[]): Promise<void> {
  await seedTalks(db, new LocalHashEmbedder(), talks);
}
