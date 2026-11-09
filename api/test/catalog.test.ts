import { expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { fakeEs } from "./helpers.js";

it("returns unique sorted catalog tags without authentication or a search query", async () => {
  const es = fakeEs(() => ({ body: { aggregations: { topics: { buckets: [
    { key: "security" }, { key: "kubernetes" }, { key: "security" }, { key: "" },
  ] } } } }));
  const app = buildServer(loadConfig({}), { es });
  try {
    const response = await app.inject({ method: "GET", url: "/api/catalog/topics" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ topics: ["kubernetes", "security"] });
    expect(es.calls).toEqual([{ method: "POST", path: "/talks/_search", body: {
      size: 0, aggs: { topics: { terms: { field: "tags", size: 1000, order: { _key: "asc" } } } },
    } }]);
  } finally { await app.close(); }
});
it.each([
  { status: 503, body: { error: "private ES details" } },
  { body: { timed_out: true } },
  { body: { _shards: { failed: 1 } } },
])("returns a stable unavailable response on ES failure", async (failure) => {
  const app = buildServer(loadConfig({}), { es: fakeEs(() => failure) });
  try {
    const response = await app.inject({ method: "GET", url: "/api/catalog/topics" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "catalog_unavailable" });
  } finally { await app.close(); }
});
it("returns an empty list for an empty catalog while empty user searches stay invalid", async () => {
  const app = buildServer(loadConfig({}), { es: fakeEs(() => ({ body: { aggregations: { topics: { buckets: [] } } } })) });
  try {
    expect((await app.inject("/api/catalog/topics")).json()).toEqual({ topics: [] });
    expect((await app.inject("/api/search?q=&mode=keyword")).statusCode).toBe(400);
  } finally { await app.close(); }
});
