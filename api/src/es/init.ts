import { loadConfig } from "../config.js";
import { createEsClient } from "./client.js";
import { embeddingDims } from "./embeddings.js";
import { ensureIndices } from "./mappings.js";

/** `npm run es:init`: create the versioned indices if missing. */
async function main() {
  const es = createEsClient(loadConfig());
  const results = await ensureIndices(es, embeddingDims());
  for (const r of results) {
    console.log(`${r.created ? "created" : "exists "} ${r.index} (alias ${r.alias})`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
