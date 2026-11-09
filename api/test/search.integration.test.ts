import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createEsClient } from "../src/es/client.js";
import { runSearch } from "../src/search/service.js";

// Needs a running Elasticsearch whose `talks` index is seeded with the
// `content_semantic` semantic_text field (task #19: `npm run es:init && npm run seed`)
// and the companion_svc credentials in env. Skipped when ES_URL is unset.
//
// The query below is a paraphrase that shares (almost) no vocabulary with the
// catalog wording ("supply chain", "provenance", "signing", "SBOM"), so BM25
// has little to match on while the semantic leg should still find talks.
const PARAPHRASE = "make sure nobody can tamper with the software I ship to customers";

describe.skipIf(!process.env.ES_URL)("hybrid search integration", () => {
  const es = createEsClient(loadConfig());

  it("hybrid returns results for a paraphrased query that keyword misses", async () => {
    const keyword = await runSearch(es, { text: PARAPHRASE, mode: "keyword", size: 10 });
    const hybrid = await runSearch(es, { text: PARAPHRASE, mode: "hybrid", size: 10 });

    expect(hybrid.hits.length).toBeGreaterThan(0);
    // Hybrid must surface at least one talk found only through the semantic leg.
    const keywordIds = new Set(keyword.hits.map((h) => h.talk.id));
    const semanticOnly = hybrid.hits.filter((h) => !keywordIds.has(h.talk.id));
    expect(semanticOnly.length).toBeGreaterThan(0);
    expect(semanticOnly.some((h) => h.matched?.includes("semantic"))).toBe(true);
  }, 60_000);

  it("applies level filters in hybrid mode", async () => {
    const r = await runSearch(es, {
      text: "getting started with kubernetes security",
      mode: "hybrid",
      size: 10,
      filters: { levels: ["beginner"] },
    });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.talk.level === "beginner")).toBe(true);
  }, 60_000);
});
