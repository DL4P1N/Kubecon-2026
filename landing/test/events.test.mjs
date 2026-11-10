import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sanitizeLabel, buildRegisteredEvent, MAX_EVENT_LISTENERS } from "../server.mjs";
import { startApp, postJson, fakeApi, validProfile } from "./helpers.mjs";

const conference = { slug: "cloud-native-hackathon-slc-2026", name: "Cloud Native Hackathon" };

/** Opens GET /api/events and collects the text it receives. */
function listen(base, path = "/api/events") {
  return new Promise((resolve, reject) => {
    const req = http.get(base + path, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { text += d; });
      const api = {
        res, req, text: () => text, status: res.statusCode,
        close: () => new Promise((r) => { if (res.destroyed || res.complete) { req.destroy(); return r(); } res.on("close", r); req.destroy(); setTimeout(r, 500); }),
        waitFor: async (re, ms = 2000) => {
          const t0 = Date.now();
          while (!re.test(text)) {
            if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${re}; got ${JSON.stringify(text)}`);
            await new Promise((r) => setTimeout(r, 10));
          }
          return text;
        },
      };
      resolve(api);
    });
    req.on("error", reject);
  });
}

const frames = (text) => text.split("\n\n").filter((f) => f.startsWith("event:")).map((f) => {
  const [ev, data] = f.split("\n");
  return { event: ev.slice(7), data: JSON.parse(data.slice(6)) };
});

test("sanitizeLabel: first token only, A-Z a-z 0-9, max 12, Guest when empty", () => {
  for (const [input, want] of [
    ["Ada Lovelace", "Ada"], ["  Grace   Hopper ", "Grace"], ["O'Brien", "OBrien"], ["Zo\u00eb", "Zo"], ["Jean-Luc Picard", "JeanLuc"],
  ]) assert.equal(sanitizeLabel(input), want, input);
  assert.equal(sanitizeLabel("Bartholomew-Alexander"), "BartholomewA"); // 12 chars after stripping
  assert.equal(sanitizeLabel("Supercalifragilistic"), "Supercalifra");
  for (const empty of ["", "   ", "🙂 Bob", "!!!", "-", null, undefined, 5, "‮​"]) assert.equal(sanitizeLabel(empty), "Guest", String(empty));
  assert.equal(sanitizeLabel("<script>alert(1)</script> x"), "scriptalert1sc".slice(0, 12));
  assert.equal(sanitizeLabel("a\nb"), "a");
  assert.match(sanitizeLabel("x".repeat(500)), /^x{12}$/);
});

test("buildRegisteredEvent carries exactly label, conference, returning, interests (a number)", () => {
  const e = buildRegisteredEvent({ ...validProfile(), token: "SECRET", email: "a@b.c" }, "my-conf", true);
  assert.deepEqual(e, { label: "Ada", conference: "my-conf", returning: true, interests: 3 });
  assert.deepEqual(Object.keys(e), ["label", "conference", "returning", "interests"]);
  assert.equal(buildRegisteredEvent(validProfile(), "c", "yes").returning, false); // strictly boolean true
  assert.equal(buildRegisteredEvent({ name: "X" }, "c", false).interests, 0);
});

test("GET /api/events streams `registered` events for api and local tickets with only the allowed keys", async () => {
  const api = await fakeApi((req) => [201, { attendeeId: "id-SECRET", token: "tok.SECRET", expiresAt: "2030-01-01T00:00:00Z" }]);
  const a = await startApp({ env: { API_BASE: api.base } });
  try {
    const s = await listen(a.base);
    assert.equal(s.status, 200);
    assert.match(s.res.headers["content-type"], /^text\/event-stream/);
    assert.equal(s.res.headers["cache-control"], "no-cache, no-transform");
    await s.waitFor(/: connected/);

    const profile = { ...validProfile(), name: "Ada Lovelace-Byron", role: "SECRET-ROLE", interests: ["kubernetes", "search", "ai sre", "rust"] };
    const r1 = await (await postJson(a.base, "/api/register", { conference, profile, returning: true })).json();
    assert.equal(r1.source, "api");
    await s.waitFor(/event: registered/);

    const text = s.text();
    for (const secret of ["Lovelace", "Byron", "SECRET", "kubernetes", "search", "platform", "id-", "tok."]) assert.ok(!text.includes(secret), `leaked ${secret}`);
    const [f] = frames(text);
    assert.equal(f.event, "registered");
    assert.deepEqual(f.data, { label: "Ada", conference: conference.slug, returning: true, interests: 4 });
    assert.deepEqual(Object.keys(f.data), ["label", "conference", "returning", "interests"]);
    assert.equal(typeof f.data.interests, "number");

    // a local ticket (API down) broadcasts too; `returning` defaults to false
    await api.close();
    const r2 = await (await postJson(a.base, "/api/register", { conference, profile: validProfile() })).json();
    assert.equal(r2.source, "local");
    await s.waitFor(/"returning":false/);
    const all = frames(s.text());
    assert.equal(all.length, 2);
    assert.deepEqual(all[1].data, { label: "Ada", conference: conference.slug, returning: false, interests: 3 });

    // rejected requests broadcast nothing
    await postJson(a.base, "/api/register", { conference, profile: { name: "" } });
    await postJson(a.base, "/api/register", { conference, profile: validProfile(), returning: "true" }); // not a boolean: false
    await new Promise((r) => setTimeout(r, 50));
    const after = frames(s.text());
    assert.equal(after.length, 3);
    assert.equal(after[2].data.returning, false);
    await s.close();
  } finally { await a.close(); await api.close().catch(() => {}); }
});

test("events: heartbeat comments keep the stream alive", async () => {
  const a = await startApp({ heartbeatMs: 40 });
  try {
    const s = await listen(a.base);
    await s.waitFor(/: heartbeat\n\n[\s\S]*: heartbeat\n\n/);
    await s.close();
  } finally { await a.close(); }
});

test(`events: at most ${MAX_EVENT_LISTENERS} concurrent listeners, and closing one frees a slot`, async () => {
  assert.equal(MAX_EVENT_LISTENERS, 20);
  const a = await startApp();
  try {
    const open = [];
    for (let i = 0; i < MAX_EVENT_LISTENERS; i++) open.push(await listen(a.base));
    assert.ok(open.every((s) => s.status === 200));
    const extra = await listen(a.base);
    assert.equal(extra.status, 503);
    await extra.close();
    await open[0].close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await listen(a.base);
    assert.equal(again.status, 200);
    // all remaining listeners still receive broadcasts
    await postJson(a.base, "/api/register", { conference, profile: validProfile() });
    await again.waitFor(/event: registered/);
    await open[5].waitFor(/event: registered/);
    for (const s of [...open.slice(1), again]) await s.close();
  } finally { await a.close(); }
});

test("events: wrong methods, HEAD does not open a stream, and /api/config advertises events", async () => {
  const a = await startApp();
  try {
    assert.equal((await fetch(a.base + "/api/events", { method: "POST" })).status, 405);
    const head = await fetch(a.base + "/api/events", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal((await (await fetch(a.base + "/api/config")).json()).events, true);
  } finally { await a.close(); }
});

test("events: the request log records the stream like any request, without attendee data", async () => {
  const a = await startApp();
  try {
    const s = await listen(a.base);
    await postJson(a.base, "/api/register", { conference, profile: { ...validProfile(), name: "Zaphod Beeblebrox" } });
    await s.waitFor(/registered/);
    await s.close();
    await new Promise((r) => setTimeout(r, 50));
    for (const l of a.lines) assert.ok(!/Zaphod|Beeblebrox/.test(l), l);
    assert.ok(a.lines.some((l) => /^GET \/api\/events 200 \d+ms$/.test(l)));
  } finally { await a.close(); }
});
