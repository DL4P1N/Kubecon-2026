import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgDb, type Db } from "../src/db/client.js";
import { createEmbedder } from "../src/embed/embedder.js";
import { runSearch } from "../src/search/service.js";

// Needs a Postgres whose `talks` table is seeded with e5 embeddings (`npm run seed`)
// and DATABASE_URL (+ DATABASE_CA_FILE) in env; the e5 model is loaded in process
// (MODEL_CACHE_DIR / MODEL_ALLOW_DOWNLOAD). Skipped when DATABASE_URL is unset.
//
// The query below is a paraphrase that shares (almost) no vocabulary with the
// catalog wording ("supply chain", "provenance", "signing", "SBOM"), so the
// keyword leg has little to match on while the semantic leg should still find talks.
const PARAPHRASE = "make sure nobody can tamper with the software I ship to customers";

describe.skipIf(!process.env.DATABASE_URL)("hybrid search integration", () => {
  let db: Db;
  const embedder = createEmbedder(process.env);
  beforeAll(() => {
    db = createPgDb(process.env.DATABASE_URL as string, { caFile: process.env.DATABASE_CA_FILE || undefined, max: 2 });
  });
  afterAll(() => db.close());

  it("hybrid returns results for a paraphrased query that keyword misses", async () => {
    const keyword = await runSearch(db, embedder, { text: PARAPHRASE, mode: "keyword", size: 10 });
    const hybrid = await runSearch(db, embedder, { text: PARAPHRASE, mode: "hybrid", size: 10 });

    expect(hybrid.hits.length).toBeGreaterThan(0);
    // Hybrid must surface at least one talk found only through the semantic leg.
    const keywordIds = new Set(keyword.hits.map((h) => h.talk.id));
    const semanticOnly = hybrid.hits.filter((h) => !keywordIds.has(h.talk.id));
    expect(semanticOnly.length).toBeGreaterThan(0);
    expect(semanticOnly.some((h) => h.matched?.includes("semantic"))).toBe(true);
  }, 60_000);

  it("applies level filters in hybrid mode", async () => {
    const r = await runSearch(db, embedder, {
      text: "getting started with kubernetes security",
      mode: "hybrid",
      size: 10,
      filters: { levels: ["beginner"] },
    });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.talk.level === "beginner")).toBe(true);
  }, 60_000);
});
