import { describe, expect, it } from "vitest";
import { createEmbedder, EsInferenceEmbedder, hashEmbed, LocalHashEmbedder } from "../src/es/embeddings.js";
import { createEsClient, EsError, esErrorType, isEsOverload } from "../src/es/client.js";
import { assertInferenceEndpoint, DEFAULT_INFERENCE_ID, resolveInferenceId } from "../src/es/inference.js";
import { buildMappings, ensureIndices, INDEX_NAMES, indexBody, physicalName, SCHEMA_VERSION } from "../src/es/mappings.js";
import { loadTalks, seedTalks } from "../src/es/seed.js";

const norm = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);

const fetchStub = (handler: (method: string, path: string, body: string | undefined) => Response) =>
  (async (url: string, init: RequestInit) =>
    handler(init.method ?? "GET", new URL(url).pathname, init.body as string | undefined)) as unknown as typeof fetch;
const esWith = (f: typeof fetch) => createEsClient({ esUrl: "http://es:9200", esUsername: "u", esPassword: "p" }, f);

describe("local embedder (offline fallback)", () => {
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

  it("selects provider from env, defaulting to es-inference", () => {
    expect(createEmbedder({}).provider).toBe("es-inference");
    expect(createEmbedder({}).dims).toBe(384);
    expect(createEmbedder({ EMBEDDINGS_PROVIDER: "local" }).provider).toBe("local");
    expect(createEmbedder({ EMBEDDINGS_PROVIDER: "local" }).dims).toBe(256);
    expect(createEmbedder({ EMBEDDINGS_PROVIDER: "local", EMBEDDING_DIMS: "32" }).dims).toBe(32);
    expect(() => createEmbedder({ EMBEDDINGS_PROVIDER: "nope" })).toThrow(/Unsupported/);
    expect(() => createEmbedder({ EMBEDDING_DIMS: "2" })).toThrow(/Invalid/);
  });
});

describe("es-inference embedder", () => {
  it("asks the configured endpoint for a dense embedding", async () => {
    const seen: string[] = [];
    const es = esWith(
      fetchStub((method, path, body) => {
        seen.push(`${method} ${path} ${body}`);
        return new Response(JSON.stringify({ text_embedding: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }] }), { status: 200 });
      }),
    );
    const e = createEmbedder({ ES_INFERENCE_ID: "my-e5", EMBEDDING_DIMS: "8" }, es);
    expect(await e.embed("hello")).toHaveLength(8);
    expect(seen).toEqual(['POST /_inference/text_embedding/my-e5 {"input":["hello"]}']);
  });

  it("rejects sparse or wrong-sized results", async () => {
    const sparse = esWith(fetchStub(() => new Response(JSON.stringify({ sparse_embedding: [{}] }), { status: 200 })));
    await expect(new EsInferenceEmbedder(sparse, "elser", 8).embed("x")).rejects.toThrow(/dense/);
    const small = esWith(fetchStub(() => new Response(JSON.stringify({ text_embedding: [{ embedding: [1] }] }), { status: 200 })));
    await expect(new EsInferenceEmbedder(small, "e5", 8).embed("x")).rejects.toThrow(/dims/);
  });
});

describe("inference endpoint", () => {
  it("defaults to the built-in E5 endpoint and honours ES_INFERENCE_ID", () => {
    expect(resolveInferenceId({})).toBe(DEFAULT_INFERENCE_ID);
    expect(resolveInferenceId({ ES_INFERENCE_ID: "  " })).toBe(DEFAULT_INFERENCE_ID);
    expect(resolveInferenceId({ ES_INFERENCE_ID: ".elser-2-elasticsearch" })).toBe(".elser-2-elasticsearch");
  });

  it("explains a missing endpoint or missing privilege", async () => {
    const missing = esWith(fetchStub(() => new Response("{}", { status: 404 })));
    await expect(assertInferenceEndpoint(missing, "x")).rejects.toThrow(/not found/);
    const denied = esWith(fetchStub(() => new Response("{}", { status: 403 })));
    await expect(assertInferenceEndpoint(denied, "x")).rejects.toThrow(/monitor_inference/);
    const ok = esWith(
      fetchStub(() => new Response(JSON.stringify({ endpoints: [{ inference_id: "x", task_type: "text_embedding" }] }), { status: 200 })),
    );
    await expect(assertInferenceEndpoint(ok, "x")).resolves.toBe("text_embedding");
  });
});

describe("mappings", () => {
  it("defines every index with strict dynamic mapping and matching vector dims", () => {
    const m = buildMappings(128);
    expect(Object.keys(m).sort()).toEqual([...INDEX_NAMES].sort());
    for (const a of INDEX_NAMES) expect(indexBody(a, 128).mappings.dynamic).toBe("strict");
    expect(m.attendees.interest_vector).toMatchObject({ type: "dense_vector", dims: 128, similarity: "cosine" });
  });

  it("is schema v2 with a semantic_text field fed from title and abstract", () => {
    expect(SCHEMA_VERSION).toBe(2);
    expect(physicalName("talks")).toBe("talks-v2");
    const talks = buildMappings(128, ".elser-2-elasticsearch").talks as Record<string, { type: string; copy_to?: string[]; inference_id?: string }>;
    expect(talks.content_semantic).toEqual({ type: "semantic_text", inference_id: ".elser-2-elasticsearch" });
    expect(talks.title.copy_to).toContain("content_semantic");
    expect(talks.abstract.copy_to).toContain("content_semantic");
    expect(talks.embedding).toBeUndefined();
    expect((buildMappings(128).talks.content_semantic as { inference_id: string }).inference_id).toBe(DEFAULT_INFERENCE_ID);
    expect(indexBody("talks", 128, "custom").mappings.properties.content_semantic).toMatchObject({ inference_id: "custom" });
  });

  it("creates only missing indices and is idempotent", async () => {
    const existing = new Set<string>();
    const calls: string[] = [];
    const bodies: Record<string, unknown> = {};
    const es = esWith(
      fetchStub((method, path, body) => {
        calls.push(`${method} ${path}`);
        const name = path.slice(1);
        if (method === "HEAD" && path.startsWith("/_alias/")) return new Response(null, { status: 404 });
        if (method === "HEAD") return new Response(null, { status: existing.has(name) ? 200 : 404 });
        if (method === "PUT") {
          existing.add(name);
          bodies[name] = JSON.parse(body as string);
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const first = await ensureIndices(es, 16, "my-endpoint");
    expect(first.every((r) => r.created)).toBe(true);
    const second = await ensureIndices(es, 16, "my-endpoint");
    expect(second.every((r) => !r.created)).toBe(true);
    expect(calls.filter((c) => c.startsWith("PUT")).length).toBe(INDEX_NAMES.length);
    const talksBody = bodies["talks-v2"] as { aliases: object; mappings: { properties: Record<string, unknown> } };
    expect(talksBody.aliases).toEqual({ talks: {} });
    expect(talksBody.mappings.properties.content_semantic).toMatchObject({ type: "semantic_text", inference_id: "my-endpoint" });
  });
});

describe("seedTalks", () => {
  it("sends text only (no client vectors), in batches, and retries while the model deploys", async () => {
    const talks = (await loadTalks()).slice(0, 7);
    const bulks: string[][] = [];
    let busyOnce = true;
    const es = esWith(
      fetchStub((_method, path, body) => {
        if (path === "/_bulk") {
          if (busyOnce) {
            busyOnce = false;
            return new Response("{}", { status: 503 });
          }
          bulks.push((body as string).trim().split("\n"));
          return new Response(JSON.stringify({ errors: false, items: [] }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );
    expect(await seedTalks(es, talks, { batchSize: 3, retryDelayMs: 0 })).toBe(7);
    expect(bulks).toHaveLength(3);
    const docs = bulks.flatMap((b) => b.filter((_, i) => i % 2 === 1).map((l) => JSON.parse(l)));
    expect(docs.map((d) => d.id)).toEqual(talks.map((t) => t.id));
    for (const d of docs) {
      expect(d.embedding).toBeUndefined();
      expect(d.content_semantic).toBeUndefined();
      expect(d.abstract).toBeTruthy();
    }
    expect(JSON.parse(bulks[0][0]).index._index).toBe("talks-v2");
  });

  it("fails loudly on non-retryable bulk errors", async () => {
    const es = esWith(
      fetchStub(
        () =>
          new Response(JSON.stringify({ errors: true, items: [{ index: { status: 400, error: { type: "mapper_parsing_exception" } } }] }), {
            status: 200,
          }),
      ),
    );
    await expect(seedTalks(es, (await loadTalks()).slice(0, 1))).rejects.toThrow(/Bulk indexing failed/);
  });
});

describe("talk catalog", () => {
  it("is the real KubeCon + CloudNativeCon NA 2026 schedule with clean, valid entries", async () => {
    const talks = await loadTalks();
    expect(talks.length).toBeGreaterThanOrEqual(300);
    expect(new Set(talks.map((t) => t.id)).size).toBe(talks.length);
    for (const t of talks) {
      expect(t.id).toMatch(/^kcna26-\d+$/);
      expect(t.title && t.speaker && t.abstract && t.room && t.track).toBeTruthy();
      expect(["beginner", "intermediate", "advanced"]).toContain(t.level);
      expect(t.tags.length).toBeGreaterThan(0);
      expect(Date.parse(t.end)).toBeGreaterThan(Date.parse(t.start));
      // speakers are names only; no email addresses anywhere (links in abstracts are session content)
      expect(t.speaker).not.toMatch(/@|https?:\/\//);
      expect(`${t.speaker} ${t.abstract}`).not.toMatch(/\S+@\S+\.\S+/);
      expect(Object.keys(t).sort()).toEqual(["abstract", "end", "id", "level", "room", "speaker", "start", "tags", "title", "track"]);
    }
    // Venue schedule runs Mon Nov 9 to Thu Nov 12 2026 (times are UTC here).
    const days = [...new Set(talks.map((t) => t.start.slice(0, 10)))].sort();
    expect(days[0] >= "2026-11-09" && days[days.length - 1] <= "2026-11-13").toBe(true);
    expect(new Set(talks.map((t) => t.track)).size).toBeGreaterThanOrEqual(6);
    expect(new Set(talks.map((t) => t.level)).size).toBe(3);
  });

  it("has parallel sessions across rooms", async () => {
    const talks = await loadTalks();
    const parallel = talks.some((x) =>
      talks.some((y) => y !== x && y.room !== x.room && Date.parse(x.start) < Date.parse(y.end) && Date.parse(y.start) < Date.parse(x.end)),
    );
    expect(parallel).toBe(true);
  });

  it("names the physical index with a version", () => {
    expect(physicalName("talks")).toMatch(/^talks-v\d+$/);
  });
});

describe("EsError classification", () => {
  it("parses error.type from the innermost root_cause and flags overload", async () => {
    const body = {
      error: { root_cause: [{ type: "inference_exception", reason: "no ML nodes with sufficient capacity" }], type: "search_phase_execution_exception" },
      status: 429,
    };
    const es = esWith(fetchStub(() => new Response(JSON.stringify(body), { status: 429 })));
    const err = await es.request("POST", "/talks/_search", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EsError);
    expect(err).toMatchObject({ status: 429, errorType: "inference_exception" });
    expect(isEsOverload(err as EsError)).toBe(true);
  });

  it("falls back to http_<status> for non-JSON or typeless bodies and rejects unsafe type strings", async () => {
    const plain = await esWith(fetchStub(() => new Response("bad gateway", { status: 502 })))
      .request("GET", "/x")
      .catch((e: unknown) => e);
    expect(plain).toMatchObject({ status: 502, errorType: "http_502" });
    expect(isEsOverload(plain as EsError)).toBe(false);
    expect(esErrorType({ error: { type: "Bad Type With Spaces and query text" } })).toBeUndefined();
    expect(esErrorType({ error: { type: "parsing_exception" } })).toBe("parsing_exception");
  });

  it("treats circuit breaking and rejected execution as overload even without a 429", () => {
    expect(isEsOverload(new EsError(503, "x", "circuit_breaking_exception"))).toBe(true);
    expect(isEsOverload(new EsError(503, "x", "es_rejected_execution_exception"))).toBe(true);
    expect(isEsOverload(new EsError(400, "x", "parsing_exception"))).toBe(false);
  });
});
