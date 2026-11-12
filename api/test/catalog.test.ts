import { expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { failingDb, mk, seededDb } from "./search-fixtures.js";

const embedder = new LocalHashEmbedder();

it("returns unique sorted catalog tags without authentication or a search query", async () => {
  const db = await seededDb([
    mk("a", 9, 10, { tags: ["security", "kubernetes"] }),
    mk("b", 9, 10, { tags: ["security", "", "  "] }),
    mk("c", 9, 10, { tags: [] }),
  ]);
  const app = buildServer(loadConfig({}), { db, embedder });
  try {
    const response = await app.inject({ method: "GET", url: "/api/catalog/topics" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ topics: ["kubernetes", "security"] });
  } finally { await app.close(); }
});
it("returns a stable unavailable response on database failure, without driver details", async () => {
  const app = buildServer(loadConfig({}), { embedder, db: failingDb({ code: "ECONNREFUSED", message: "private db details" }) });
  try {
    const response = await app.inject({ method: "GET", url: "/api/catalog/topics" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "catalog_unavailable" });
    expect(response.body).not.toContain("private");
  } finally { await app.close(); }
});
it("returns an empty list for an empty catalog while empty user searches stay invalid", async () => {
  const app = buildServer(loadConfig({}), { embedder, db: await seededDb([]) });
  try {
    expect((await app.inject("/api/catalog/topics")).json()).toEqual({ topics: [] });
    expect((await app.inject("/api/search?q=&mode=keyword")).statusCode).toBe(400);
  } finally { await app.close(); }
});
