import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTokenService } from "../src/auth/token.js";
import { ALLOWED_DEMO_ID, demoFixtures, main, seedDemo, setDemoPass } from "../../scripts/seed-demo.mjs";
import { fakeEs } from "./helpers.js";

const now = new Date("2026-11-09T19:00:00.000Z");

describe("synthetic demo seed", () => {
  it("reruns overwrite only fixed synthetic documents and support revoke/restore", async () => {
    const docs = new Map<string, unknown>([["attendees/real-person", { display_name: "untouched" }]]);
    const es = fakeEs((call) => {
      const match = /^\/(attendees|entitlements)\/_doc\/([^?]+)(?:\?refresh=wait_for)?$/.exec(call.path);
      if (!match) throw new Error("Unexpected path");
      const key = `${match[1]}/${match[2]}`;
      if (call.method === "PUT") { docs.set(key, call.body); return { body: { result: "updated" } }; }
      return docs.has(key) ? { body: { found: true, _source: docs.get(key) } } : { status: 404, body: { found: false } };
    });
    const embed = vi.fn(async () => [0.6, 0.8]);
    expect(await seedDemo(es, now, embed)).toEqual({ attendees: 12, optedIn: 12, initiallyRevoked: 1 });
    expect(embed).toHaveBeenCalledTimes(2);
    await seedDemo(es, new Date(now.getTime() + 60_000), embed);
    expect(docs.size).toBe(25);
    expect(docs.get("attendees/real-person")).toEqual({ display_name: "untouched" });
    expect(es.calls.every((call) => ["GET", "PUT"].includes(call.method))).toBe(true);
    expect(docs.get(`entitlements/${ALLOWED_DEMO_ID}`)).toMatchObject({ rooms: ["*"] });
    await setDemoPass(es, false);
    expect(docs.get(`entitlements/${ALLOWED_DEMO_ID}`)).toMatchObject({ rooms: [] });
    await setDemoPass(es, true);
    expect(docs.get(`entitlements/${ALLOWED_DEMO_ID}`)).toMatchObject({ rooms: ["*"] });
  });

  it("provides k>=5 topic groups, explicit synthetic consent, and 24h retention", () => {
    const fixtures = demoFixtures(now);
    const counts = new Map<string, number>();
    for (const { attendee, entitlement } of fixtures) {
      expect(attendee.display_name).toMatch(/^SYNTHETIC DEMO /);
      expect(attendee.consent).toEqual({ cluster_map: true, qr_checkin: true });
      expect(Date.parse(attendee.expires_at) - Date.parse(attendee.created_at)).toBe(86_400_000);
      expect(entitlement.expires_at).toBe(attendee.expires_at);
      for (const topic of attendee.interests) counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({ security: 6, kubernetes: 12, observability: 6 });
    expect(fixtures.filter(({ entitlement }) => entitlement.rooms.length === 0)).toHaveLength(1);
  });

  it("fails closed on missing or unexpected demo pass", async () => {
    await expect(setDemoPass(fakeEs(() => undefined), false)).rejects.toThrow("Synthetic demo pass missing");
    const es = fakeEs(() => ({ body: { found: true, _source: { attendee_id: ALLOWED_DEMO_ID, pass_type: "general", rooms: ["*"] } } }));
    await expect(setDemoPass(es, false)).rejects.toThrow("Synthetic demo pass missing");
    expect(es.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("dry-runs without credentials, network, token output or writes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["--dry-run"], {});
      expect(log).toHaveBeenCalledWith(expect.stringContaining("No network or files written"));
      expect(JSON.stringify(log.mock.calls)).not.toContain(ALLOWED_DEMO_ID);
      await expect(main([], { ES_USERNAME: "elastic" })).rejects.toThrow("companion_svc");
      await expect(main([], { ES_USERNAME: "companion_svc", ES_URL: "http://es:9200" })).rejects.toThrow("HTTPS");
      await expect(main(["--session-file", "/tmp/missing-key-demo.json"], { ES_USERNAME: "companion_svc", ES_URL: "https://es:9200" })).rejects.toThrow("TOKEN_SIGNING_KEY");
      await expect(main(["--dry-run", "--revoke"], {})).rejects.toThrow("Usage");
    } finally { log.mockRestore(); }
  });

  it("writes a private expiring session outside the repo and refuses existing files/symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-demo-test-"));
    const file = join(dir, "session.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const env = { ES_USERNAME: "companion_svc", ES_PASSWORD: "test-only", ES_URL: "https://es.test:9200", TOKEN_SIGNING_KEY: "test-only-demo-signing-key-0123456789" };
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => new Response(JSON.stringify(init.method === "GET"
      ? { found: true, _source: { attendee_id: ALLOWED_DEMO_ID, pass_type: "synthetic-demo", rooms: [], expires_at: "2099-01-01T00:00:00.000Z" } }
      : { result: "updated" }), { status: 200 })));
    try {
      const inside = fileURLToPath(new URL("../../demo-session.json", import.meta.url));
      await expect(main(["--restore", "--session-file", inside], env)).rejects.toThrow("outside the checkout");
      expect(fetch).not.toHaveBeenCalled();
      if (process.platform !== "win32") {
        const parentLink = join(dir, "checkout-link");
        await symlink(fileURLToPath(new URL("../../", import.meta.url)), parentLink);
        await expect(main(["--restore", "--session-file", join(parentLink, "demo-session.json")], env)).rejects.toThrow("outside the checkout");
        expect(fetch).not.toHaveBeenCalled();
      }
      await main(["--restore", "--session-file", file], env);
      const signed = JSON.parse(await readFile(file, "utf8"));
      expect(await createTokenService({ key: env.TOKEN_SIGNING_KEY }).verify(signed.token)).toBe(ALLOWED_DEMO_ID);
      expect(Date.parse(signed.expiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(log.mock.calls)).not.toContain(signed.token);
      await expect(main(["--restore", "--session-file", file], env)).rejects.toMatchObject({ code: "EEXIST" });
      if (process.platform !== "win32") {
        const link = join(dir, "link.json");
        await symlink(file, link);
        await expect(main(["--restore", "--session-file", link], env)).rejects.toMatchObject({ code: "EEXIST" });
        expect(JSON.parse(await readFile(file, "utf8")).token).toBe(signed.token);
      }
    } finally {
      vi.unstubAllGlobals();
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
