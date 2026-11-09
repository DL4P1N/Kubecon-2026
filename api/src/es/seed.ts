import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createEsClient, type EsClient } from "./client.js";
import { createEmbedder, type Embedder } from "./embeddings.js";
import { ensureIndices, physicalName } from "./mappings.js";
import type { CatalogTalk } from "./talks.js";

export const DEFAULT_TALKS_FILE = fileURLToPath(new URL("../../../data/talks.json", import.meta.url));

/** Text that represents a talk for both BM25 (all_text) and the embedding. */
export function embeddingText(t: CatalogTalk): string {
  return [t.title, t.abstract, t.track, t.level, t.tags.join(" ")].join(". ");
}

export async function loadTalks(file = process.env.TALKS_FILE || DEFAULT_TALKS_FILE): Promise<CatalogTalk[]> {
  return JSON.parse(await readFile(file, "utf8")) as CatalogTalk[];
}

/** Bulk-index talks with embeddings. Uses the talk id as _id, so re-running overwrites. */
export async function seedTalks(es: EsClient, embedder: Embedder, talks: CatalogTalk[]) {
  const lines: object[] = [];
  for (const t of talks) {
    lines.push({ index: { _index: physicalName("talks"), _id: t.id } });
    lines.push({ ...t, embedding: await embedder.embed(embeddingText(t)) });
  }
  const res = await es.bulk(lines);
  if (res.errors) {
    const failed = res.items.filter((i) => Object.values(i)[0] && (Object.values(i)[0] as { error?: unknown }).error);
    throw new Error(`Bulk indexing failed for ${failed.length} talks: ${JSON.stringify(failed[0]).slice(0, 500)}`);
  }
  await es.request("POST", `/${physicalName("talks")}/_refresh`);
  return talks.length;
}

/** `npm run seed`: ensure indices exist, then index data/talks.json. */
async function main() {
  const es = createEsClient(loadConfig());
  const embedder = createEmbedder();
  await ensureIndices(es, embedder.dims);
  const n = await seedTalks(es, embedder, await loadTalks());
  const count = await es.request<{ count: number }>("GET", `/${physicalName("talks")}/_count`);
  console.log(`indexed ${n} talks with ${embedder.provider} embeddings (${embedder.dims} dims); index now has ${count.body.count} docs`);
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
