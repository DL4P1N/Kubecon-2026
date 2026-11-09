import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createEsClient } from "../src/es/client.js";
import { embeddingDims } from "../src/es/embeddings.js";
import { assertInferenceEndpoint, resolveInferenceId } from "../src/es/inference.js";
import { ensureIndices, physicalName } from "../src/es/mappings.js";
import { loadTalks, seedTalks } from "../src/es/seed.js";

// Needs a running Elasticsearch (8.17+/9.x, ML node, trial or Platinum license)
// with the companion_svc credentials in env (ES_URL, ES_USERNAME, ES_PASSWORD).
// Skipped otherwise. The first run can take minutes while the model downloads
// and deploys.
describe.skipIf(!process.env.ES_URL)("elasticsearch integration", () => {
  it("initialises indices, seeds talks (ES embeds them) and answers a semantic query", async () => {
    const es = createEsClient(loadConfig());
    const inferenceId = resolveInferenceId();
    await assertInferenceEndpoint(es, inferenceId);
    await ensureIndices(es, embeddingDims(), inferenceId);
    const talks = await loadTalks();
    await seedTalks(es, talks);

    const count = await es.request<{ count: number }>("GET", `/${physicalName("talks")}/_count`);
    expect(count.body.count).toBe(talks.length);

    const res = await es.request<{ hits: { hits: { _source: { title: string } }[] } }>("POST", `/${physicalName("talks")}/_search`, {
      query: { semantic: { field: "content_semantic", query: "how do I secure my cluster against supply chain attacks" } },
      size: 5,
      _source: ["title", "tags"],
    });
    expect(res.body.hits.hits.length).toBeGreaterThan(0);
  }, 600_000);
});
