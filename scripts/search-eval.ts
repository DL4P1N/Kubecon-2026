/**
 * Offline relevance eval: keyword (BM25) vs hybrid (BM25 + semantic, fused) on
 * the real talks index, using the API's own body builders so it measures what
 * the app sends. Prints a markdown report (hit@3, MRR@10, per-query top 3).
 *
 * Usage (repo root, against a seeded index):
 *   ES_URL=https://localhost:9200 ES_USERNAME=... ES_PASSWORD=... \
 *   NODE_EXTRA_CA_CERTS=deploy/compose/certs/ca.crt \
 *   npx tsx scripts/search-eval.ts [--variants baseline,excl] [--out report.md]
 *
 *   npx tsx scripts/search-eval.ts --check   # no ES: validate judgments, print the bodies
 *
 * Judgments were hand-picked by reading titles and abstracts in
 * data/talks.json; the `why` line records the reason for each. Queries are
 * paraphrased attendee questions that avoid the catalog's own vocabulary.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../api/src/config.js";
import { createEsClient, type EsClient } from "../api/src/es/client.js";
import {
  DEFAULT_TUNING,
  TALKS_INDEX,
  buildHybridBody,
  buildKeywordBody,
  type EsBody,
  type SearchTuning,
} from "../api/src/search/queries.js";
import { EVAL_SET } from "./search-eval-set.js";

/** Tuning variants measured side by side. `baseline` is what production sent before #36. */
const BASELINE: SearchTuning = {
  excludeTracks: [],
  fusion: "rrf",
  rankConstant: 60,
  rankWindowSize: 50,
  semanticWeight: 1,
};
const EXCL: SearchTuning = { ...BASELINE, excludeTracks: ["Contribfest"] };
export const VARIANTS: Record<string, SearchTuning> = {
  baseline: BASELINE,
  excl: EXCL,
  "excl-k20": { ...EXCL, rankConstant: 20 },
  "excl-w100": { ...EXCL, rankWindowSize: 100 },
  "excl-msm30": { ...EXCL, hybridKeywordMinimumShouldMatch: "30%" },
  "excl-msm30-k20": { ...EXCL, hybridKeywordMinimumShouldMatch: "30%", rankConstant: 20 },
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

async function search(es: EsClient, body: EsBody): Promise<Hit[]> {
  const res = await es.request<{ hits: { hits: { _id: string; _source?: Record<string, unknown> }[] } }>(
    "POST",
    `/${TALKS_INDEX}/_search`,
    body,
  );
  return res.body.hits.hits.map((h) => ({
    id: String(h._source?.id ?? h._id),
    title: String(h._source?.title ?? ""),
    track: String(h._source?.track ?? ""),
  }));
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
    console.log(`\n## ${name}\nkeyword: ${JSON.stringify(buildKeywordBody("q", SIZE, {}, t))}`);
    console.log(`hybrid: ${JSON.stringify(buildHybridBody("q", SIZE, {}, t))}`);
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
  const es = createEsClient(loadConfig());

  // Warm-up: the first semantic query loads the E5 model allocation and can be slow.
  await search(es, buildHybridBody("warm up", 1));

  const out: string[] = [];
  const log = (s = "") => {
    out.push(s);
    console.log(s);
  };
  const count = await es.request<{ count: number }>("GET", `/${TALKS_INDEX}/_count`);
  log(`# search-eval: keyword vs hybrid`);
  log();
  log(`Index \`${TALKS_INDEX}\`: ${count.body.count} docs. ${EVAL_SET.length} queries, size ${SIZE}. Run at ${new Date().toISOString()}.`);
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
      for (const j of EVAL_SET) kwAll.push(await search(es, buildKeywordBody(j.q, SIZE, {}, tuning)));
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
        hy = await search(es, buildHybridBody(j.q, SIZE, {}, tuning));
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
      const legs = (buildHybridBody(j.q, SIZE, {}, tuning) as { retriever: { rrf: { retrievers: { standard: { query: unknown } }[] } } })
        .retriever.rrf.retrievers;
      const ids = (await search(es, { size: SIZE, _source: ["id", "title", "track"], query: legs[1]!.standard.query })).map((h) => h.id);
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
