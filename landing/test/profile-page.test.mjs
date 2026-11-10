import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  isoToday, parseRegistrations, addRegistration, splitRegistrations, sampleRegistrations, mergeSamples, withoutSamples,
  inviteUrl, inviteMailto, appTicketUrl, formatRange, bumpShare, shareLabel,
} from "../js/profile.js";
import { wifiQrPayload, escapeWifi, hasWifi } from "../js/wifi.js";
import { FALLBACK_CONFERENCES as CONFS } from "../js/conferences.js";

const TODAY = "2026-11-09";

test("isoToday is the local calendar day", () => {
  assert.equal(isoToday(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("parseRegistrations keeps well-formed rows once per slug and survives junk", () => {
  assert.deepEqual(parseRegistrations("not json"), []);
  assert.deepEqual(parseRegistrations({}), []);
  const rows = parseRegistrations([{ slug: "a", registeredAt: "x" }, { slug: "a", registeredAt: "y" }, null, { slug: 3 }, { slug: "b" }]);
  assert.deepEqual(rows.map((r) => r.slug), ["a", "b"]);
  assert.equal(rows[0].registeredAt, "x");
});

test("addRegistration appends, and dedupes by slug", () => {
  let l = addRegistration([], "a", "t1");
  l = addRegistration(l, "b", "t2");
  l = addRegistration(l, "a", "t3");
  assert.deepEqual(l, [{ slug: "a", registeredAt: "t1" }, { slug: "b", registeredAt: "t2" }]);
  assert.deepEqual(addRegistration(l, ""), l);
});

test("splitRegistrations: upcoming until the last day is over; unknown slugs dropped; sorted", () => {
  const confs = [
    { slug: "now", name: "Now", startDate: "2026-11-09", endDate: "2026-11-09" },
    { slug: "multi", name: "Multi", startDate: "2026-11-08", endDate: "2026-11-09" },
    { slug: "gone", name: "Gone", startDate: "2026-11-07", endDate: "2026-11-08" },
    { slug: "old", name: "Old", startDate: "2025-01-01", endDate: "2025-01-02" },
    { slug: "later", name: "Later", startDate: "2027-01-01" },
  ];
  const regs = ["later", "old", "now", "ghost", "gone", "multi"].map((slug) => ({ slug, registeredAt: "t" }));
  const { upcoming, past } = splitRegistrations(regs, confs, TODAY);
  assert.deepEqual(upcoming.map((r) => r.conference.slug), ["multi", "now", "later"]);
  assert.deepEqual(past.map((r) => r.conference.slug), ["gone", "old"]);
});

test("sampleRegistrations: one upcoming, two past (dates moved back when the catalogue has none), all flagged", () => {
  const rows = sampleRegistrations(CONFS, TODAY, "t");
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.sample === true));
  const { upcoming, past } = splitRegistrations(rows, CONFS, TODAY);
  assert.equal(upcoming.length, 1);
  assert.equal(past.length, 2);
  assert.ok(past.every((r) => r.conference.endDate < TODAY));
  assert.ok(past.every((r) => r.sample));
});

test("sample rows merge without duplicating and clear without touching real rows", () => {
  const real = [{ slug: CONFS[0].slug, registeredAt: "t" }];
  const merged = mergeSamples(real, sampleRegistrations(CONFS, TODAY));
  assert.equal(merged.length, 3);
  assert.equal(merged[0].sample, undefined);
  assert.deepEqual(withoutSamples(merged), real);
});

test("inviteUrl is the absolute conference page next to the current page", () => {
  assert.equal(inviteUrl("http://127.0.0.1:5187/site/profile.html?x=1#y", "my slug"), "http://127.0.0.1:5187/site/conference.html?c=my+slug");
  assert.equal(inviteUrl("https://example.org/profile.html", "a-b"), "https://example.org/conference.html?c=a-b");
});

test("inviteMailto has a subject and body and no address", () => {
  const url = "https://example.org/conference.html?c=a";
  const m = inviteMailto({ name: "A & B", city: "Oslo", startDate: "2026-12-02", endDate: "2026-12-03" }, url);
  assert.ok(m.startsWith("mailto:?subject="));
  const q = new URLSearchParams(m.slice("mailto:?".length));
  assert.equal(q.get("subject"), "Join me at A & B");
  assert.match(q.get("body"), /Oslo, 2–3 Dec 2026/);
  assert.ok(q.get("body").includes(url));
});

test("formatRange", () => {
  assert.equal(formatRange("2026-11-09", "2026-11-09"), "9 Nov 2026");
  assert.equal(formatRange("2026-12-30", "2027-01-02"), "30 Dec 2026 – 2 Jan 2027");
});

test("share counts", () => {
  let c = bumpShare(undefined, "a");
  c = bumpShare(c, "a");
  c = bumpShare(c, "b");
  assert.deepEqual(c, { a: 2, b: 1 });
  assert.equal(shareLabel(1), "Shared 1 time");
  assert.equal(shareLabel(2), "Shared 2 times");
  assert.deepEqual(bumpShare({ a: "x" }, "a"), { a: 1 });
});

test("wifiQrPayload follows the WIFI: format and escapes \\ ; , : \"", () => {
  assert.equal(wifiQrPayload({ ssid: "Net", security: "WPA", password: "pw" }), "WIFI:T:WPA;S:Net;P:pw;;");
  assert.equal(escapeWifi('a\\b;c,d:e"f'), 'a\\\\b\\;c\\,d\\:e\\"f');
  assert.equal(wifiQrPayload({ ssid: "My;Net", password: 'p:"w,' }), 'WIFI:T:WPA;S:My\\;Net;P:p\\:\\"w\\,;;');
  assert.equal(wifiQrPayload({ ssid: "Open", security: "nopass" }), "WIFI:T:nopass;S:Open;;");
});

test("every catalogue conference carries an assumed Wi-Fi network", () => {
  for (const c of CONFS) {
    assert.ok(hasWifi(c), c.slug);
    assert.equal(c.wifi.assumed, true);
    assert.equal(c.wifi.security, "WPA");
    assert.ok(c.wifi.password.length >= 8);
  }
  assert.equal(hasWifi({}), false);
});

test("the page and register ticket are wired", () => {
  const html = fs.readFileSync(new URL("../profile.html", import.meta.url), "utf8");
  assert.match(html, /data-venue-shot="lounge"/);
  assert.match(html, /js\/profile\.js/);
  const reg = fs.readFileSync(new URL("../js/register.js", import.meta.url), "utf8");
  assert.match(reg, /cc\.registrations|REGISTRATIONS_KEY/);
});

test("appTicketUrl encodes every value, caps name/role at 80 and interests at 12, omits empty params", () => {
  assert.equal(
    appTicketUrl({ slug: "a-b", name: "Mia O'Neil & Co", role: "Dev/Ops", interests: ["ai sre", "c,d", "k8s"] }),
    "confcompanion://ticket?c=a-b&name=Mia%20O'Neil%20%26%20Co&role=Dev%2FOps&interests=ai%20sre,c%2Cd,k8s",
  );
  assert.equal(appTicketUrl({ slug: "x" }), "confcompanion://ticket?c=x");
  assert.equal(appTicketUrl({ slug: "x", name: "  ", role: "", interests: [] }), "confcompanion://ticket?c=x");
  const long = appTicketUrl({ slug: "x", name: "n".repeat(120), role: "r".repeat(81), interests: Array.from({ length: 20 }, (_, i) => `t${i}`) });
  const q = new URLSearchParams(long.split("?")[1]);
  assert.equal(q.get("name").length, 80);
  assert.equal(q.get("role").length, 80);
  assert.equal(q.get("interests").split(",").length, 12);
  assert.equal(q.get("interests").split(",")[11], "t11");
});

import { defaultAvatar, sanitizeAvatar, avatarParam, parseAvatarParam, avatarLook, PALETTE } from "../js/avatar.js";
import { parseProviders, startUrl, registerReturnPath, parseLinked, unlinkProvider, initials } from "../js/accounts.js";
import { normalizeAuthBase } from "../js/auth.js";

test("avatar: default, sanitize (palette values only, per part), param round trip", () => {
  const d = defaultAvatar();
  assert.match(avatarParam(d), /^[0-9a-f]{6}-[0-9a-f]{6}-[0-9a-f]{6}-[0-9a-f]{6}-h0$/);
  assert.equal(PALETTE.skin.length, 5); assert.equal(PALETTE.hair.length, 6); assert.equal(PALETTE.shirt.length, 8); assert.equal(PALETTE.pants.length, 4);
  assert.ok(PALETTE.shirt.some((p) => p.hex === "c6f19d"));
  assert.deepEqual(sanitizeAvatar(null), d);
  assert.deepEqual(sanitizeAvatar("x"), d);
  const s = sanitizeAvatar({ skin: "#C68642", hair: "ff00ff", shirt: "3b82c4", pants: 5, hat: "yes" });
  assert.equal(s.skin, "c68642"); assert.equal(s.hair, d.hair); assert.equal(s.shirt, "3b82c4"); assert.equal(s.pants, d.pants); assert.equal(s.hat, false);
  const a = { skin: "5c3a21", hair: "d9b45a", shirt: "e8833a", pants: "4a6a4a", hat: true };
  assert.equal(avatarParam(a), "5c3a21-d9b45a-e8833a-4a6a4a-h1");
  assert.deepEqual(parseAvatarParam(avatarParam(a)), a);
  for (const bad of ["", "a-b", "5c3a21-d9b45a-e8833a-4a6a4a-h2", "zzzzzz-d9b45a-e8833a-4a6a4a-h1x", null]) assert.deepEqual(parseAvatarParam(bad), d);
  assert.equal(avatarLook(a).shirt, "#e8833a"); assert.equal(avatarLook(a).hat, true);
});

test("appTicketUrl adds &avatar=<param> last when given", () => {
  const a = { skin: "5c3a21", hair: "d9b45a", shirt: "e8833a", pants: "4a6a4a", hat: true };
  assert.equal(appTicketUrl({ slug: "x", name: "Mia", avatar: a }), "confcompanion://ticket?c=x&name=Mia&avatar=5c3a21-d9b45a-e8833a-4a6a4a-h1");
});

test("auth: providers, start and return URLs", () => {
  assert.deepEqual(parseProviders({ providers: [{ id: "github", enabled: true }, { id: "google", enabled: false }, { id: "evil", enabled: true }, null] }), { github: true, google: false });
  assert.deepEqual(parseProviders(null), {});
  assert.equal(startUrl("github", "/site/profile.html"), "/api/auth/github/start?return=%2Fsite%2Fprofile.html");
  assert.equal(startUrl("github", "/site/profile.html", "https://auth.example.org"), "https://auth.example.org/api/auth/github/start?return=%2Fsite%2Fprofile.html");
  assert.equal(registerReturnPath("a b", "google"), "/site/register.html?c=a%20b&via=google");
});

test("linked accounts: only known providers with a name; unlink; initials", () => {
  const l = parseLinked(JSON.stringify({ github: { displayName: " Mia Okafor ", handle: "mia", avatarUrl: "https://x/y.png", linkedAt: "t" }, google: { displayName: "" }, other: { displayName: "x" } }));
  assert.deepEqual(Object.keys(l), ["github"]);
  assert.equal(l.github.displayName, "Mia Okafor");
  assert.ok(!("avatarUrl" in l.github));
  assert.deepEqual(unlinkProvider(l, "github"), {});
  assert.deepEqual(parseLinked("nope"), {});
  assert.equal(initials("Mia Okafor"), "MO"); assert.equal(initials("mia"), "M"); assert.equal(initials(""), "?");
});

test("authBase validation: http(s) only, bare origin", () => {
  assert.equal(normalizeAuthBase("https://auth.example.org/"), "https://auth.example.org");
  assert.equal(normalizeAuthBase("http://127.0.0.1:4000/api/x?y=1#z"), "http://127.0.0.1:4000");
  for (const bad of ["javascript:alert(1)", "ftp://x.org", "//x.org", "auth.example.org", "", null, undefined, "data:text/html,x"]) assert.equal(normalizeAuthBase(bad), "", String(bad));
});

import { deletionPlan, LOCAL_DATA_KEYS, SESSION_DATA_KEYS, SESSION_DATA_PREFIXES } from "../js/profile.js";

test("delete my data: which keys are cleared", () => {
  assert.deepEqual([...LOCAL_DATA_KEYS].sort(), ["cc.avatar.v1", "cc.invite-shares.v1", "cc.kept-profile.v1", "cc.linked.v1", "cc.registrations.v1"]);
  assert.ok(SESSION_DATA_KEYS.includes("cc.token"));
  assert.deepEqual(SESSION_DATA_PREFIXES, ["cc.chat.v1."]);
});

test("delete my data: the message follows the response, and only 204 claims server deletion", () => {
  assert.equal(deletionPlan(204).message, "Deleted from this browser. Deleted from the server.");
  assert.equal(deletionPlan(204).serverDeleted, true);
  for (const status of [401, 404, null]) {
    const p = deletionPlan(status);
    assert.equal(p.message, "Deleted from this browser. No server record was found for this session.");
    assert.equal(p.serverDeleted, false);
    assert.equal(p.clearToken, true);
  }
  for (const status of [500, 503, 200, 403]) {
    const p = deletionPlan(status);
    assert.equal(p.serverDeleted, false);
    assert.equal(p.clearToken, false);
    assert.ok(!/Deleted from the server/.test(p.message));
  }
});
