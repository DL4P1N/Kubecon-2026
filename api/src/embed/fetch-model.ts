import { E5Embedder } from "./e5.js";

/**
 * Downloads multilingual-e5-small into MODEL_CACHE_DIR (default ./models) and
 * proves it loads. Run at image build time so production never needs the hub:
 * `MODEL_ALLOW_DOWNLOAD=true node dist/embed/fetch-model.js`.
 */
const embedder = new E5Embedder({ allowDownload: true });
const vec = await embedder.embed("ready", "query");
console.log(`model ready (${vec.length} dims) in ${process.env.MODEL_CACHE_DIR ?? "./models"}`);
