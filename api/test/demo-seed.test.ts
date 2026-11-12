import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTokenService } from "../src/auth/token.js";
import { ALLOWED_DEMO_ID, demoFixtures, main, seedDemo, setDemoPass } from "../../scripts/seed-demo.mjs";
import { testDb } from "./pg.js";
import { recordingDb } from "./search-fixtures.js";

const now = new Date("2026-11-09T19:00:00.000Z");

describe("synthetic demo seed", () => {
  it("reruns overwrite only fixed synthetic rows and support revoke/restore", async () => {
    const db = await testDb();
    await db.query("insert into attendees (id, display_name, created_at, expires_at) values ('real-person', 'untouched', now(), '2099-01-01')");
    const embed = vi.fn(async () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)));
    expect(await seedDemo(db, now, embed)).toEqual({ attendees: 12, optedIn: 12, initiallyRevoked: 1 });
    expect(embed).toHaveBeenCalledTimes(2);
    await seedDemo(db, new Date(now.getTime() + 60_000), embed);
    const count = async (table: string) => Number((await db.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]!.n);
    expect(await count("attendees")).toBe(13);
    expect(await count("entitlements")).toBe(12);
    expect((await db.query("select display_name from attendees where id = 'real-person'")).rows).toEqual([{ display_name: "untouched" }]);
    const rooms = async () => (await db.query<{ rooms: string[] }>("select rooms from entitlements where attendee_id = $1", [ALLOWED_DEMO_ID])).rows[0]!.rooms;
    expect(await rooms()).toEqual(["*"]);
    await setDemoPass(db, false);
    expect(await rooms()).toEqual([]);
    await setDemoPass(db, true);
    expect(await rooms()).toEqual(["*"]);
    const seeded = (await db.query<{ consent_cluster_map: boolean; consent_qr_checkin: boolean; interest_vector: string }>("select * from attendees where id = $1", [ALLOWED_DEMO_ID])).rows[0]!;
    expect(seeded).toMatchObject({ consent_cluster_map: true, consent_qr_checkin: true });
    expect(seeded.interest_vector).toBeTruthy();
  });

  it("provides k>=5 topic groups, explicit synthetic consent, and 24h retention", () => {
    const fixtures = demoFixtures(now);
    const counts = new Map<string, number>();
    for (const { attendee, entitlement } of fixtures) {
      expect(attendee.display_name).toMatch(/^SYNTHETIC DEMO /);
      expect([attendee.consent_cluster_map, attendee.consent_qr_checkin]).toEqual([true, true]);
      expect(Date.parse(attendee.expires_at) - Date.parse(attendee.created_at)).toBe(86_400_000);
      expect(entitlement.expires_at).toBe(attendee.expires_at);
      for (const topic of attendee.interests) counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({ security: 6, kubernetes: 12, observability: 6 });
    expect(fixtures.filter(({ entitlement }) => entitlement.rooms.length === 0)).toHaveLength(1);
  });

  it("fails closed on a missing or unexpected demo pass, changing nothing", async () => {
    const db = await testDb();
    await expect(setDemoPass(db, false)).rejects.toThrow("Synthetic demo pass missing");
    await db.query("insert into entitlements (attendee_id, pass_type, rooms, updated_at, expires_at) values ($1, 'general', '{*}', now(), '2099-01-01')", [ALLOWED_DEMO_ID]);
    await expect(setDemoPass(db, false)).rejects.toThrow("Synthetic demo pass missing");
    expect((await db.query("select rooms from entitlements")).rows).toEqual([{ rooms: ["*"] }]);
  });

  it("dry-runs without credentials, network, token output or writes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["--dry-run"], {});
      expect(log).toHaveBeenCalledWith(expect.stringContaining("No network or files written"));
      expect(JSON.stringify(log.mock.calls)).not.toContain(ALLOWED_DEMO_ID);
      await expect(main([], {})).rejects.toThrow("DATABASE_URL");
      await expect(main(["--session-file", "/tmp/missing-key-demo.json"], { DATABASE_URL: "postgresql://u:p@db.example:5432/postgres" })).rejects.toThrow("TOKEN_SIGNING_KEY");
      await expect(main(["--dry-run", "--revoke"], {})).rejects.toThrow("Usage");
    } finally { log.mockRestore(); }
  });

  it("writes a private expiring session outside the repo and refuses existing files/symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cc-demo-test-"));
    const file = join(dir, "session.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const real = await testDb();
    await seedDemo(real, now, async () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)));
    let failNext = false;
    const db = recordingDb(real);
    const queries = db.statements;
    const guarded = Object.assign({}, db, {
      query: async (text: string, params?: readonly unknown[]) => {
        if (failNext) { failNext = false; throw new Error("storage unavailable"); }
        return db.query(text, params);
      },
    });
    queries.length = 0;
    const env = { DATABASE_URL: "postgresql://u:p@db.example:5432/postgres", TOKEN_SIGNING_KEY: "test-only-demo-signing-key-0123456789" };
    try {
      const inside = fileURLToPath(new URL("../../demo-session.json", import.meta.url));
      await expect(main(["--restore", "--session-file", inside], env, { db: guarded })).rejects.toThrow("outside the checkout");
      expect(queries).toHaveLength(0);
      if (process.platform !== "win32") {
        const parentLink = join(dir, "checkout-link");
        await symlink(fileURLToPath(new URL("../../", import.meta.url)), parentLink);
        await expect(main(["--restore", "--session-file", join(parentLink, "demo-session.json")], env, { db: guarded })).rejects.toThrow("outside the checkout");
        expect(queries).toHaveLength(0);
      }
      await main(["--restore", "--session-file", file], env, { db: guarded });
      const signed = JSON.parse(await readFile(file, "utf8"));
      expect(await createTokenService({ key: env.TOKEN_SIGNING_KEY }).verify(signed.token)).toBe(ALLOWED_DEMO_ID);
      expect(Date.parse(signed.expiresAt) - Date.now()).toBeLessThanOrEqual(900_000);
      if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(log.mock.calls)).not.toContain(signed.token);
      queries.length = 0;
      await expect(main(["--restore", "--session-file", file], env, { db: guarded })).rejects.toMatchObject({ code: "EEXIST" });
      expect(queries).toHaveLength(0);
      if (process.platform !== "win32") {
        const link = join(dir, "link.json");
        await symlink(file, link);
        await expect(main(["--restore", "--session-file", link], env, { db: guarded })).rejects.toMatchObject({ code: "EEXIST" });
        expect(queries).toHaveLength(0);
        expect(JSON.parse(await readFile(file, "utf8")).token).toBe(signed.token);
      }
      const failedFile = join(dir, "failed-session.json");
      failNext = true;
      await expect(main(["--restore", "--session-file", failedFile], env, { db: guarded })).rejects.toThrow("storage unavailable");
      await expect(stat(failedFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      log.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
