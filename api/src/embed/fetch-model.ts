import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { E5_FILES, E5_MODEL, E5_REVISION, E5Embedder } from "./e5.js";

/**
 * Downloads multilingual-e5-small at the pinned commit (E5_REVISION) into MODEL_CACHE_DIR (default
 * ./models), checks every file against its pinned SHA-256, and proves the model loads with the hub
 * switched off. Run at image build time so production never needs the hub:
 * `node dist/embed/fetch-model.js`.
 */
const cacheDir = process.env.MODEL_CACHE_DIR ?? "./models";
for (const [file, sha256] of Object.entries(E5_FILES)) {
  const res = await fetch(`https://huggingface.co/${E5_MODEL}/resolve/${E5_REVISION}/${file}`);
  if (!res.ok) throw new Error(`download of ${file} failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw new Error(`${file} does not match its pinned SHA-256 (got ${actual})`);
  const target = join(cacheDir, E5_MODEL, file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
const vec = await new E5Embedder({ cacheDir, allowDownload: false }).embed("ready", "query");
console.log(`model ready (${vec.length} dims) in ${cacheDir}`);
