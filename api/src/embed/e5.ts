import type { Embedder, EmbedKind } from "./embedder.js";

/** multilingual-e5-small: 384 dims, 100+ languages, int8-quantised ONNX, about 120 MB on disk. */
export const E5_MODEL = "Xenova/multilingual-e5-small";
export const E5_DIMS = 384;
/**
 * Hugging Face hub commit of E5_MODEL and the SHA-256 of each file the pipeline reads at that commit.
 * fetch-model.ts downloads exactly these files at image build time and refuses any other content, so
 * a rebuild cannot change the baked model. transformers.js only finds a revision-keyed cache while
 * it can reach the hub, so the files are stored in the default layout the offline runtime reads.
 */
export const E5_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const E5_FILES: Readonly<Record<string, string>> = {
  "config.json": "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
  "tokenizer.json": "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
  "tokenizer_config.json": "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
  "onnx/model_quantized.onnx": "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
};

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
      return (await pipeline("feature-extraction", E5_MODEL, { dtype: "q8" })) as unknown as Extractor;
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
