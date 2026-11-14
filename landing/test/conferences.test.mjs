import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadConferences, filterConferences, getConference, nextEvent, resetConferencesCache, FALLBACK_CONFERENCES, DEFAULT_SLUG } from "../js/conferences.js";

const data = JSON.parse(fs.readFileSync(new URL("../data/conferences.json", import.meta.url), "utf8"));
const slugs = (l) => l.map((c) => c.slug);

test("data file: first entry is the event the app was built for; the rest are real US events plus two flagged demo events", () => {
  assert.equal(data.length, 12);
  const [first, ...rest] = data;
  assert.equal(first.slug, "cloud-native-hackathon-slc-2026");
  assert.equal(first.name, "Cloud Native Hackathon");
  assert.equal(first.startDate, "2026-11-09");
  assert.equal(first.venue, "The Shop Workspace");
  assert.equal(first.city, "Salt Lake City");
  assert.equal(first.assumed, false);
  for (const t of ["search", "observability", "kubernetes", "ai sre", "code review"]) assert.ok(first.topics.includes(t), t);
  assert.equal(DEFAULT_SLUG, first.slug);
  assert.deepEqual(rest.filter((c) => c.assumed).map((c) => c.slug), ["quillstack-web-2027", "sparrowfield-data-days-2027"]);
  const realRest = rest.filter((c) => !c.assumed);
  assert.equal(realRest.length, 9);
  for (const c of realRest) assert.match(c.url, /^https:\/\/[^ ]+$/, `${c.slug}: official site`);
  assert.deepEqual(rest.map((c) => c.startDate), rest.map((c) => c.startDate).sort(), "sorted by start date after the first entry");
});

test("data file: fields, summary length, unique slugs, 2026-2027, no street/phone/postcode-like content", () => {
  const required = ["slug", "name", "startDate", "endDate", "city", "venue", "topics", "summary", "assumed"];
  const optional = ["district", "capacity", "wifi", "url"];
  const seen = new Set();
  for (const c of data) {
    const keys = Object.keys(c);
    for (const k of required) assert.ok(keys.includes(k), `${c.slug}: ${k}`);
    for (const k of keys) assert.ok([...required, ...optional].includes(k), `${c.slug}: unexpected ${k}`);
    if (c.assumed) for (const k of ["district", "capacity", "wifi"]) assert.ok(keys.includes(k), `${c.slug}: demo event needs ${k}`);
    if (!c.assumed && c.slug !== DEFAULT_SLUG) for (const k of ["capacity", "wifi", "district"]) assert.ok(!keys.includes(k), `${c.slug}: no invented ${k}`);
    assert.match(c.slug, /^[a-z0-9-]+$/);
    assert.ok(!seen.has(c.slug)); seen.add(c.slug);
    assert.match(c.startDate, /^20(26|27)-\d{2}-\d{2}$/);
    assert.ok(c.endDate >= c.startDate);
    assert.ok(c.venue.length > 0);
    assert.ok(c.summary.split(/\s+/).length <= 18, `${c.slug}: ${c.summary.split(/\s+/).length} words`);
    assert.ok(Array.isArray(c.topics) && c.topics.length >= 3 && c.topics.every((t) => t === t.toLowerCase()));
    if (c.capacity !== undefined) assert.ok(Number.isInteger(c.capacity) && c.capacity > 0);
    const text = JSON.stringify([c.venue, c.district, c.city, c.summary]);
    assert.ok(!/\d{3,}/.test(text), `${c.slug}: digits that look like a number/postcode`);
    assert.ok(!/\b(street|st\.|avenue|ave\b|road|blvd|suite|p\.?o\.? box|tel|phone)\b/i.test(text), c.slug);
  }
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
  assert.deepEqual(slugs(filterConferences(data, { q: "seattle" })), ["srecon27-americas"]);
  assert.deepEqual(slugs(filterConferences(data, { q: "new orleans" })), ["kubecon-na-2027"]);
  assert.deepEqual(slugs(filterConferences(data, { q: "incident response" })), ["srecon27-americas"]); // topic
  assert.deepEqual(slugs(filterConferences(data, { q: "community-run" })), ["scale-24x-2027"]); // summary only
  assert.deepEqual(slugs(filterConferences(data, { q: "hackathon kubernetes" })), ["cloud-native-hackathon-slc-2026"]); // all words
  assert.deepEqual(filterConferences(data, { q: "zzzz" }), []);
  assert.deepEqual(slugs(filterConferences(data, { q: "  " })), slugs(data));
  assert.equal(filterConferences(data, { q: "The Shop Workspace" }).length, 0); // venue is not searched
});

test("filterConferences: topic and month", () => {
  assert.deepEqual(slugs(filterConferences(data, { topic: "Search" })), ["cloud-native-hackathon-slc-2026", "sparrowfield-data-days-2027"]);
  assert.deepEqual(slugs(filterConferences(data, { topic: "observability" })), ["cloud-native-hackathon-slc-2026", "srecon27-americas"]);
  assert.equal(filterConferences(data, { topic: "all" }).length, 12);
  assert.equal(filterConferences(data, { topic: "se" }).length, 0); // exact tag, not substring
  assert.deepEqual(slugs(filterConferences(data, { month: "2026-11" })), ["cloud-native-hackathon-slc-2026", "aws-reinvent-2026"]); // re:Invent spans Nov and Dec
  assert.deepEqual(slugs(filterConferences(data, { month: "2027-04" })), ["scale-24x-2027", "srecon27-americas", "google-cloud-next-2027", "confidential-computing-summit-2027", "agntcon-mcpcon-na-2027"]);
  assert.deepEqual(slugs(filterConferences(data, { month: "12" })), ["aws-reinvent-2026"]);
  assert.deepEqual(slugs(filterConferences(data, { month: "10" })), ["pytorch-conference-2027"]);
  assert.deepEqual(filterConferences(data, { month: "2030-01" }), []);
  assert.deepEqual(filterConferences(data, { month: "garbage" }), []);
  assert.deepEqual(slugs(filterConferences(data, { q: "search", topic: "search", month: "2027-06" })), ["sparrowfield-data-days-2027"]);
  // multi-month events match each month they span
  const span = [{ slug: "s", name: "S", city: "C", topics: [], summary: "", startDate: "2026-01-30", endDate: "2026-02-01" }];
  assert.equal(filterConferences(span, { month: "2026-02" }).length, 1);
  assert.equal(filterConferences(span, { month: "2026-03" }).length, 0);
});

test("nextEvent: soonest real event that has not ended; demo events never; the latest once all are over", () => {
  const next = (today) => nextEvent(data, today)?.slug;
  assert.equal(next("2026-11-09"), "cloud-native-hackathon-slc-2026"); // on the day it still runs
  assert.equal(next("2026-11-10"), "aws-reinvent-2026");
  assert.equal(next("2026-12-04"), "aws-reinvent-2026"); // last day of a multi-day event
  assert.equal(next("2026-12-05"), "scale-24x-2027"); // quillstack (Austin, 2027-03-23) is a demo event and is skipped
  assert.equal(next("2027-04-13"), "srecon27-americas"); // still running (12 to 14 April)
  assert.equal(next("2027-11-11"), "kubecon-na-2027");
  assert.equal(next("2028-01-01"), "kubecon-na-2027"); // all over: the latest
  assert.equal(nextEvent([data.find((c) => c.assumed)], "2026-11-10"), null);
  assert.equal(nextEvent([], "2026-11-10"), null);
});
