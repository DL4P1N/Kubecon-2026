import type { EsClient } from "./client.js";

/**
 * Elasticsearch built-in inference. `semantic_text` fields call an inference
 * endpoint at index time (and at query time for `semantic` queries), so the
 * client never has to produce vectors for talks.
 *
 * Default endpoint: `.multilingual-e5-small-elasticsearch`, a preconfigured
 * dense text_embedding endpoint (384 dims) that ships with Elasticsearch 8.17+
 * / 9.x. It is much lighter on ML node memory than ELSER
 * (`.elser-2-elasticsearch`), handles non-English abstracts, and returns dense
 * vectors, which also lets `embed()` serve attendee interest vectors. Override
 * with ES_INFERENCE_ID (for example `.elser-2-elasticsearch`).
 */
export const DEFAULT_INFERENCE_ID = ".multilingual-e5-small-elasticsearch";

/** Dimensions of the default dense endpoint (multilingual-e5-small). */
export const DEFAULT_INFERENCE_DIMS = 384;

export function resolveInferenceId(env: NodeJS.ProcessEnv = process.env): string {
  const id = (env.ES_INFERENCE_ID ?? "").trim();
  return id || DEFAULT_INFERENCE_ID;
}

interface EndpointInfo {
  endpoints?: { inference_id: string; task_type: string }[];
}

/**
 * Fail early, with an actionable message, when the inference endpoint is
 * missing or the account may not see it. Creating a `semantic_text` mapping
 * against an unknown endpoint would otherwise fail with a less helpful error.
 */
export async function assertInferenceEndpoint(es: EsClient, inferenceId: string): Promise<string> {
  const res = await es.request<EndpointInfo>("GET", `/_inference/${encodeURIComponent(inferenceId)}`, undefined, [404, 403]);
  if (res.status === 404) {
    throw new Error(
      `Inference endpoint "${inferenceId}" not found. It needs Elasticsearch 8.17+/9.x with an ML node and a trial or Platinum+ license; ` +
        `see docs/elasticsearch.md. Set ES_INFERENCE_ID to another endpoint if needed.`,
    );
  }
  if (res.status === 403) {
    throw new Error(
      `Not allowed to read inference endpoint "${inferenceId}". Grant the service account the cluster privilege monitor_inference (see docs/elasticsearch.md).`,
    );
  }
  return res.body.endpoints?.[0]?.task_type ?? "unknown";
}
