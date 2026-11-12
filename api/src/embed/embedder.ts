import { E5Embedder } from "./e5.js";
import { DEFAULT_HASH_DIMS, LocalHashEmbedder } from "./hash.js";

/** E5 models need to know whether text is a search query or a document; the hashed fallback ignores it. */
export type EmbedKind = "query" | "passage";

export interface Embedder {
  readonly provider: string;
  readonly dims: number;
  embed(text: string, kind?: EmbedKind): Promise<number[]>;
}

export const DEFAULT_PROVIDER = "e5";

/**
 * EMBEDDINGS_PROVIDER:
 *  - "e5" (default): multilingual-e5-small in this process (api/src/embed/e5.ts).
 *  - "local": deterministic hashed bag-of-words, no model, lexical quality only
 *    (tests and offline demos). EMBEDDING_DIMS is not configurable: it must equal
 *    the schema's vector size.
 */
export function createEmbedder(env: NodeJS.ProcessEnv = process.env): Embedder {
  const provider = (env.EMBEDDINGS_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  if (provider === "local") return new LocalHashEmbedder(DEFAULT_HASH_DIMS);
  if (provider === "e5") return new E5Embedder();
  throw new Error(`Unsupported EMBEDDINGS_PROVIDER "${provider}". Use "e5" (default) or "local"; add providers in api/src/embed/.`);
}
