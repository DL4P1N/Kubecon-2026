import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vectorLiteral, type Db } from "../src/db/client.js";
import { loadTalks } from "../src/db/seed.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { insertTalks, testDb } from "./pg.js";

describe("schema and talk search on real Postgres", () => {
  let db: Db;
  beforeAll(async () => {
    db = await testDb();
    await insertTalks(db, (await loadTalks()).slice(0, 60));
  }, 60_000);
  afterAll(() => db.close());

  it("migrates idempotently", async () => {
    const { migrate } = await import("../src/db/schema.js");
    await migrate(db);
    const n = await db.query<{ n: number }>("select count(*)::int n from talks");
    expect(n.rows[0]?.n).toBe(60);
  });

  it("ranks by full text and by vector similarity", async () => {
    const kw = await db.query<{ id: string; title: string }>(
      "select id, title from talks where fts @@ websearch_to_tsquery('english', $1) order by ts_rank_cd(fts, websearch_to_tsquery('english', $1)) desc limit 3",
      ["kubernetes"],
    );
    expect(kw.rows.length).toBeGreaterThan(0);
    const q = vectorLiteral(await new LocalHashEmbedder().embed("kubernetes security policy", "query"));
    const sem = await db.query<{ id: string }>("select id from talks order by embedding <=> $1::vector limit 3", [q]);
    expect(sem.rows).toHaveLength(3);
  });
});
