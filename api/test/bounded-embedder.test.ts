import { afterEach, describe, expect, it } from "vitest";
import { BoundedEmbedder, EmbedderBusyError } from "../src/embed/bounded.js";
import type { Embedder } from "../src/embed/embedder.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { testDb } from "./pg.js";

function stub() {
  const pending: Array<{ text: string; resolve: (v: number[]) => void }> = [];
  const inner: Embedder = {
    provider: "stub",
    dims: 1,
    embed: (text) => new Promise<number[]>((resolve) => pending.push({ text, resolve })),
  };
  return { inner, pending };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("BoundedEmbedder", () => {
  it("runs 2 at once, queues 16, rejects the next, and a released slot starts the oldest waiter", async () => {
    const { inner, pending } = stub();
    const bounded = new BoundedEmbedder(inner);
    const results = Array.from({ length: 18 }, (_, i) => bounded.embed(`t${i}`));
    await tick();
    expect(pending.map((p) => p.text)).toEqual(["t0", "t1"]);

    await expect(bounded.embed("t18")).rejects.toBeInstanceOf(EmbedderBusyError);

    pending[0]!.resolve([0]);
    await tick();
    expect(pending.map((p) => p.text)).toEqual(["t0", "t1", "t2"]);
    expect(await results[0]).toEqual([0]);

    // Drain everything: each queued call starts when a slot frees, in order.
    for (let done = 1; done < pending.length; done++) {
      pending[done]!.resolve([1]);
      await tick();
    }
    expect(pending).toHaveLength(18);
    await Promise.all(results);
    // After draining, a new call starts at once.
    const again = bounded.embed("again");
    await tick();
    expect(pending.at(-1)!.text).toBe("again");
    pending.at(-1)!.resolve([2]);
    await again;
  });

  it("frees the slot when the inner call fails", async () => {
    let fail = true;
    const inner: Embedder = { provider: "stub", dims: 1, embed: async () => { if (fail) throw new Error("boom"); return [1]; } };
    const bounded = new BoundedEmbedder(inner, 1, 0);
    await expect(bounded.embed("a")).rejects.toThrow("boom");
    fail = false;
    expect(await bounded.embed("b")).toEqual([1]);
  });
});

describe("GET /api/search when the embedder is busy", () => {
  const closers: Array<{ close: () => Promise<unknown> }> = [];
  afterEach(async () => { await Promise.all(closers.splice(0).map((c) => c.close())); });

  it("answers 503 search_overloaded with Retry-After", async () => {
    const db = await testDb();
    const embedder: Embedder = { provider: "stub", dims: 384, embed: async () => { throw new EmbedderBusyError(); } };
    const app = buildServer(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), { db, embedder, runClaude: null });
    closers.push(app, db);
    const res = await app.inject({ method: "GET", url: "/api/search?q=kubernetes&mode=hybrid" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "search_overloaded" });
    expect(res.headers["retry-after"]).toBe("5");
  });
});
