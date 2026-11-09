import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProfileMarker } from "../server.mjs";
import { validateProfile, normaliseTags, scriptedTurn, isSensitive, parseYesNo, cleanText } from "../js/chat-script.js";
import { validProfile } from "./helpers.mjs";

const marker = (o) => `Done!\n<<PROFILE ${typeof o === "string" ? o : JSON.stringify(o)}>>`;

test("parseProfileMarker accepts a valid marker, strips it, and returns the normalised profile", () => {
  const r = parseProfileMarker(marker(validProfile()), { userTurns: 8 });
  assert.equal(r.text, "Done!");
  assert.deepEqual(r.profile, validProfile());
});

test("parseProfileMarker: normalises tags, drops unknown keys, strips markdown from the text", () => {
  const raw = { ...validProfile(), interests: ["Kubernetes!!", "  AI   SRE ", "kubernetes", "Obser-vability"], extra: "x", isAdmin: true };
  const r = parseProfileMarker("**Great**, you're set.\n" + marker(raw).split("\n")[1], { userTurns: 5 });
  assert.equal(r.text, "Great, you're set.");
  assert.deepEqual(r.profile.interests, ["kubernetes", "ai sre", "obser-vability"]);
  assert.equal("extra" in r.profile, false);
  assert.equal("isAdmin" in r.profile, false);
});

test("parseProfileMarker: hostile or malformed JSON never yields a profile and never leaks the marker", () => {
  const cases = [
    "{}", "[]", "null", '"str"', "42", "{", '{"name":"A"', "not json", "{'name':'A'}",
    JSON.stringify({ ...validProfile(), name: 5 }),
    JSON.stringify({ ...validProfile(), name: "x".repeat(81) }),
    JSON.stringify({ ...validProfile(), role: "" }),
    JSON.stringify({ ...validProfile(), interests: "kubernetes" }),
    JSON.stringify({ ...validProfile(), interests: [] }),
    JSON.stringify({ ...validProfile(), interests: ["a1", "b2", "c3", "d4", "e5", "f6", "g7"] }),
    JSON.stringify({ ...validProfile(), interests: [{ toString: 1 }] }),
    JSON.stringify({ ...validProfile(), interests: [["nested"]] }),
    JSON.stringify({ ...validProfile(), goal: "g".repeat(61) }),
    JSON.stringify({ ...validProfile(), formats: "f".repeat(121) }),
    JSON.stringify({ ...validProfile(), goal: 1 }),
    JSON.stringify({ ...validProfile(), formats: null }),
    JSON.stringify({ ...validProfile(), padding: "p".repeat(3000) }), // oversize marker
    "{" + '"name":"A",'.repeat(10) + '"role":"r"}', // duplicate keys still need the rest
  ];
  for (const c of cases) {
    const r = parseProfileMarker(marker(c), { userTurns: 8 });
    assert.equal(r.profile, null, c.slice(0, 60));
    assert.ok(!/PROFILE|<<|>>/.test(r.text), c.slice(0, 60));
  }
});

test("parseProfileMarker: a __proto__ key is ignored, not copied or applied", () => {
  const r = parseProfileMarker(marker('{"__proto__":{"polluted":true},' + JSON.stringify(validProfile()).slice(1)), { userTurns: 8 });
  assert.deepEqual(r.profile, validProfile());
  assert.equal(Object.getPrototypeOf(r.profile), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(r.profile.polluted, undefined);
});

test("parseProfileMarker: control characters, bidi marks and long text are cleaned or rejected", () => {
  const p = { ...validProfile(), name: "Ada‮\u0000​Lovelace\n", role: "eng\tineer" };
  const r = parseProfileMarker(marker(p), { userTurns: 8 });
  assert.equal(r.profile.name, "Ada Lovelace");
  assert.equal(r.profile.role, "eng ineer");
});

test("parseProfileMarker: two markers, text after the marker, or a marker too early are all dropped", () => {
  const one = `<<PROFILE ${JSON.stringify(validProfile())}>>`;
  assert.equal(parseProfileMarker(`${one}\n${one}`, { userTurns: 8 }).profile, null);
  assert.equal(parseProfileMarker(one, { userTurns: 1 }).profile, null);
  const trailing = parseProfileMarker(`Hi ${one} trailing words`, { userTurns: 8 });
  assert.ok(trailing.profile);
  assert.ok(!trailing.text.includes("<<"));
  assert.equal(parseProfileMarker(`Hi <<PROFILE {"name":"A"`, { userTurns: 8 }).text, "Hi");
});

test("validateProfile: strictness, sensitive data is dropped", () => {
  assert.equal(validateProfile(null).ok, false);
  assert.equal(validateProfile([]).ok, false);
  assert.equal(validateProfile("x").ok, false);
  const v = validateProfile({
    ...validProfile(),
    interests: ["kubernetes", "my diabetes", "politics", "leader election", "health checks", "race condition", "church", "christian music", "tag with age 40"],
    role: "I am gay",
    goal: "meet people of my religion",
    formats: "my cancer treatment",
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.profile.interests, ["kubernetes", "leader election", "health checks", "race condition"].slice(0, 4));
  assert.equal(v.profile.role, "attendee");
  assert.equal(v.profile.goal, "");
  assert.equal(v.profile.formats, "");
  // only sensitive tags -> nothing left -> rejected
  assert.equal(validateProfile({ ...validProfile(), interests: ["politics", "religion"] }).ok, false);
});

test("normaliseTags", () => {
  assert.deepEqual(normaliseTags("Kubernetes, observability and AI SRE; code review"), ["kubernetes", "observability", "ai sre", "code review"]);
  assert.deepEqual(normaliseTags("I'm interested in search"), ["search"]);
  assert.deepEqual(normaliseTags("a, b, search, Search"), ["search"]); // 1-char tags dropped, deduplicated
  assert.deepEqual(normaliseTags("a1,b2,c3,d4,e5,f6,g7,h8", 6).length, 6);
  assert.deepEqual(normaliseTags("x".repeat(40)), []);
  assert.deepEqual(normaliseTags("<script>alert(1)</script>"), ["script alert 1 script"]);
});

test("isSensitive / parseYesNo / cleanText", () => {
  for (const t of ["my health", "I am 45 years old", "my religion", "ethnicity", "political party", "sexual orientation", "gender"]) assert.equal(isSensitive(t), true, t);
  for (const t of ["kubernetes", "health checks", "leader election", "race condition", "observability", "ai sre"]) assert.equal(isSensitive(t), false, t);
  assert.equal(parseYesNo("Yes please"), true);
  assert.equal(parseYesNo("nope"), false);
  assert.equal(parseYesNo("maybe"), null);
  assert.equal(parseYesNo(""), null);
  assert.equal(cleanText("  a \u0000\n\t b​ "), "a b");
});

function converse(answers, ctx = {}) {
  const messages = [];
  let t;
  for (let i = 0; i <= answers.length; i++) {
    t = scriptedTurn({ conference: { name: "Cloud Native Hackathon" }, ...ctx, messages });
    messages.push({ role: "assistant", content: t.reply });
    if (i < answers.length) messages.push({ role: "user", content: answers[i] });
  }
  return { t, messages };
}

test("scripted flow: happy path produces a valid, validator-approved profile with no consent questions", () => {
  const { t, messages } = converse(["My name is Grace", "I'm a site reliability engineer", "tracing, kubernetes, search", "build", "workshops please", "Yes, register me"]);
  assert.equal(t.done, true);
  assert.deepEqual(t.profile, {
    name: "Grace", role: "site reliability engineer", interests: ["tracing", "kubernetes", "search"],
    goal: "build", formats: "workshops please",
  });
  assert.equal(validateProfile(t.profile).ok, true);
  const bots = messages.filter((m) => m.role === "assistant").map((m) => m.content);
  // the registering sentence is said once, in the opening message, before the first question
  assert.match(bots[0], /^Registering keeps your answers for this and future conferences, gives you a QR ticket for room doors, and counts your interests anonymously in the organisers' interest map\. What should I call you\?$/);
  assert.equal(bots.filter((m) => /Registering keeps/.test(m)).length, 1);
  // no consent questions and no deletion statements anywhere
  for (const m of bots) {
    assert.ok(!/24 hours|deleted|consent|may I include|Yes or no|would you like to use QR/i.test(m), m);
    assert.ok(m.split(/[.?!]\s/).length <= 3 || /Here is what I have/.test(m), m);
  }
});

test("scripted flow: re-asks on unclear answers, 'Change something' fixes one field, ignores sensitive input", () => {
  const { t, messages } = converse([
    "Linus", "maintainer", "my diabetes", "linux kernel, rust", "learn", "none",
    "hmm",                 // unclear at the summary
    "Change something",    // -> which part?
    "banana",              // not a field
    "the topics please",   // -> topics again
    "rust, wasm",
    "yes",
  ]);
  assert.equal(t.done, true);
  assert.equal(t.profile.name, "Linus");
  assert.deepEqual(t.profile.interests, ["rust", "wasm"]);
  assert.equal(t.profile.goal, "learn");
  const bots = messages.filter((m) => m.role === "assistant").map((m) => m.content);
  assert.ok(bots.some((m) => /What would you like to change/.test(m)));
  assert.ok(bots.some((m) => /did not catch which part/.test(m)));
});

test("scripted flow: via acknowledgement only on the opening message", () => {
  const first = scriptedTurn({ conference: { name: "X" }, via: "linkedin", messages: [] });
  assert.match(first.reply, /signed in with LinkedIn/);
  const qr = scriptedTurn({ conference: { name: "X" }, via: "qr", messages: [] });
  assert.match(qr.reply, /scanned/);
  const second = scriptedTurn({ conference: { name: "X" }, via: "linkedin", messages: [{ role: "assistant", content: "..." }, { role: "user", content: "Lin" }] });
  assert.ok(!/signed in/.test(second.reply));
  assert.equal(scriptedTurn({ conference: { name: "X" }, via: "bogus", messages: [] }).reply.includes("signed in"), false);
});

test("scripted flow never asks about sensitive topics", () => {
  const { messages } = converse(["A", "B", "search, kubernetes", "learn", "none", "yes"]);
  const asked = messages.filter((m) => m.role === "assistant").map((m) => m.content).join(" ");
  assert.ok(!/health|politic|religio|ethnic|sexual|\bage\b|address|location/i.test(asked), asked);
});

test("summary read-back is one item per line, and the server keeps those line breaks", async () => {
  const { tidyReplyForTest } = await import("../server.mjs").then((m) => ({ tidyReplyForTest: m.tidyReply }));
  const { t } = converse(["Grace", "sre", "tracing, kubernetes", "build", "workshops"].slice(0, 5));
  assert.equal(t.reply.split("\n").length, 7);
  assert.match(t.reply, /\nName: Grace\nRole: sre\nTopics: tracing, kubernetes\nGoal: build\nFormats: workshops\nRegister you with these\?$/);
  assert.equal(tidyReplyForTest("Here is what I have:\n**Name:** Ada\n\n  Role:   eng \n- Topics: a, b\nRegister you with these?"), "Here is what I have:\nName: Ada\nRole: eng\nTopics: a, b\nRegister you with these?");
});
