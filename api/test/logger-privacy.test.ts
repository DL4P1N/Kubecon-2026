import { expect, it } from "vitest";
import Fastify from "fastify";
import { loggerOptions } from "../src/telemetry/logger.js";

it("keeps route templates but never raw parameter or unmatched paths in request/404 logs", async () => {
  const lines: string[] = [];
  const app = Fastify({ logger: { ...loggerOptions, level: "info", stream: { write: (line: string) => { lines.push(line); } } } });
  app.get("/api/talks/:id", async () => ({ ok: true }));
  const canary = "private location canary";
  const encoded = encodeURIComponent(canary);
  try {
    expect((await app.inject({ method: "GET", url: `/api/talks/${encoded}?token=private-token` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/missing/${encoded}?token=private-token` })).statusCode).toBe(404);
    await app.close();
    const output = lines.join("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(output).not.toContain(canary);
    expect(output).not.toContain(encoded);
    expect(output).not.toContain("private-token");
    const records = lines.map((line) => JSON.parse(line));
    expect(records.filter((record) => record.req).map((record) => record.req.path)).toEqual(["/api/talks/:id", "[unmatched]"]);
    expect(records.some((record) => record.msg === "Route not found")).toBe(true);
  } finally { await app.close(); }
});
