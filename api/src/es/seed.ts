import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createEsClient, type EsClient } from "./client.js";
import { assertInferenceEndpoint, resolveInferenceId } from "./inference.js";
import { ensureIndices, physicalName } from "./mappings.js";
import { embeddingDims } from "./embeddings.js";
import type { CatalogTalk } from "./talks.js";

export const DEFAULT_TALKS_FILE = fileURLToPath(new URL("../../../data/talks.json", import.meta.url));

export async function loadTalks(file = process.env.TALKS_FILE || DEFAULT_TALKS_FILE): Promise<CatalogTalk[]> {
  return JSON.parse(await readFile(file, "utf8")) as CatalogTalk[];
}

const BATCH_SIZE = 25;
const RETRY_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SeedOptions {
  batchSize?: number;
  /** Attempts per batch when ES is busy (e.g. the model is still deploying). */
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Bulk-index talks as plain text. Elasticsearch fills `content_semantic` itself
 * (title + abstract via copy_to), so no vectors are sent. Uses the talk id as
 * _id, so re-running overwrites. Batches are small because every document waits
 * on model inference, and are retried on 429/503 while a model deploys.
 */
export async function seedTalks(es: EsClient, talks: CatalogTalk[], opts: SeedOptions = {}) {
  const { batchSize = BATCH_SIZE, retries = 6, retryDelayMs = 5000 } = opts;
  for (let i = 0; i < talks.length; i += batchSize) {
    const lines: object[] = [];
    for (const t of talks.slice(i, i + batchSize)) {
      lines.push({ index: { _index: physicalName("talks"), _id: t.id } }, t);
    }
    for (let attempt = 1; ; attempt++) {
      let failed: { status: number; error?: unknown }[] = [];
      try {
        const res = await es.bulk(lines);
        failed = res.errors
          ? res.items.map((it) => Object.values(it)[0]).filter((r) => r && r.error)
          : [];
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (!status || !RETRY_STATUS.has(status) || attempt >= retries) throw err;
        await sleep(retryDelayMs);
        continue;
      }
      if (failed.length === 0) break;
      const retryable = failed.every((f) => RETRY_STATUS.has(f.status));
      if (!retryable || attempt >= retries) {
        throw new Error(`Bulk indexing failed for ${failed.length} talks: ${JSON.stringify(failed[0]).slice(0, 500)}`);
      }
      await sleep(retryDelayMs);
    }
  }
  await es.request("POST", `/${physicalName("talks")}/_refresh`);
  return talks.length;
}

/** `npm run seed`: ensure indices exist, then index data/talks.json. */
async function main() {
  const es = createEsClient(loadConfig());
  const inferenceId = resolveInferenceId();
  const taskType = await assertInferenceEndpoint(es, inferenceId);
  await ensureIndices(es, embeddingDims(), inferenceId);
  const n = await seedTalks(es, await loadTalks());
  const count = await es.request<{ count: number }>("GET", `/${physicalName("talks")}/_count`);
  console.log(`indexed ${n} talks; ES embedded them at index time with ${inferenceId} (${taskType}); index now has ${count.body.count} docs`);
}

// Run only when executed directly, not when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
