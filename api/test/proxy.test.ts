import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

describe("proxy-aware registration rate limits", () => {
  it.each(["true", "-1", "1.5", "11"])("rejects invalid TRUST_PROXY=%s", (value) => {
    expect(() => loadConfig({ TRUST_PROXY: value })).toThrow("TRUST_PROXY");
  });

  it.each([0, 1])("uses bounded proxy trust with %i hops", async (hops) => {
    const app = buildServer(loadConfig({ TRUST_PROXY: String(hops), REGISTER_RATE_LIMIT_PER_MINUTE: "2" }));
    try {
      // Invalid registration never reaches ES, but still consumes the IP limit.
      const send = (forwarded: string) => app.inject({
        method: "POST", url: "/api/register", payload: {},
        remoteAddress: "10.0.0.10", headers: { "x-forwarded-for": forwarded },
      });
      expect((await send("198.51.100.1")).statusCode).toBe(400);
      expect((await send("198.51.100.1")).statusCode).toBe(400);
      expect((await send("198.51.100.1")).statusCode).toBe(429);
      expect((await send("198.51.100.2")).statusCode).toBe(hops ? 400 : 429);
      // Spoofing a farther client entry cannot change the nearest trusted client.
      expect((await send("203.0.113.99, 198.51.100.1")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
