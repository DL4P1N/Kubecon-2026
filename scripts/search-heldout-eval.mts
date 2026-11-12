import { EVAL_SET } from "./search-eval-set.js";
import { DEFAULT_TUNING, type SearchTuning } from "../api/src/search/queries.ts";
import { runSearch } from "../api/src/search/service.ts";
import { connect } from "./search-eval.js";

interface Judged {
  q: string;
  relevant: string[];
}

// Held-out questions written after the rules were made generic; none reuses the
// wording of the 12 tuned queries.
const HELD_OUT: Judged[] = [
  { q: "how do we ship a change to only five percent of traffic and watch it", relevant: ["kcna26-1247840", "kcna26-1250982", "kcna26-1250076"] },
  { q: "we lost a namespace and need the data restored", relevant: ["kcna26-1289913"] },
  { q: "our kubernetes spend is growing faster than usage", relevant: ["kcna26-1289666", "kcna26-1243852"] },
  { q: "several teams want to share one gpu node", relevant: ["kcna26-1243199", "kcna26-1250789", "kcna26-1241974"] },
  { q: "alerts wake me up but most are noise", relevant: ["kcna26-1244963", "kcna26-1250770"] },
  { q: "proving the artifact we run was built from our source", relevant: ["kcna26-1370530", "kcna26-1289646", "kcna26-1247300", "kcna26-1334787"] },
  { q: "restricting pod to pod traffic in a shared cluster", relevant: ["kcna26-1247970", "kcna26-1249358", "kcna26-1289674"] },
  { q: "isolating ai generated code so it cannot reach production", relevant: ["kcna26-1247804", "kcna26-1301749", "kcna26-1249842", "kcna26-1247753"] },
];

// Read-only: DATABASE_URL / DATABASE_CA_FILE as for search-eval.ts; queries embedded with the configured embedder (e5 by default).
const { db, embedder } = connect();

async function ids(mode: "keyword" | "hybrid", q: string, tuning: SearchTuning): Promise<string[]> {
  return (await runSearch(db, embedder, { text: q, mode, size: 10, tuning })).hits.map((h) => h.talk.id);
}

const OFF = { ...DEFAULT_TUNING, queryExpansion: "off" as const };
const ON = DEFAULT_TUNING;

async function measure(label: string, set: Judged[]) {
  let kwOff = 0, kwOn = 0, hyOff = 0, hyOn = 0, kwRrOff = 0, kwRrOn = 0, hyRrOff = 0, hyRrOn = 0;
  let wins = 0, ties = 0, losses = 0;
  const rows: string[] = [];
  for (const judged of set) {
    const rankOf = (list: string[]) => list.findIndex((id) => judged.relevant.includes(id));
    const rr = (list: string[]) => (rankOf(list) < 0 ? 0 : 1 / (rankOf(list) + 1));
    const kOff = await ids("keyword", judged.q, OFF);
    const kOn = await ids("keyword", judged.q, ON);
    const hOff = await ids("hybrid", judged.q, OFF);
    const hOn = await ids("hybrid", judged.q, ON);
    kwRrOff += rr(kOff); kwRrOn += rr(kOn); hyRrOff += rr(hOff); hyRrOn += rr(hOn);
    if (kOff.slice(0, 3).some((id) => judged.relevant.includes(id))) kwOff++;
    if (kOn.slice(0, 3).some((id) => judged.relevant.includes(id))) kwOn++;
    if (hOff.slice(0, 3).some((id) => judged.relevant.includes(id))) hyOff++;
    if (hOn.slice(0, 3).some((id) => judged.relevant.includes(id))) hyOn++;
    const a = rr(hOff), b = rr(hOn);
    if (b > a) wins++; else if (b === a) ties++; else losses++;
    rows.push(`| ${judged.q.slice(0, 52)} | ${a.toFixed(3)} | ${b.toFixed(3)} |`);
  }
  const n = set.length;
  console.log(`\n### ${label} (n=${n})`);
  console.log(`keyword  off ${kwOff}/${n} RR ${(kwRrOff / n).toFixed(3)} | on ${kwOn}/${n} RR ${(kwRrOn / n).toFixed(3)}`);
  console.log(`hybrid   off ${hyOff}/${n} RR ${(hyRrOff / n).toFixed(3)} | on ${hyOn}/${n} RR ${(hyRrOn / n).toFixed(3)}`);
  console.log(`hybrid on vs off: ${wins} wins / ${ties} ties / ${losses} losses`);
  console.log(rows.join("\n"));
}

try {
  await ids("hybrid", "warm up", ON);
  await measure("TUNED SET (12 original judged queries)", EVAL_SET);
  await measure("HELD-OUT SET (8 new questions)", HELD_OUT);
} finally {
  await db.close();
}
