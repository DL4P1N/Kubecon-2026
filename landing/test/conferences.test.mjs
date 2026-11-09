import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadConferences, filterConferences, getConference, resetConferencesCache, FALLBACK_CONFERENCES, DEFAULT_SLUG } from "../js/conferences.js";

const data = JSON.parse(fs.readFileSync(new URL("../data/conferences.json", import.meta.url), "utf8"));
const slugs = (l) => l.map((c) => c.slug);

test("data file: first entry is the one real event, the rest are flagged assumed", () => {
  assert.equal(data.length, 8);
  const [real, ...rest] = data;
  assert.equal(real.slug, "cloud-native-hackathon-slc-2026");
  assert.equal(real.name, "Cloud Native Hackathon");
  assert.equal(real.startDate, "2026-11-09");
  assert.equal(real.venue, "The Shop Workspace");
  assert.equal(real.city, "Salt Lake City");
  assert.equal(real.assumed, false);
  for (const t of ["search", "observability", "kubernetes", "ai sre", "code review"]) assert.ok(real.topics.includes(t), t);
  assert.equal(rest.length, 7);
  assert.ok(rest.every((c) => c.assumed === true));
  assert.equal(DEFAULT_SLUG, real.slug);
});

test("data file: fields, summary length, unique slugs, 2026-2027, no street/phone/postcode-like content", () => {
  const keys = ["slug", "name", "startDate", "endDate", "city", "district", "venue", "topics", "summary", "capacity", "assumed"];
  const seen = new Set();
  for (const c of data) {
    assert.deepEqual(Object.keys(c).sort(), [...keys].sort(), c.slug);
    assert.match(c.slug, /^[a-z0-9-]+$/);
    assert.ok(!seen.has(c.slug)); seen.add(c.slug);
    assert.match(c.startDate, /^20(26|27)-\d{2}-\d{2}$/);
    assert.ok(c.endDate >= c.startDate);
    assert.ok(c.summary.split(/\s+/).length <= 18, `${c.slug}: ${c.summary.split(/\s+/).length} words`);
    assert.ok(Array.isArray(c.topics) && c.topics.length >= 3 && c.topics.every((t) => t === t.toLowerCase()));
    assert.ok(Number.isInteger(c.capacity) && c.capacity > 0);
    const text = JSON.stringify([c.venue, c.district, c.city, c.summary]);
    assert.ok(!/\d{3,}/.test(text), `${c.slug}: digits that look like a number/postcode`);
    assert.ok(!/\b(street|st\.|avenue|ave\b|road|blvd|suite|p\.?o\.? box|tel|phone)\b/i.test(text), c.slug);
  }
  assert.ok(new Set(data.slice(1).map((c) => c.city)).size === 7, "different cities");
  assert.ok(data.some((c) => c.startDate.startsWith("2027")) && data.some((c) => c.startDate.startsWith("2026")));
});

test("the inlined fallback copy equals the JSON file", () => {
  assert.deepEqual(FALLBACK_CONFERENCES, data);
});

test("loadConferences: fetches the file, falls back to the inlined copy on any failure", async () => {
  const realFetch = globalThis.fetch;
  try {
    resetConferencesCache();
    const custom = [{ slug: "x", name: "X", startDate: "2026-01-01", endDate: "2026-01-02", topics: ["a"] }];
    let requested;
    globalThis.fetch = async (url) => { requested = String(url); return new Response(JSON.stringify(custom), { status: 200 }); };
    assert.deepEqual(await loadConferences(), custom);
    assert.match(requested, /\/data\/conferences\.json$/);
    assert.deepEqual(getConference("x"), custom[0]);
    // cached
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.deepEqual(await loadConferences(), custom);

    for (const f of [
      async () => { throw new Error("offline"); },
      async () => new Response("nope", { status: 404 }),
      async () => new Response("<html>spa fallback</html>", { status: 200 }),
      async () => new Response("[]", { status: 200 }),
      async () => new Response(JSON.stringify([{ slug: 1 }]), { status: 200 }),
    ]) {
      resetConferencesCache();
      globalThis.fetch = f;
      assert.deepEqual(await loadConferences(), FALLBACK_CONFERENCES);
    }
    assert.equal(getConference(DEFAULT_SLUG).name, "Cloud Native Hackathon");
    assert.equal(getConference("nope"), undefined);
  } finally {
    globalThis.fetch = realFetch;
    resetConferencesCache();
  }
});

test("filterConferences: text search is case-insensitive over name, city, topics and summary", () => {
  assert.deepEqual(slugs(filterConferences(data, {})), slugs(data));
  assert.deepEqual(slugs(filterConferences(data, { q: "SALT lake" })), ["cloud-native-hackathon-slc-2026"]);
  assert.deepEqual(slugs(filterConferences(data, { q: "lisbon" })), ["lowtide-security-congress-2027"]);
  assert.deepEqual(slugs(filterConferences(data, { q: "zero trust" })), ["lowtide-security-congress-2027"]);
  assert.deepEqual(slugs(filterConferences(data, { q: "maintainers" })), ["brightwater-open-source-weekend-2027"]); // topic and summary
  assert.deepEqual(slugs(filterConferences(data, { q: "paved roads" })), ["harborline-platform-days-2026"]); // summary only
  assert.deepEqual(slugs(filterConferences(data, { q: "hackathon kubernetes" })), ["cloud-native-hackathon-slc-2026"]); // all words
  assert.deepEqual(filterConferences(data, { q: "zzzz" }), []);
  assert.deepEqual(slugs(filterConferences(data, { q: "  " })), slugs(data));
  assert.equal(filterConferences(data, { q: "The Shop Workspace" }).length, 0); // venue is not searched
});

test("filterConferences: topic and month", () => {
  assert.deepEqual(slugs(filterConferences(data, { topic: "Search" })), ["cloud-native-hackathon-slc-2026", "sparrowfield-data-days-2027"]);
  assert.deepEqual(slugs(filterConferences(data, { topic: "observability" })), ["cloud-native-hackathon-slc-2026", "tidepool-edge-summit-2027"]);
  assert.equal(filterConferences(data, { topic: "all" }).length, 8);
  assert.equal(filterConferences(data, { topic: "se" }).length, 0); // exact tag, not substring
  assert.deepEqual(slugs(filterConferences(data, { month: "2026-11" })), ["cloud-native-hackathon-slc-2026"]);
  assert.deepEqual(slugs(filterConferences(data, { month: "2027-05" })), ["lowtide-security-congress-2027"]);
  assert.deepEqual(slugs(filterConferences(data, { month: "12" })), ["harborline-platform-days-2026"]);
  assert.deepEqual(slugs(filterConferences(data, { month: "05" })), ["lowtide-security-congress-2027"]);
  assert.deepEqual(filterConferences(data, { month: "2030-01" }), []);
  assert.deepEqual(filterConferences(data, { month: "garbage" }), []);
  assert.deepEqual(slugs(filterConferences(data, { q: "search", topic: "search", month: "2027-06" })), ["sparrowfield-data-days-2027"]);
  // multi-month events match each month they span
  const span = [{ slug: "s", name: "S", city: "C", topics: [], summary: "", startDate: "2026-01-30", endDate: "2026-02-01" }];
  assert.equal(filterConferences(span, { month: "2026-02" }).length, 1);
  assert.equal(filterConferences(span, { month: "2026-03" }).length, 0);
});
