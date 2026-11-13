import { afterEach, describe, expect, it } from "vitest";
import { clientKey } from "../src/http/rateLimit.js";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";
import { LocalHashEmbedder } from "../src/embed/hash.js";
import { testDb } from "./pg.js";

describe("clientKey", () => {
  it.each([
    ["2001:db8:1:2:aaaa::1", "2001:db8:1:2::/64"],
    ["2001:0db8:0001:0002::", "2001:db8:1:2::/64"],
    ["2001:DB8:1:2:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"],
    ["2001:db8:1:3::1", "2001:db8:1:3::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["64:ff9b::1.2.3.4", "64:ff9b:0:0::/64"],
    ["::ffff:1.2.3.4", "1.2.3.4"],
    ["1.2.3.4", "1.2.3.4"],
  ])("%s -> %s", (ip, key) => {
    expect(clientKey(ip)).toBe(key);
  });
});

describe("rate limits per IPv6 /64", () => {
  const apps: Array<{ close: () => Promise<unknown> }> = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((a) => a.close())); });

  it("counts two addresses in one /64 as one client", async () => {
    const db = await testDb();
    const app = buildServer(loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv), {
      db, embedder: new LocalHashEmbedder(), runClaude: null, rateLimits: { search: { max: 1 } },
    });
    apps.push(app, db);
    const send = (remoteAddress: string) => app.inject({ method: "GET", url: "/api/search?q=k8s&mode=keyword", remoteAddress });
    expect((await send("2001:db8:1:2::a")).statusCode).toBe(200);
    expect((await send("2001:db8:1:2::b")).statusCode).toBe(429);
    expect((await send("2001:db8:1:3::a")).statusCode).toBe(200);
  });
});
