/**
 * Offline relevance eval: keyword (full text + trigram) vs hybrid (keyword +
 * pgvector semantic, fused) on the real talks table, running the API's own
 * search service so it measures what the app does. Prints a markdown report
 * (hit@3, MRR@10, per-query top 3). Read-only: it only runs SELECTs.
 *
 * Usage (repo root, against a seeded database; queries are embedded with the
 * same e5 model the API uses, EMBEDDINGS_PROVIDER=local for the offline one):
 *   DATABASE_URL=postgresql://... DATABASE_CA_FILE=supabase-ca.crt \
 *   MODEL_CACHE_DIR=/tmp/cc/hf MODEL_ALLOW_DOWNLOAD=true \
 *   npx tsx scripts/search-eval.ts [--variants baseline,excl] [--out report.md]
 *
 *   npx tsx scripts/search-eval.ts --check   # no database: validate judgments, print the SQL
 *
 * Judgments were hand-picked by reading titles and abstracts in
 * data/talks.json; the `why` line records the reason for each. Queries are
 * paraphrased attendee questions that avoid the catalog's own vocabulary.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createPgDb, vectorLiteral, type Db } from "../api/src/db/client.js";
import { createEmbedder, type Embedder } from "../api/src/embed/embedder.js";
import { DEFAULT_TUNING, buildHybridPlan, expandedText, buildKeywordPlan, type SearchTuning } from "../api/src/search/queries.js";
import { runSearch } from "../api/src/search/service.js";
import { EVAL_SET } from "./search-eval-set.js";

/** Tuning variants measured side by side. `baseline` is exact stemmed matching, no expansion (the pre-#36 behaviour). */
const BASELINE: SearchTuning = {
  excludeTracks: [],
  fusion: "rrf",
  rankConstant: 60,
  rankWindowSize: 50,
  semanticWeight: 1,
  keywordMatch: "any",
};
const EXCL: SearchTuning = { ...BASELINE, excludeTracks: ["Contribfest"] };
export const VARIANTS: Record<string, SearchTuning> = {
  baseline: BASELINE,
  excl: EXCL,
  "excl-k20": { ...EXCL, rankConstant: 20 },
  "excl-w100": { ...EXCL, rankWindowSize: 100 },
  "excl-all-terms": { ...EXCL, keywordMatch: "all" },
  "excl-linear": { ...EXCL, fusion: "linear", semanticWeight: 1 },
  "excl-linear-sem2": { ...EXCL, fusion: "linear", semanticWeight: 2 },
  /** Production tuning before #52: fuzzy matching but no query expansion. */
  "pre-expansion": { ...DEFAULT_TUNING, queryExpansion: "off" },
  current: DEFAULT_TUNING,
};

const SIZE = 10;

interface Hit {
  id: string;
  title: string;
  track: string;
}

/** Reciprocal rank of the first relevant hit within the top `SIZE`, 0 if none. */
export function reciprocalRank(ids: string[], relevant: string[]): number {
  const i = ids.slice(0, SIZE).findIndex((id) => relevant.includes(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

export function hitAt(ids: string[], relevant: string[], k: number): boolean {
  return ids.slice(0, k).some((id) => relevant.includes(id));
}

async function search(db: Db, embedder: Embedder, mode: "keyword" | "hybrid", text: string, tuning: SearchTuning): Promise<Hit[]> {
  const r = await runSearch(db, embedder, { text, mode, size: SIZE, tuning });
  return r.hits.map((h) => ({ id: h.talk.id, title: h.talk.title, track: h.talk.track }));
}

/** Connects to DATABASE_URL (TLS verified; DATABASE_CA_FILE trusts a private CA) and builds the configured embedder. */
export function connect(env: NodeJS.ProcessEnv = process.env): { db: Db; embedder: Embedder } {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return {
    db: createPgDb(env.DATABASE_URL, { caFile: env.DATABASE_CA_FILE || undefined, max: 2 }),
    embedder: createEmbedder(env),
  };
}

const short = (h: Hit, relevant: string[]) =>
  `${relevant.includes(h.id) ? "**[R]** " : ""}${h.title.slice(0, 48).replace(/\|/g, "/")}${h.title.length > 48 ? "…" : ""} (${h.track})`;
const fmt = (n: number) => n.toFixed(3);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function check(): void {
  const talks = JSON.parse(readFileSync(new URL("../data/talks.json", import.meta.url), "utf8")) as {
    id: string;
    title: string;
  }[];
  const byId = new Map(talks.map((t) => [t.id, t]));
  let bad = 0;
  for (const j of EVAL_SET) {
    for (const id of j.relevant) {
      const t = byId.get(id);
      if (!t) bad++;
      console.log(`${t ? "ok " : "MISSING"} ${id} ${t?.title ?? ""}  <- "${j.q}"`);
    }
  }
  for (const [name, t] of Object.entries(VARIANTS)) {
    console.log(`\n## ${name}\nkeyword: ${buildKeywordPlan("q", SIZE, {}, t).hits.text}`);
    console.log(`hybrid: ${buildHybridPlan("q", "[0]", SIZE, {}, t).hits.text}`);
  }
  if (bad > 0) {
    console.error(`${bad} judged id(s) not in data/talks.json`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--check")) return check();
  const names = (arg("--variants") ?? Object.keys(VARIANTS).join(",")).split(",");
  for (const n of names) if (!VARIANTS[n]) throw new Error(`unknown variant ${n}`);
  const { db, embedder } = connect();
  try {
    await evaluate(db, embedder, names);
  } finally {
    await db.close();
  }
}

async function evaluate(db: Db, embedder: Embedder, names: string[]): Promise<void> {
  // Warm-up: the first query loads the e5 model and can be slow.
  await search(db, embedder, "hybrid", "warm up", DEFAULT_TUNING);

  const out: string[] = [];
  const log = (s = "") => {
    out.push(s);
    console.log(s);
  };
  const count = Number((await db.query<{ n: string }>("select count(*) as n from talks")).rows[0]?.n);
  log(`# search-eval: keyword vs hybrid (Postgres)`);
  log();
  log(`Table \`talks\`: ${count} rows, ${embedder.provider} embeddings. ${EVAL_SET.length} queries, size ${SIZE}. Run at ${new Date().toISOString()}.`);
  log(`Win = hybrid reciprocal rank (MRR@10 contribution) > keyword's for that query.`);
  log();

  const summary: string[] = [];
  const details: string[] = [];
  const kwCache = new Map<string, Hit[][]>();
  for (const name of names) {
    const tuning = VARIANTS[name]!;
    // The whole tuning affects the keyword body (track exclusion, fuzziness,
    // query expansion), so variants must not share cached keyword results.
    const kwKey = JSON.stringify(tuning);
    let kwAll = kwCache.get(kwKey);
    if (!kwAll) {
      kwAll = [];
      for (const j of EVAL_SET) kwAll.push(await search(db, embedder, "keyword", j.q, tuning));
      kwCache.set(kwKey, kwAll);
    }
    let kwHit = 0, hyHit = 0, kwMrr = 0, hyMrr = 0, wins = 0, ties = 0, losses = 0;
    details.push(`### Variant \`${name}\``, "");
    details.push(`\`${JSON.stringify(tuning)}\``, "");
    details.push("| # | query | keyword top 3 | hybrid top 3 | kw RR | hy RR |", "|---|---|---|---|---|---|");
    for (const [i, j] of EVAL_SET.entries()) {
      const kw = kwAll[i]!;
      let hy: Hit[];
      try {
        hy = await search(db, embedder, "hybrid", j.q, tuning);
      } catch (e) {
        details.push(`| ${i + 1} | ${j.q} | | ERROR: ${(e as Error).message.slice(0, 160).replace(/\|/g, "/")} | | |`);
        hy = [];
      }
      const kwIds = kw.map((h) => h.id), hyIds = hy.map((h) => h.id);
      const kr = reciprocalRank(kwIds, j.relevant), hr = reciprocalRank(hyIds, j.relevant);
      kwMrr += kr; hyMrr += hr;
      if (hitAt(kwIds, j.relevant, 3)) kwHit++;
      if (hitAt(hyIds, j.relevant, 3)) hyHit++;
      if (hr > kr) wins++; else if (hr === kr) ties++; else losses++;
      const top = (hs: Hit[]) => hs.slice(0, 3).map((h, r) => `${r + 1}. ${short(h, j.relevant)}`).join("<br>");
      details.push(`| ${i + 1} | ${j.q} | ${top(kw)} | ${top(hy)} | ${fmt(kr)} | ${fmt(hr)} |`);
    }
    details.push("");
    const n = EVAL_SET.length;
    summary.push(
      `| \`${name}\` | ${kwHit}/${n} | ${hyHit}/${n} | ${fmt(kwMrr / n)} | ${fmt(hyMrr / n)} | ${wins} / ${ties} / ${losses} |`,
    );
  }
  log("## Summary");
  log();
  log("| variant | keyword hit@3 | hybrid hit@3 | keyword MRR@10 | hybrid MRR@10 | hybrid wins / ties / losses |");
  log("|---|---|---|---|---|---|");
  for (const s of summary) log(s);
  log();
  // Diagnostic: the semantic leg on its own (same query the hybrid leg runs), to
  // see whether fusion or the embedding itself limits hybrid.
  log("## Diagnostic: semantic leg alone");
  log();
  log("| exclusion | semantic hit@3 | semantic MRR@10 | per-query RR |");
  log("|---|---|---|---|");
  for (const tuning of [BASELINE, EXCL]) {
    let hit = 0, mrr = 0;
    const rrs: string[] = [];
    for (const j of EVAL_SET) {
      const qvec = vectorLiteral(await embedder.embed(expandedText(j.q, tuning), "query"));
      const ids = (
        await db.query<{ id: string }>(
          `select id from talks t where embedding is not null${tuning.excludeTracks.length ? " and not (track = any($2::text[]))" : ""} order by embedding <=> $1::vector, id limit ${SIZE}`,
          tuning.excludeTracks.length ? [qvec, [...tuning.excludeTracks]] : [qvec],
        )
      ).rows.map((r) => r.id);
      const rr = reciprocalRank(ids, j.relevant);
      mrr += rr;
      rrs.push(fmt(rr));
      if (hitAt(ids, j.relevant, 3)) hit++;
    }
    log(`| ${JSON.stringify(tuning.excludeTracks)} | ${hit}/${EVAL_SET.length} | ${fmt(mrr / EVAL_SET.length)} | ${rrs.join(" ")} |`);
  }
  log();
  log("## Per query");
  log();
  for (const d of details) log(d);

  const outPath = arg("--out");
  if (outPath) writeFileSync(outPath, out.join("\n") + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
