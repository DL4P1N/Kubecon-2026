import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createEsClient } from "../src/es/client.js";
import { createEmbedder } from "../src/es/embeddings.js";
import { ensureIndices, physicalName } from "../src/es/mappings.js";
import { loadTalks, seedTalks } from "../src/es/seed.js";

// Needs a running Elasticsearch with the companion_svc credentials in env
// (ES_URL, ES_USERNAME, ES_PASSWORD). Skipped otherwise.
describe.skipIf(!process.env.ES_URL)("elasticsearch integration", () => {
  it("initialises indices, seeds talks with vectors and answers a kNN query", async () => {
    const es = createEsClient(loadConfig());
    const embedder = createEmbedder();
    await ensureIndices(es, embedder.dims);
    const talks = await loadTalks();
    await seedTalks(es, embedder, talks);

    const count = await es.request<{ count: number }>("GET", `/${physicalName("talks")}/_count`);
    expect(count.body.count).toBe(talks.length);

    const res = await es.request<{ hits: { hits: { _source: { title: string; tags: string[] } }[] } }>(
      "POST",
      `/${physicalName("talks")}/_search`,
      {
        knn: {
          field: "embedding",
          query_vector: await embedder.embed("kubernetes security admission policy"),
          k: 5,
          num_candidates: 50,
        },
        _source: ["title", "tags"],
      },
    );
    expect(res.body.hits.hits.length).toBeGreaterThan(0);
  }, 60_000);
});
