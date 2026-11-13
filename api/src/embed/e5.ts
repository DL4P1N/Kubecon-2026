import type { Embedder, EmbedKind } from "./embedder.js";

/** multilingual-e5-small: 384 dims, 100+ languages, int8-quantised ONNX, about 120 MB on disk. */
export const E5_MODEL = "Xenova/multilingual-e5-small";
export const E5_DIMS = 384;
/** Hugging Face hub commit of E5_MODEL; pinned so the baked model cannot change under a rebuild. */
export const E5_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";

interface Extractor {
  (input: string | string[], opts: { pooling: "mean"; normalize: boolean }): Promise<{ tolist(): number[][] }>;
}

export interface E5Options {
  /** Directory holding the model files (baked into the image). Defaults to MODEL_CACHE_DIR or ./models. */
  cacheDir?: string;
  /** Allow downloading the model from the Hugging Face hub when it is not in cacheDir. Off in production images. */
  allowDownload?: boolean;
}

/**
 * Runs multilingual-e5-small inside the API process with onnxruntime. The model
 * loads once, on first use (single-flight); E5 expects a "query: " or
 * "passage: " prefix, supplied here from `kind`.
 */
export class E5Embedder implements Embedder {
  readonly provider = "e5";
  readonly dims = E5_DIMS;
  private extractor: Promise<Extractor> | undefined;

  constructor(private readonly opts: E5Options = {}) {}

  private load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = this.opts.cacheDir ?? process.env.MODEL_CACHE_DIR ?? "./models";
      env.allowRemoteModels = this.opts.allowDownload ?? process.env.MODEL_ALLOW_DOWNLOAD === "true";
      return (await pipeline("feature-extraction", E5_MODEL, { dtype: "q8", revision: E5_REVISION })) as unknown as Extractor;
    })().catch((err) => {
      this.extractor = undefined; // a failed load can be retried by the next call
      throw err;
    });
    return this.extractor;
  }

  /** Loads the model now (startup warm-up); resolves when embeddings can be served. */
  async warm(): Promise<void> {
    await this.embed("warm up", "query");
  }

  async embed(text: string, kind: EmbedKind = "query"): Promise<number[]> {
    const extractor = await this.load();
    const out = await extractor(`${kind}: ${text}`, { pooling: "mean", normalize: true });
    const vec = out.tolist()[0];
    if (!vec || vec.length !== E5_DIMS) throw new Error(`E5 returned ${vec?.length ?? 0} dims, expected ${E5_DIMS}`);
    return vec;
  }
}
