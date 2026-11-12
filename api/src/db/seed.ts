import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createEmbedder, type Embedder } from "../embed/embedder.js";
import { createPgDb, vectorLiteral, type Db } from "./client.js";
import { migrate } from "./schema.js";
import type { CatalogTalk } from "./talks.js";

export const DEFAULT_TALKS_FILE = fileURLToPath(new URL("../../../data/talks.json", import.meta.url));

export async function loadTalks(file = process.env.TALKS_FILE || DEFAULT_TALKS_FILE): Promise<CatalogTalk[]> {
  return JSON.parse(await readFile(file, "utf8")) as CatalogTalk[];
}

/** Text the semantic leg embeds for a talk: title first, then the abstract. */
export function talkPassage(t: Pick<CatalogTalk, "title" | "abstract">): string {
  return `${t.title}. ${t.abstract}`;
}

/** Upserts talks (talk id is the key, so re-running overwrites) with their passage embeddings. */
export async function seedTalks(db: Db, embedder: Embedder, talks: CatalogTalk[]): Promise<number> {
  for (const t of talks) {
    const embedding = await embedder.embed(talkPassage(t), "passage");
    await db.query(
      `insert into talks (id, title, abstract, speaker, track, level, room, start_at, end_at, tags, embedding)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector)
       on conflict (id) do update set
         title = excluded.title, abstract = excluded.abstract, speaker = excluded.speaker, track = excluded.track,
         level = excluded.level, room = excluded.room, start_at = excluded.start_at, end_at = excluded.end_at,
         tags = excluded.tags, embedding = excluded.embedding`,
      [t.id, t.title, t.abstract ?? "", t.speaker ?? "", t.track ?? "", t.level ?? null, t.room ?? null, t.start ?? null, t.end ?? null, t.tags ?? [], vectorLiteral(embedding)],
    );
  }
  return talks.length;
}

/** `npm run seed`: create the schema if missing, then load data/talks.json. */
async function main() {
  const config = loadConfig();
  const db = createPgDb(config.databaseUrl, { caFile: config.databaseCaFile });
  try {
    await migrate(db);
    const embedder = createEmbedder();
    const n = await seedTalks(db, embedder, await loadTalks());
    const count = await db.query<{ n: string }>("select count(*)::text as n from talks");
    console.log(`seeded ${n} talks with ${embedder.provider} embeddings; table now has ${count.rows[0]?.n} rows`);
  } finally {
    await db.close();
  }
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
