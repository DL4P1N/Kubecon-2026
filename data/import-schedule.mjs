#!/usr/bin/env node
// Regenerates data/talks.json from the official KubeCon + CloudNativeCon North
// America schedule page (the Linux Foundation event site, server-rendered).
//
//   node data/import-schedule.mjs [--url <schedule url>] [--out data/talks.json] [--tz-offset -07:00]
//
// Only public session fields are kept: title, abstract, speaker names, room,
// times, track and level. No speaker contact data, bios or links are stored.
// Times on the page are venue-local (Salt Lake City, MST in November); they
// are converted to UTC using --tz-offset.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const URL_ = opt("--url", "https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/program/schedule/");
const OUT = opt("--out", fileURLToPath(new URL("./talks.json", import.meta.url)));
const TZ = opt("--tz-offset", "-07:00");

const unescapeHtml = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
const text = (s) => unescapeHtml(s.replace(/<br\s*\/?>/gi, " ").replace(/<\/p>\s*<p>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const stripEmoji = (s) => s.replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/\s+/g, " ").trim();
const slug = (s) =>
  stripEmoji(s)
    .toLowerCase()
    .replace(/\+/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const toUtc = (local) => new Date(`${local}${TZ}`).toISOString();

// Primary tags that are real talk tracks. Anything else (e.g. "Maintainer
// Track", "Keynote Sessions") is kept as the track name itself.
const TOPIC_TRACKS = new Set([
  "AI Inference + Agentic",
  "Platform Engineering",
  "Observability",
  "Operations + Performance",
  "Security",
  "Application Development + Delivery",
  "Connectivity",
  "Data Processing + Storage",
  "Emerging + Advanced",
  "Cloud Native Novice",
]);
// Not talks an attendee would schedule: logistics, booth/sponsor demos, add-on events.
const EXCLUDED_PRIMARY = new Set([
  "Sponsor Demo Theater",
  "Solutions Showcase",
  "Experiences",
  "Project Opportunities",
  "Project Pavilion Tours",
  "Sponsor-hosted Co-located Events",
  "CNCF-hosted Co-located Events",
]);
const LEVELS = { Beginner: "beginner", Advanced: "advanced" }; // "Any Level"/untagged -> intermediate
const NON_TOPIC_TAGS = new Set(["Any Level", "Beginner", "Advanced", "Separate Registration Required", "Sponsored"]);

// Keyword vocabulary for tags, matched against title + abstract (word boundaries).
const KEYWORDS = {
  kubernetes: /\bkubernetes\b|\bk8s\b/i,
  ai: /\bAI\b|\bLLMs?\b|\bagent(?:s|ic)?\b|\bgenerative\b/,
  inference: /\binference\b/i,
  gpu: /\bGPUs?\b/,
  mcp: /\bMCP\b/,
  opentelemetry: /\bopen ?telemetry\b|\botel\b/i,
  observability: /\bobservability\b/i,
  ebpf: /\beBPF\b/i,
  security: /\bsecurity\b|\bvulnerabilit|\bCVEs?\b/i,
  "supply-chain": /\bsupply chain\b|\bSBOM\b|\bsigstore\b/i,
  "zero-trust": /\bzero[- ]trust\b|\bSPIFFE\b|\bSPIRE\b/i,
  policy: /\bpolic(?:y|ies)\b|\bkyverno\b|\bOPA\b/i,
  "platform-engineering": /\bplatform engineering\b|\bplatform teams?\b|\binternal developer platform\b|\bIDP\b/i,
  gitops: /\bgitops\b|\bargo ?cd\b|\bflux\b/i,
  "service-mesh": /\bservice mesh\b|\bistio\b|\blinkerd\b|\benvoy\b/i,
  networking: /\bnetworking\b|\bnetwork polic|\bcilium\b|\bCNI\b/i,
  storage: /\bstorage\b|\bpersistent volumes?\b|\bCSI\b/i,
  databases: /\bdatabases?\b|\bpostgres(?:ql)?\b|\bvitess\b/i,
  scheduling: /\bschedul(?:er|ing)\b|\bkueue\b|\bkarpenter\b|\bautoscal/i,
  cost: /\bFinOps\b|\bcost (?:optimi[sz]ation|savings|management)\b/i,
  "multi-cluster": /\bmulti-?cluster\b|\bfleet\b/i,
  edge: /\bedge\b/i,
  wasm: /\bwebassembly\b|\bwasm\b/i,
  serverless: /\bserverless\b/i,
  "ci-cd": /\bCI\/CD\b|\bcontinuous (?:delivery|integration|deployment)\b/i,
  sre: /\bSRE\b|\bincident\b|\bon-?call\b/i,
  "developer-experience": /\bdeveloper experience\b|\bDevEx\b|\bgolden paths?\b/i,
  oss: /\bopen source\b|\bmaintainers?\b|\bcontributors?\b/i,
  accessibility: /\baccessib/i,
  migration: /\bmigrat(?:e|ion|ing)\b/i,
  upgrades: /\bupgrades?\b/i,
  tutorial: /\btutorial\b|\bhands-on\b/i,
};

function parse(html) {
  const day = (html.match(/<title>([^<]*)/) || [])[1];
  const blocks = html.split('<div class="sess-wrap">').slice(1);
  const talks = [];
  const skipped = {};
  const skip = (why) => (skipped[why] = (skipped[why] || 0) + 1);
  for (const b of blocks) {
    const get = (re) => (b.match(re) || [])[1];
    const sid = get(/data-session-id="(\d+)"/);
    const title = stripEmoji(text(get(/class="sess__title">([\s\S]*?)<\/div>/) || ""));
    const room = text(get(/class="sess__room">([\s\S]*?)<\/span>/) || "");
    const speakers = text(get(/class="sess__speakers">([\s\S]*?)<\/span>/) || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const primary = [...b.matchAll(/class="tag tag--primary">([^<]*)</g)].map((m) => unescapeHtml(m[1]).trim());
    const secondary = [...b.matchAll(/class="tag">([^<]*)</g)].map((m) => unescapeHtml(m[1]).trim());
    const times = [...b.matchAll(/<time datetime="([^"]+)"/g)].map((m) => m[1]);
    const desc = text(get(/class="sess__seodesc">([\s\S]*?)<\/div>/) || "");

    if (!sid || !title) continue;
    if (primary.some((p) => EXCLUDED_PRIMARY.has(p))) { skip("excluded type"); continue; }
    if (secondary.includes("Separate Registration Required")) { skip("separate registration"); continue; }
    if (primary.length === 0) { skip("logistics (registration, breaks, bag check)"); continue; }
    if (speakers.length === 0) { skip("no speakers"); continue; }
    if (!desc) { skip("no abstract"); continue; }
    if (times.length !== 2) { skip("no times"); continue; }

    const p0 = primary[0];
    const topic = TOPIC_TRACKS.has(p0) ? p0 : secondary.find((t) => TOPIC_TRACKS.has(t));
    const track = stripEmoji(topic ?? p0);
    const levelTag = secondary.find((t) => t in LEVELS);
    const level = levelTag ? LEVELS[levelTag] : "intermediate";

    const tags = new Set();
    tags.add(slug(track));
    if (!TOPIC_TRACKS.has(p0)) tags.add(slug(p0));
    for (const t of secondary) if (!NON_TOPIC_TAGS.has(t) && !TOPIC_TRACKS.has(t)) tags.add(slug(t));
    if (secondary.includes("Sponsored")) tags.add("sponsored");
    const haystack = `${title}. ${desc}`;
    for (const [tag, re] of Object.entries(KEYWORDS)) if (re.test(haystack)) tags.add(tag);

    talks.push({
      id: `kcna26-${sid}`,
      title,
      speaker: speakers.join(", "),
      abstract: desc.replace(/\S+@\S+\.\S+/g, "[email removed]"),
      track,
      level,
      room,
      start: toUtc(times[0]),
      end: toUtc(times[1]),
      tags: [...tags].filter(Boolean).slice(0, 10),
    });
  }
  talks.sort((a, b) => a.start.localeCompare(b.start) || a.room.localeCompare(b.room) || a.id.localeCompare(b.id));
  return { talks, skipped, pageTitle: day, sessionBlocks: blocks.length };
}

const res = await fetch(URL_, { headers: { "user-agent": "conference-companion-importer/1.0" } });
if (!res.ok) throw new Error(`GET ${URL_} -> ${res.status}`);
const { talks, skipped, sessionBlocks } = parse(await res.text());
await writeFile(OUT, JSON.stringify(talks, null, 2) + "\n");
console.log(`parsed ${sessionBlocks} session blocks, kept ${talks.length}; skipped:`, skipped);
console.log(`wrote ${OUT}`);
