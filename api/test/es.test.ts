import { describe, expect, it } from "vitest";
import { createEmbedder, hashEmbed, LocalHashEmbedder } from "../src/es/embeddings.js";
import { createEsClient } from "../src/es/client.js";
import { buildMappings, ensureIndices, INDEX_NAMES, indexBody, physicalName } from "../src/es/mappings.js";
import { embeddingText, loadTalks } from "../src/es/seed.js";

const norm = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

describe("local embedder", () => {
  it("is deterministic, fixed-dimension and unit length", async () => {
    const e = new LocalHashEmbedder(64);
    const a = await e.embed("Zero trust workload identity with SPIFFE");
    const b = await e.embed("Zero trust workload identity with SPIFFE");
    expect(a).toEqual(b);
    expect(a).toHaveLength(64);
    expect(norm(a)).toBeCloseTo(1, 6);
  });

  it("ranks related text above unrelated text", () => {
    const q = hashEmbed("kubernetes security policy admission", 256);
    const related = hashEmbed("Policy as code with admission control for Kubernetes security", 256);
    const unrelated = hashEmbed("Persistent volumes and storage classes for databases", 256);
    expect(dot(q, related)).toBeGreaterThan(dot(q, unrelated));
  });

  it("handles empty text", () => {
    const v = hashEmbed("", 16);
    expect(norm(v)).toBeCloseTo(1, 6);
  });

  it("selects provider from env", () => {
    expect(createEmbedder({}).provider).toBe("local");
    expect(createEmbedder({ EMBEDDING_DIMS: "32" }).dims).toBe(32);
    expect(() => createEmbedder({ EMBEDDINGS_PROVIDER: "nope" })).toThrow(/Unsupported/);
    expect(() => createEmbedder({ EMBEDDING_DIMS: "2" })).toThrow(/Invalid/);
  });
});

describe("mappings", () => {
  it("defines every index with strict dynamic mapping and matching vector dims", () => {
    const m = buildMappings(128);
    expect(Object.keys(m).sort()).toEqual([...INDEX_NAMES].sort());
    for (const a of INDEX_NAMES) expect(indexBody(a, 128).mappings.dynamic).toBe("strict");
    expect(m.talks.embedding).toMatchObject({ type: "dense_vector", dims: 128, similarity: "cosine" });
  });

  it("creates only missing indices and is idempotent", async () => {
    const existing = new Set<string>();
    const calls: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const method = init.method ?? "GET";
      calls.push(`${method} ${path}`);
      const name = path.slice(1);
      if (method === "HEAD" && path.startsWith("/_alias/")) return new Response(null, { status: 404 });
      if (method === "HEAD") return new Response(null, { status: existing.has(name) ? 200 : 404 });
      if (method === "PUT") {
        existing.add(name);
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const es = createEsClient({ esUrl: "http://es:9200", esUsername: "u", esPassword: "p" }, fakeFetch);

    const first = await ensureIndices(es, 16);
    expect(first.every((r) => r.created)).toBe(true);
    const second = await ensureIndices(es, 16);
    expect(second.every((r) => !r.created)).toBe(true);
    expect(calls.filter((c) => c.startsWith("PUT")).length).toBe(INDEX_NAMES.length);
  });
});

describe("talk catalog", () => {
  it("is a valid, realistic ~60 talk, 2 day schedule", async () => {
    const talks = await loadTalks();
    expect(talks.length).toBeGreaterThanOrEqual(55);
    expect(new Set(talks.map((t) => t.id)).size).toBe(talks.length);
    for (const t of talks) {
      expect(t.title && t.speaker && t.abstract && t.room && t.track).toBeTruthy();
      expect(["beginner", "intermediate", "advanced"]).toContain(t.level);
      expect(t.tags.length).toBeGreaterThan(0);
      expect(Date.parse(t.end)).toBeGreaterThan(Date.parse(t.start));
      expect(embeddingText(t)).toContain(t.title);
    }
    expect(new Set(talks.map((t) => t.start.slice(0, 10))).size).toBe(2);
    expect(new Set(talks.map((t) => t.track)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(talks.map((t) => t.level)).size).toBe(3);
  });

  it("has overlapping slots across rooms but no double-booked room", async () => {
    const talks = await loadTalks();
    let overlaps = 0;
    for (let i = 0; i < talks.length; i++) {
      for (let j = i + 1; j < talks.length; j++) {
        const a = talks[i], b = talks[j];
        const overlap = Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
        if (!overlap) continue;
        if (a.room === b.room) throw new Error(`room ${a.room} double booked: ${a.id} ${b.id}`);
        overlaps++;
      }
    }
    expect(overlaps).toBeGreaterThan(0);
    // and some talks overlap nothing
    const alone = talks.filter((a) =>
      talks.every((b) => a === b || !(Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end))),
    );
    expect(alone.length).toBeGreaterThan(0);
  });

  it("names the physical index with a version", () => {
    expect(physicalName("talks")).toMatch(/^talks-v\d+$/);
  });
});
