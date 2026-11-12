#!/usr/bin/env node
// Synthetic demo data for the Conference Companion (Cloud Native Hackathon, Salt Lake City, Mon 9 Nov 2026).
//
// 1. Builds a synthetic one-day programme from the WHOLE talk catalogue: real talk ids and titles,
//    re-slotted into seven one-hour slots (10:00 to 17:00) across the five programme spaces.
//    The keynote gets the broadest talk each slot; room-a to room-d get topic-grouped talks.
//    The lounge has no sessions; it counts people who have a free slot (cap 30).
// 2. Builds 184 synthetic attendees who pick 4-6 non-overlapping sessions matched to their interests.
// 3. Writes demo-attendees.json and demo-aggregates.json after self-checks pass.
//
// Deterministic: seeded mulberry32, no Math.random. The only clock read is generatedAt.
// Node 22, built-ins only. Run: node landing/data/generate-demo.mjs
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TALKS_PATH = join(HERE, '..', '..', 'data', 'talks.json');
const CONFERENCES_PATH = join(HERE, 'conferences.json');
const ATTENDEES_OUT = join(HERE, 'demo-attendees.json');
const AGGREGATES_OUT = join(HERE, 'demo-aggregates.json');

const SEED = 20261109;
const CONFERENCE = 'cloud-native-hackathon-slc-2026';
const EVENT_DATE = '2026-11-09';
const NOTE = 'Synthetic demo data. No real people.';
const PROGRAMME_NOTE = 'Synthetic one-day programme: real talk titles re-slotted into one day for the demo.';
const N_ATTENDEES = 184;
const SCAN_RATE = 0.85; // share of scheduled sessions actually attended and scanned
const DENIED_RATE = 0.04; // share of all scans denied at the door
const MIN_GROUP = 5; // groups and tags below this are folded into "other"
const LOCAL_OFFSET_MS = 7 * 3600e3; // Salt Lake City on 9 Nov 2026 is MST (UTC-7)
const DAY_START_MS = Date.parse(`${EVENT_DATE}T00:00:00Z`);

// Programme shape
const SLOT_HOURS = [10, 11, 12, 13, 14, 15, 16]; // one-hour slots, 10:00 to 17:00
const SLOT_LEN_SEC = 3600;
const TALK_SCAN_WINDOW_SEC = 300; // scan lands within 5 minutes of the slot start
const LOUNGE_WINDOW_SEC = 3000; // lounge drop-in lands within the hour

// Load shaping (demo design). Per slot: the keynote's draw and the draw of room-a..room-d.
// Keynote dominates most slots. Three slots have a popular room (a, b, c) that pulls the
// crowd away from the keynote. room-d is quiet throughout.
const SLOT_DRAW = [
  { keynote: 80, rooms: [1, 1, 1, 0.4] }, // 10:00
  { keynote: 10, rooms: [3, 1, 1, 0.4] }, // 11:00, room-a popular
  { keynote: 80, rooms: [1, 1, 1, 0.4] }, // 12:00
  { keynote: 10, rooms: [1, 2.5, 1, 0.4] }, // 13:00, room-b popular
  { keynote: 80, rooms: [1, 1, 1, 0.4] }, // 14:00
  { keynote: 80, rooms: [1, 1, 1, 0.4] }, // 15:00
  { keynote: 80, rooms: [1, 1, 1, 0.4] }, // 16:00
];
const TOPIC_W = 6; // weight bonus per matching interest for room sessions
const LOUNGE_P = 0.5; // chance of a lounge drop-in in a free slot

// ---------------------------------------------------------------------------
// PRNG and helpers
// ---------------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const shuffle = (rng, arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const sampleN = (rng, arr, n) => shuffle(rng, arr).slice(0, n);
const weighted = (rng, entries) => {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r < 0) return value;
  }
  return entries[entries.length - 1][0];
};
const p2 = (n) => String(n).padStart(2, '0');
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

// Seconds since local midnight (MST) for a catalogue ISO timestamp.
const localSec = (iso) => (Date.parse(iso) - LOCAL_OFFSET_MS - DAY_START_MS) / 1000;
// Local ISO timestamp with explicit offset, from seconds since local midnight.
const fmtLocal = (sec) =>
  `${EVENT_DATE}T${p2(Math.floor(sec / 3600))}:${p2(Math.floor((sec % 3600) / 60))}:${p2(sec % 60)}-07:00`;
const hourOf = (localIso) => Number(localIso.slice(11, 13));
const slotStartSec = (s) => SLOT_HOURS[s] * 3600;

// ---------------------------------------------------------------------------
// Static tables
// ---------------------------------------------------------------------------
const FIRST_NAMES = [
  'Amara', 'Mateo', 'Priya', 'Kenji', 'Fatima', 'Lukas', 'Ngozi', 'Sofia', 'Ravi', 'Hana',
  'Diego', 'Ingrid', 'Tariq', 'Mei', 'Oluwaseun', 'Lucia', 'Arjun', 'Freya', 'Samuel', 'Yara',
  'Jamal', 'Elif', 'Kwame', 'Noor', 'Tomas', 'Aiko', 'Gabriel', 'Zainab', 'Mikhail', 'Leilani',
  'Rafael', 'Ines', 'Dev', 'Chiara', 'Kofi', 'Mariana', 'Hiroshi', 'Anaya', 'Pavel', 'Esperanza',
  'Nnamdi', 'Sunita', 'Javier', 'Greta', 'Idris', 'Lin', 'Thandiwe', 'Viktor', 'Camila', 'Yusuf',
  'Astrid', 'Marisol', 'Dmitri', 'Adaeze', 'Bruno', 'Keiko', 'Rohan', 'Ximena', 'Emeka', 'Solveig',
  'Hugo', 'Nadia', 'Taiwo', 'Mateus', 'Shabnam', 'Ezra', 'Paloma', 'Andrei', 'Wren', 'Olu',
  'Ayumi', 'Malik', 'Renata', 'Bashir', 'Ishaan', 'Ingeborg', 'Teodor', 'Yolanda', 'Sipho', 'Ailbhe',
  'Kaito', 'Paulina', 'Wei', 'Hamid', 'Lucas',
];

const LAST_NAMES = [
  'Okafor', 'Lindqvist', 'Nakamura', 'Haddad', 'Castillo', 'Mensah', 'Petrov', 'Ferreira', 'Adeyemi', 'Kowalski',
  'Bhatt', 'Moreau', 'Tanaka', 'Okonkwo', 'Rahimi', 'Svensson', 'Delgado', 'Achterberg', 'Mwangi', 'Iyer',
  'Quintero', 'Fischer', 'Yildiz', 'Sato', 'Oyelaran', 'Novak', 'Hernandez', 'Lindgren', 'Chowdhury', 'Abara',
  'Ruiz', 'Halvorsen', 'Kim', 'Gallo', 'Ndlovu', 'Duarte', 'Park', 'Brennan', 'Mazur', 'Aguilar',
  'Jensen', 'Ibrahim', 'Vargas', 'Kaur', 'Lehtonen', 'Mendoza', 'Osei', 'Hoffmann', 'Pereira', 'Sandoval',
  'Akhtar', 'Ferrer', 'Dube', 'Holm', 'Kaplan', 'Nunez', 'Tran', 'Bianchi', 'Eze', 'Romero',
  'Sokolov', 'Lakhani', 'Benitez', 'Okoye', 'Ito', 'Morales', 'Aziz', 'Rosenthal', 'Reyes', 'Kovacs',
  'Shah', 'Salazar', 'Ogunleye', 'Whitfield', 'Mbeki', 'Szabo', 'Yamamoto', 'Quispe', 'Lund', 'Abdi',
  'Kalinowski',
];

const ROLES = [
  ['platform engineer', 14], ['site reliability engineer', 12], ['backend developer', 16],
  ['security engineer', 9], ['data engineer', 8], ['ML engineer', 8],
  ['engineering manager', 7], ['developer advocate', 5], ['student', 7],
  ['founder', 5], ['product manager', 6], ['QA engineer', 5],
  ['solutions architect', 5], ['DevOps engineer', 9],
];
const GOALS = [['learn', 35], ['build', 25], ['meet', 25], ['hire', 15]];
const FORMATS = [['talks', 40], ['workshops', 20], ['lightning talks', 20], ['no preference', 20]];
const REGISTERED_VIA = [['qr', 60], ['github', 40]];

// Arrivals per 15-minute bucket, 08:00 to 11:30 local.
const ARRIVAL_WEIGHTS = [8, 10, 12, 14, 18, 20, 18, 14, 10, 8, 6, 4, 3, 2];
const ARRIVAL_FLOOR = 5; // every bucket keeps at least 5 arrivals, so none is suppressed

// Interest tags. A talk matches an interest when its tags or title match.
const TAG_RULES = {
  'kubernetes': (t) => t.tags.includes('kubernetes'),
  'observability': (t) => t.tags.includes('observability'),
  'search': (t) => /search|index|query|retriev|vector/i.test(t.title),
  'ai sre': (t) => t.tags.includes('ai') || /agent|\bsre\b/i.test(t.title),
  'code review': (t) => /review|pull request|merge/i.test(t.title),
  'security': (t) => t.tags.includes('security') || t.tags.includes('policy'),
  'platform engineering': (t) => t.tags.includes('platform-engineering'),
  'opentelemetry': (t) => t.tags.includes('opentelemetry'),
  'ebpf': (t) => t.tags.includes('ebpf'),
  'gitops': (t) => t.tags.includes('gitops'),
  'cost': (t) => /cost|power|efficien|footprint/i.test(t.title),
  'databases': (t) => t.tags.includes('databases') || t.tags.includes('storage'),
  'service mesh': (t) => ['service-mesh', 'networking', 'envoy', 'linkerd', 'istio'].some((g) => t.tags.includes(g)),
  'ml infrastructure': (t) =>
    ['inference', 'gpu', 'kserve', 'ai-inference-agentic', 'kai-scheduler', 'llm-d', 'cohdi'].some((g) => t.tags.includes(g)),
  'developer experience': (t) => t.tags.includes('developer-experience') || t.tags.includes('ci-cd'),
  'incident response': (t) => /incident|on-call|resilien|chaos|reliab/i.test(t.title) || t.tags.includes('operational-resilience'),
  'wasm': (t) => t.tags.includes('wasm'),
  'supply chain': (t) => t.tags.includes('supply-chain') || t.tags.includes('in-toto'),
};
const INTEREST_POOL = Object.keys(TAG_RULES); // 18 tags
const SHARED_POOL = INTEREST_POOL.filter((t) => t !== 'wasm' && t !== 'cost');

// Interest clusters. wasm and cost are kept out of everyone else's noise,
// so those two groups stay exactly 4 and 3.
const CLUSTERS = [
  { id: 'platform', label: 'Platform & GitOps', size: 52, core: ['kubernetes', 'platform engineering', 'gitops'] },
  { id: 'observability', label: 'Observability & Incident Response', size: 44, core: ['observability', 'opentelemetry', 'incident response'] },
  { id: 'ai-ops', label: 'AI Ops', size: 36, core: ['ai sre', 'ml infrastructure'] },
  { id: 'security', label: 'Security & Supply Chain', size: 27, core: ['security', 'supply chain', 'ebpf'] },
  { id: 'search-data', label: 'Search & Data', size: 18, core: ['search', 'databases'] },
  { id: 'wasm', label: 'WebAssembly', size: 4, core: ['wasm'] },
  { id: 'cost', label: 'Cost', size: 3, core: ['cost'] },
];

// The demo venue's programme spaces. The lounge takes drop-ins only.
const SCENE_ROOMS = [
  { id: 'keynote', label: 'Keynote Stage', capacity: 120 },
  { id: 'room-a', label: 'Room A', capacity: 40 },
  { id: 'room-b', label: 'Room B', capacity: 40 },
  { id: 'room-c', label: 'Room C', capacity: 40 },
  { id: 'room-d', label: 'Room D', capacity: 40 },
  { id: 'lounge', label: 'Lounge', capacity: 30 },
];
const CAPACITY = Object.fromEntries(SCENE_ROOMS.map((r) => [r.id, r.capacity]));
const LABEL = Object.fromEntries(SCENE_ROOMS.map((r) => [r.id, r.label]));
const SESSION_ROOMS = ['keynote', 'room-a', 'room-b', 'room-c', 'room-d'];
const SCENE_IDS = SCENE_ROOMS.map((r) => r.id);

// Topic groups for the room sessions (room-a to room-d).
const GROUPS = {
  'room-a': ['kubernetes', 'platform engineering', 'gitops', 'developer experience'],
  'room-b': ['observability', 'opentelemetry', 'incident response', 'security', 'ebpf', 'supply chain'],
  'room-c': ['ai sre', 'ml infrastructure'],
  'room-d': ['search', 'databases', 'code review'],
};

// ---------------------------------------------------------------------------
// Programme: 7 slots x 5 sessions, all real talks from the whole catalogue
// ---------------------------------------------------------------------------
function buildProgramme(catalogue) {
  const talks = catalogue.map((t) => ({ id: t.id, title: t.title, track: t.track, catalogueRoom: t.room, tags: t.tags }));
  const used = new Set();

  // Keynote: the broadest talk for each slot, preferring the Keynote Sessions track.
  const breadth = (t) => INTEREST_POOL.filter((i) => TAG_RULES[i](t)).length + (t.track === 'Keynote Sessions' ? 3 : 0);
  const keynote = [...talks]
    .sort((a, b) => breadth(b) - breadth(a) || a.id.localeCompare(b.id))
    .slice(0, SLOT_HOURS.length);
  keynote.forEach((t) => used.add(t.id));

  // Room sessions: each room takes the talks that best match its topic group.
  const roomPicks = {};
  for (const [room, rules] of Object.entries(GROUPS)) {
    const score = (t) => rules.filter((r) => TAG_RULES[r](t)).length;
    const pool = talks
      .filter((t) => !used.has(t.id) && score(t) > 0)
      .sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
      .slice(0, SLOT_HOURS.length);
    if (pool.length < SLOT_HOURS.length) throw new Error(`not enough talks for ${room}`);
    pool.forEach((t) => used.add(t.id));
    roomPicks[room] = pool;
  }

  return SLOT_HOURS.map((_, s) => {
    const start = slotStartSec(s);
    const cells = SESSION_ROOMS.map((room) => {
      const t = room === 'keynote' ? keynote[s] : roomPicks[room][s];
      return {
        talkId: t.id,
        title: t.title,
        tags: t.tags,
        catalogueRoom: t.catalogueRoom,
        room: LABEL[room],
        sceneRoom: room,
        start: fmtLocal(start),
        end: fmtLocal(start + SLOT_LEN_SEC),
      };
    });
    return cells;
  });
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------
function expandArrivalBuckets(total) {
  const n = ARRIVAL_WEIGHTS.length;
  const spare = total - n * ARRIVAL_FLOOR;
  const wsum = sum(ARRIVAL_WEIGHTS);
  const exact = ARRIVAL_WEIGHTS.map((w) => (spare * w) / wsum);
  const counts = exact.map((x) => ARRIVAL_FLOOR + Math.floor(x));
  const left = total - sum(counts);
  const order = exact
    .map((x, i) => [x - Math.floor(x), i])
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; k < left; k++) counts[order[k][1]]++;
  const list = [];
  counts.forEach((c, b) => {
    for (let k = 0; k < c; k++) list.push(b);
  });
  return list;
}

function makeInterests(rng, cluster) {
  const core =
    cluster.core.length === 1 ? [...cluster.core] : sampleN(rng, cluster.core, randInt(rng, 2, cluster.core.length));
  const want = randInt(rng, 3, 6);
  const extras = sampleN(rng, SHARED_POOL.filter((t) => !core.includes(t)), Math.max(0, want - core.length));
  return shuffle(rng, [...core, ...extras]);
}

function makeGoals(rng) {
  const first = weighted(rng, GOALS);
  if (rng() < 0.4) {
    return [first, weighted(rng, GOALS.filter(([g]) => g !== first))];
  }
  return [first];
}

function cellWeight(cell, slot, interests) {
  if (cell.sceneRoom === 'keynote') return SLOT_DRAW[slot].keynote;
  const draw = SLOT_DRAW[slot].rooms[SESSION_ROOMS.indexOf(cell.sceneRoom) - 1];
  const matches = interests.filter((tag) => TAG_RULES[tag](cell)).length;
  return draw * (1 + TOPIC_W * matches);
}

// Denial and capacity. A scan is refused 'room full' when its session already has
// capacity allowed scans (first come, first served). A fixed number of other
// denials (token expired, not on schedule) are added so that the total is about 4%.
function applyDenials(records, rng) {
  const target = Math.round(records.length * DENIED_RATE);
  const order = shuffle(rng, records.map((_, i) => i));
  const byTime = records.map((_, i) => i).sort((a, b) => records[a].atSec - records[b].atSec || a - b);

  const roomFullSet = (randomSet) => {
    const full = new Set();
    const counts = new Map();
    for (const i of byTime) {
      if (randomSet.has(i)) continue;
      const r = records[i];
      const key = `${r.sceneRoom}|${r.slot}`;
      const n = counts.get(key) || 0;
      if (n >= CAPACITY[r.sceneRoom]) full.add(i);
      else counts.set(key, n + 1);
    }
    return full;
  };

  let m = 0;
  let full = roomFullSet(new Set());
  while (m + full.size < target && m < records.length) {
    m++;
    full = roomFullSet(new Set(order.slice(0, m)));
  }
  for (const i of order.slice(0, m)) {
    records[i].denied = true;
    records[i].reason = weighted(rng, [['token expired', 60], ['not on schedule', 40]]);
  }
  for (const i of full) {
    records[i].denied = true;
    records[i].reason = 'room full';
  }
}

function generate(catalogue, conferences) {
  const rng = mulberry32(SEED);
  const programme = buildProgramme(catalogue);
  const otherConferences = conferences
    .map((c) => c.slug)
    .filter((s) => s !== CONFERENCE)
    .sort();

  const slots = [];
  for (const c of CLUSTERS) for (let i = 0; i < c.size; i++) slots.push(c);
  const clusterOrder = shuffle(rng, slots);
  const arrivals = shuffle(rng, expandArrivalBuckets(N_ATTENDEES));

  const usedNames = new Set();
  const people = [];
  const records = []; // one per attended session, plus lounge drop-ins

  clusterOrder.forEach((cluster, i) => {
    let name;
    do {
      name = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    } while (usedNames.has(name));
    usedNames.add(name);

    const interests = makeInterests(rng, cluster);
    const goal = makeGoals(rng);
    const formats = weighted(rng, FORMATS);
    const role = weighted(rng, ROLES);
    const returning = rng() < 0.3;
    const previousConference = returning ? pick(rng, otherConferences) : undefined;
    const registeredVia = weighted(rng, REGISTERED_VIA);
    const regSec = 8 * 3600 + arrivals[i] * 900 + randInt(rng, 0, 899);

    // Slots that start after registration. One session per slot, so no overlaps.
    const candidateSlots = SLOT_HOURS.map((_, s) => s).filter((s) => slotStartSec(s) > regSec);
    const n = Math.min(randInt(rng, 4, 6), candidateSlots.length);
    const chosen = sampleN(rng, candidateSlots, n).sort((a, b) => a - b);

    const schedule = [];
    for (const s of chosen) {
      const cells = programme[s];
      const cell = weighted(rng, cells.map((c) => [c, cellWeight(c, s, interests)]));
      schedule.push({
        talkId: cell.talkId,
        title: cell.title,
        room: cell.room,
        sceneRoom: cell.sceneRoom,
        catalogueRoom: cell.catalogueRoom,
        start: cell.start,
        end: cell.end,
      });
      if (rng() < SCAN_RATE) {
        records.push({
          ai: i,
          slot: s,
          sceneRoom: cell.sceneRoom,
          room: cell.room,
          atSec: slotStartSec(s) + randInt(rng, 0, TALK_SCAN_WINDOW_SEC),
          denied: false,
          reason: undefined,
        });
      }
    }
    for (const s of candidateSlots) {
      if (chosen.includes(s)) continue;
      if (rng() < LOUNGE_P) {
        records.push({
          ai: i,
          slot: s,
          sceneRoom: 'lounge',
          room: LABEL.lounge,
          atSec: slotStartSec(s) + randInt(rng, 0, LOUNGE_WINDOW_SEC),
          denied: false,
          reason: undefined,
        });
      }
    }

    const person = { id: `a${String(i + 1).padStart(3, '0')}`, name, role, interests, goal, formats, cluster: cluster.id, returning };
    if (returning) person.previousConference = previousConference;
    person.registeredVia = registeredVia;
    person.registeredAt = fmtLocal(regSec);
    person.schedule = schedule;
    person.scans = [];
    people.push(person);
  });

  applyDenials(records, rng);
  for (const r of records) {
    const scan = { at: fmtLocal(r.atSec), room: r.room, sceneRoom: r.sceneRoom, decision: r.denied ? 'denied' : 'allowed' };
    if (r.denied) scan.reason = r.reason;
    people[r.ai].scans.push(scan);
  }
  for (const p of people) p.scans.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const sessions = programme.flat().map((c) => ({
    talkId: c.talkId,
    title: c.title,
    catalogueRoom: c.catalogueRoom,
    room: c.room,
    sceneRoom: c.sceneRoom,
    start: c.start,
    end: c.end,
  }));

  return { attendees: people, sessions, aggregates: aggregate(people) };
}

// ---------------------------------------------------------------------------
// Aggregates (what an organiser may see): counts only, no attendee ids or names
// ---------------------------------------------------------------------------
function topTags(members, k) {
  const counts = new Map();
  for (const m of members) for (const t of m.interests) counts.set(t, (counts.get(t) || 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map(([t]) => t);
}

function foldRows(counter, keyName) {
  const entries = [...counter];
  const rows = entries
    .filter(([, c]) => c >= MIN_GROUP)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ [keyName]: key, count }));
  const folded = entries.filter(([, c]) => c < MIN_GROUP).reduce((s, [, c]) => s + c, 0);
  if (folded > 0) rows.push({ [keyName]: 'other', count: folded });
  return rows;
}

function aggregate(attendees) {
  const byCluster = new Map();
  for (const a of attendees) {
    if (!byCluster.has(a.cluster)) byCluster.set(a.cluster, []);
    byCluster.get(a.cluster).push(a);
  }
  const clusters = [];
  let otherCount = 0;
  let suppressedGroups = 0;
  for (const c of CLUSTERS) {
    const members = byCluster.get(c.id) || [];
    if (members.length >= MIN_GROUP) {
      clusters.push({ id: c.id, label: c.label, count: members.length, topTags: topTags(members, 3) });
    } else {
      otherCount += members.length;
      suppressedGroups++;
    }
  }
  clusters.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  clusters.push({ id: 'other', label: 'Other (groups under 5)', count: otherCount });

  const tagCounter = new Map();
  for (const a of attendees) for (const t of a.interests) tagCounter.set(t, (tagCounter.get(t) || 0) + 1);
  const topicCounts = foldRows(tagCounter, 'tag');

  const roomOccupancy = [];
  SLOT_HOURS.forEach((h) => {
    for (const room of SCENE_IDS) {
      const expected = attendees.reduce(
        (n, a) => n + a.schedule.filter((e) => e.sceneRoom === room && hourOf(e.start) === h).length,
        0,
      );
      const scannedIn = attendees.reduce(
        (n, a) =>
          n + a.scans.filter((s) => s.decision === 'allowed' && s.sceneRoom === room && hourOf(s.at) === h).length,
        0,
      );
      roomOccupancy.push({ slot: `${p2(h)}:00`, sceneRoom: room, expected, scannedIn, capacity: CAPACITY[room] });
    }
  });

  const allScans = attendees.flatMap((a) => a.scans);
  const byReason = { 'room full': 0, 'token expired': 0, 'not on schedule': 0 };
  for (const s of allScans) if (s.decision === 'denied') byReason[s.reason]++;
  const scanTotals = {
    allowed: allScans.filter((s) => s.decision === 'allowed').length,
    denied: allScans.filter((s) => s.decision === 'denied').length,
    byReason,
  };

  const byVia = { qr: 0, github: 0 };
  for (const a of attendees) byVia[a.registeredVia]++;
  const arrivalsPer15Min = ARRIVAL_WEIGHTS.map((_, b) => {
    const from = 8 * 60 + b * 15;
    const to = from + 15;
    const count = attendees.filter((a) => {
      const m = Number(a.registeredAt.slice(11, 13)) * 60 + Number(a.registeredAt.slice(14, 16));
      return m >= from && m < to;
    }).length;
    return { from: `${p2(Math.floor(from / 60))}:${p2(from % 60)}`, to: `${p2(Math.floor(to / 60))}:${p2(to % 60)}`, count };
  });
  const registrations = {
    total: attendees.length,
    byVia,
    returning: attendees.filter((a) => a.returning).length,
    arrivalsPer15Min,
  };

  const goalCounter = new Map();
  for (const a of attendees) for (const g of a.goal) goalCounter.set(g, (goalCounter.get(g) || 0) + 1);
  const goalCounts = Object.fromEntries(GOALS.map(([g]) => [g, goalCounter.get(g) || 0]));

  const roleCounter = new Map();
  for (const a of attendees) roleCounter.set(a.role, (roleCounter.get(a.role) || 0) + 1);
  const roleCounts = foldRows(roleCounter, 'role');

  return {
    synthetic: true,
    programmeNote: PROGRAMME_NOTE,
    conference: CONFERENCE,
    attendeeCount: attendees.length,
    clusters,
    suppressedGroups,
    topicCounts,
    roomOccupancy,
    scanTotals,
    registrations,
    goalCounts,
    roleCounts,
  };
}

// ---------------------------------------------------------------------------
// Self-checks
// ---------------------------------------------------------------------------
function hasKey(obj, key) {
  if (Array.isArray(obj)) return obj.some((o) => hasKey(o, key));
  if (obj && typeof obj === 'object') {
    return Object.entries(obj).some(([k, v]) => k === key || hasKey(v, key));
  }
  return false;
}

function selfCheck(gen, again, catalogue, conferences) {
  const out = [];
  const add = (name, ok, detail = '') => out.push({ name, ok: Boolean(ok), detail });
  const { attendees, sessions, aggregates } = gen;
  const talkIds = new Set(catalogue.map((t) => t.id));
  const localRe = /^2026-11-09T\d\d:\d\d:\d\d-07:00$/;
  const occ = aggregates.roomOccupancy;
  const cell = (room, hour) => occ.find((c) => c.sceneRoom === room && c.slot === `${p2(hour)}:00`);
  const scans = attendees.flatMap((a) => a.scans);

  add('184 attendees', attendees.length === N_ATTENDEES, `got ${attendees.length}`);
  add('unique ids', new Set(attendees.map((a) => a.id)).size === attendees.length);
  add('unique full names', new Set(attendees.map((a) => a.name)).size === attendees.length);

  const badInterests = attendees.filter(
    (a) =>
      a.interests.length < 3 ||
      a.interests.length > 6 ||
      new Set(a.interests).size !== a.interests.length ||
      a.interests.some((t) => !(t in TAG_RULES)),
  );
  add('every attendee has 3-6 distinct interests from the pool', badInterests.length === 0, `${badInterests.length} failing`);

  const badSchedule = attendees.filter((a) => a.schedule.length < 4 || a.schedule.length > 6);
  add('every attendee has 4-6 schedule entries', badSchedule.length === 0, `${badSchedule.length} failing`);

  const overlapping = attendees.filter((a) => {
    const s = [...a.schedule].sort((x, y) => (x.start < y.start ? -1 : 1));
    return s.some((e, idx) => idx > 0 && e.start < s[idx - 1].end);
  });
  add('no overlapping schedule times', overlapping.length === 0, `${overlapping.length} failing`);

  const programmeIds = new Set(sessions.map((s) => s.talkId));
  const offProgramme = attendees.flatMap((a) => a.schedule).filter((e) => !programmeIds.has(e.talkId));
  add('every schedule entry is a programme session', offProgramme.length === 0, `${offProgramme.length} off-programme`);

  const missingTalk = [...sessions.map((s) => s.talkId)].filter((id) => !talkIds.has(id));
  add('every programme talkId exists in the catalogue', missingTalk.length === 0, `${missingTalk.length} missing`);

  const talkById = new Map(catalogue.map((t) => [t.id, t]));
  const entries = attendees.flatMap((a) => a.schedule.map((e) => ({ a, e })));
  const matchedEntries = entries.filter(({ a, e }) => {
    const t = talkById.get(e.talkId);
    return t && a.interests.some((tag) => TAG_RULES[tag](t));
  }).length;
  const matchRate = (room) => {
    const es = entries.filter(({ e }) => e.sceneRoom === room);
    const m = es.filter(({ a, e }) => {
      const t = talkById.get(e.talkId);
      return t && a.interests.some((tag) => TAG_RULES[tag](t));
    }).length;
    return `${((m / es.length) * 100).toFixed(0)}%`;
  };
  // Keynote is the broad session that fills near capacity, so it is not interest-filtered.
  // The check applies to the topic-grouped room sessions.
  const roomEntries = entries.filter(({ e }) => e.sceneRoom !== 'keynote');
  const roomMatched = roomEntries.filter(({ a, e }) => {
    const t = talkById.get(e.talkId);
    return t && a.interests.some((tag) => TAG_RULES[tag](t));
  }).length;
  add(
    'at least 90% of room-a..d entries match one of the attendee interests',
    roomMatched / roomEntries.length >= 0.9,
    `${((roomMatched / roomEntries.length) * 100).toFixed(1)}% of ${roomEntries.length}; keynote ${matchRate('keynote')} (broad by design); all ${SESSION_ROOMS.map((r) => `${r} ${matchRate(r)}`).join(', ')}`,
  );

  const distinctSessionTalks = new Set(sessions.map((s) => s.talkId)).size;
  add(
    'programme: 7 slots x 5 rooms, 35 distinct talks',
    sessions.length === SLOT_HOURS.length * SESSION_ROOMS.length && distinctSessionTalks === sessions.length,
    `${sessions.length} sessions, ${distinctSessionTalks} distinct talks`,
  );
  add('lounge has no scheduled sessions', sessions.every((s) => s.sceneRoom !== 'lounge'));

  const badTimes = attendees.filter(
    (a) =>
      !localRe.test(a.registeredAt) ||
      a.registeredAt < '2026-11-09T08:00:00' ||
      a.registeredAt >= '2026-11-09T11:30:00',
  );
  add('registrations between 08:00 and 11:30 local on 9 Nov', badTimes.length === 0, `${badTimes.length} failing`);

  const clusterCount = (id) => attendees.filter((a) => a.cluster === id).length;
  const sizesOk = CLUSTERS.every((c) => clusterCount(c.id) === c.size);
  add('cluster sizes match the spec and sum to 184', sizesOk && sum(CLUSTERS.map((c) => c.size)) === 184);
  add('wasm group is exactly 4', clusterCount('wasm') === 4, `got ${clusterCount('wasm')}`);
  add('cost group is exactly 3', clusterCount('cost') === 3, `got ${clusterCount('cost')}`);

  const confTopics = (conferences.find((c) => c.slug === CONFERENCE) || {}).topics || [];
  add(
    'conference topics are all in the interest pool',
    confTopics.length > 0 && confTopics.every((t) => INTEREST_POOL.includes(t)),
    confTopics.join(', '),
  );

  // Room loads
  for (const room of SCENE_IDS.filter((r) => r !== 'lounge')) {
    const total = occ.filter((c) => c.sceneRoom === room).reduce((n, c) => n + c.scannedIn, 0);
    add(`${LABEL[room]} has scans`, total > 0, `${total} allowed`);
  }
  add('scannedIn never exceeds capacity in any room/slot', occ.every((c) => c.scannedIn <= c.capacity));
  add(
    'keynote near capacity (>= 75%) in at least 4 slots',
    SLOT_HOURS.filter((h) => cell('keynote', h).expected >= 0.75 * CAPACITY.keynote).length >= 4,
    SLOT_HOURS.map((h) => cell('keynote', h).expected).join(' '),
  );
  const overRooms = occ.filter((c) => c.sceneRoom !== 'keynote' && c.sceneRoom !== 'lounge' && c.expected > c.capacity);
  add('at least two room/slot cells over capacity in expected', overRooms.length >= 2, `${overRooms.length} cells`);
  add(
    'each slot has at least one quiet room (expected <= 10)',
    SLOT_HOURS.every((h) => ['room-a', 'room-b', 'room-c', 'room-d'].some((r) => cell(r, h).expected <= 10)),
  );

  const denied = scans.filter((s) => s.decision === 'denied');
  const deniedShare = denied.length / scans.length;
  add('denied scans are 2-6% of all scans', deniedShare >= 0.02 && deniedShare <= 0.06, `${(deniedShare * 100).toFixed(2)}% of ${scans.length}`);
  add('at least one room full denial', denied.some((s) => s.reason === 'room full'));
  add(
    'all three denial reasons present',
    ['room full', 'token expired', 'not on schedule'].every((r) => denied.some((s) => s.reason === r)),
  );

  // Clusters favour different rooms
  const favourite = CLUSTERS.filter((c) => clusterCount(c.id) >= MIN_GROUP).map((c) => {
    const counts = {};
    for (const a of attendees.filter((x) => x.cluster === c.id)) {
      for (const e of a.schedule) if (e.sceneRoom !== 'keynote') counts[e.sceneRoom] = (counts[e.sceneRoom] || 0) + 1;
    }
    return Object.entries(counts).sort((x, y) => y[1] - x[1])[0][0];
  });
  add(
    'big clusters favour at least 3 different room-a..d sessions',
    new Set(favourite).size >= 3,
    favourite.join(', '),
  );

  const aggText = JSON.stringify(aggregates);
  add('aggregates have no key named "name" or "id" at attendee level', !hasKey(aggregates, 'name') && !attendees.some((a) => aggText.includes(`"${a.id}"`)));
  add('aggregates contain no attendee id or name', !attendees.some((a) => aggText.includes(`"${a.name}"`) || aggText.includes(`"${a.id}"`)));

  const small = (rows, key) => rows.filter((r) => r[key] !== 'other' && r.count < MIN_GROUP);
  add('cluster rows (except other) have count >= 5', small(aggregates.clusters, 'id').length === 0);
  add('topic rows (except other) have count >= 5', small(aggregates.topicCounts, 'tag').length === 0);
  add('role rows (except other) have count >= 5', small(aggregates.roleCounts, 'role').length === 0);
  add('goal counts all >= 5', Object.values(aggregates.goalCounts).every((c) => c >= MIN_GROUP));
  add('arrival buckets sum to 184', sum(aggregates.registrations.arrivalsPer15Min.map((b) => b.count)) === N_ATTENDEES);
  add(
    'scan totals reconcile with per-attendee scans',
    aggregates.scanTotals.allowed + aggregates.scanTotals.denied === scans.length &&
      sum(Object.values(aggregates.scanTotals.byReason)) === aggregates.scanTotals.denied,
  );

  add('second in-memory generation equals the first', JSON.stringify(again) === JSON.stringify(gen));
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const catalogue = JSON.parse(readFileSync(TALKS_PATH, 'utf8'));
  const conferences = JSON.parse(readFileSync(CONFERENCES_PATH, 'utf8'));

  const gen = generate(catalogue, conferences);
  const again = generate(catalogue, conferences);
  const checks = selfCheck(gen, again, catalogue, conferences);

  console.log('expected / scannedIn per slot (rows) and room (columns), capacity in brackets:');
  console.log(`  slot   ${SCENE_IDS.map((r) => LABEL[r].padEnd(16)).join('')}`);
  for (const h of SLOT_HOURS) {
    const cells = SCENE_IDS.map((r) => {
      const c = gen.aggregates.roomOccupancy.find((x) => x.sceneRoom === r && x.slot === `${p2(h)}:00`);
      return `${c.expected}/${c.scannedIn} [${c.capacity}]`.padEnd(16);
    });
    console.log(`  ${p2(h)}:00  ${cells.join('')}`);
  }

  console.log('sessions by cluster (rows) and room (columns):');
  for (const c of CLUSTERS) {
    const row = SESSION_ROOMS.map((r) => gen.attendees.filter((a) => a.cluster === c.id).reduce((n, a) => n + a.schedule.filter((e) => e.sceneRoom === r).length, 0));
    console.log(`  ${c.id.padEnd(14)} ${row.map((x) => String(x).padStart(6)).join('')}`);
  }

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  if (failed.length > 0) {
    console.error(`SELF-CHECK FAILED: ${failed.length} of ${checks.length} checks failed. No files written.`);
    process.exit(1);
  }

  const attendeesDoc = {
    synthetic: true,
    note: NOTE,
    programmeNote: PROGRAMME_NOTE,
    seed: SEED,
    generatedAt: new Date().toISOString(),
    conference: CONFERENCE,
    rooms: SCENE_ROOMS,
    programme: gen.sessions,
    attendees: gen.attendees,
  };
  writeFileSync(ATTENDEES_OUT, JSON.stringify(attendeesDoc, null, 2) + '\n');
  writeFileSync(AGGREGATES_OUT, JSON.stringify(gen.aggregates, null, 2) + '\n');

  const parseOk = [ATTENDEES_OUT, AGGREGATES_OUT].every((p) => {
    try {
      JSON.parse(readFileSync(p, 'utf8'));
      return true;
    } catch {
      return false;
    }
  });
  console.log(`${parseOk ? 'PASS' : 'FAIL'}  both output files parse as JSON`);
  if (!parseOk) {
    console.error('SELF-CHECK FAILED: an output file does not parse as JSON.');
    process.exit(1);
  }

  const scans = gen.attendees.flatMap((a) => a.scans);
  const scheduled = gen.attendees.reduce((n, a) => n + a.schedule.length, 0);
  console.log(`All ${checks.length + 1} checks passed.`);
  console.log(`attendees: ${ATTENDEES_OUT} (${statSync(ATTENDEES_OUT).size} bytes)`);
  console.log(`aggregates: ${AGGREGATES_OUT} (${statSync(AGGREGATES_OUT).size} bytes)`);
  console.log(`schedule entries: ${scheduled}; scans: ${scans.length}; denied: ${scans.filter((s) => s.decision === 'denied').length}`);

  console.log('per-room totals (allowed scans / scheduled entries / denied):');
  for (const room of SCENE_IDS) {
    const allowed = scans.filter((s) => s.sceneRoom === room && s.decision === 'allowed').length;
    const sched = gen.attendees.reduce((n, a) => n + a.schedule.filter((e) => e.sceneRoom === room).length, 0);
    const denied = scans.filter((s) => s.sceneRoom === room && s.decision === 'denied').length;
    console.log(`  ${LABEL[room].padEnd(14)} ${String(allowed).padStart(4)} / ${String(sched).padStart(4)} / ${denied}`);
  }
  const reasons = gen.aggregates.scanTotals.byReason;
  console.log(`denied by reason: room full ${reasons['room full']}, token expired ${reasons['token expired']}, not on schedule ${reasons['not on schedule']}`);
  console.log('room/slot cells over capacity (expected):');
  for (const c of gen.aggregates.roomOccupancy.filter((x) => x.expected > x.capacity)) {
    console.log(`  ${c.slot} ${c.sceneRoom}: expected ${c.expected} / cap ${c.capacity}, scannedIn ${c.scannedIn}`);
  }
}

main();
