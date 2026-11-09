import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createEsClient, type EsClient } from "../es/client.js";
import { createEmbedder, type Embedder } from "../es/embeddings.js";
import { ensureIndices } from "../es/mappings.js";

/**
 * Demo data for the cluster map: 40 SYNTHETIC attendees who all opted in.
 * They are made-up people (ids `demo-NN`), not real registrations, and expire
 * after 24 hours like every attendee record.
 *
 * Shape on purpose: three themes of 13, 12 and 11 people, plus 4 attendees
 * with off-topic hobbies. Those 4 are below the minimum of 5, so the demo shows
 * suppression too (they never appear on the map).
 */

const THEMES: string[][] = [
  ["kubernetes", "helm", "gitops", "argo-cd", "platform engineering", "cluster operations"],
  ["opentelemetry", "tracing", "prometheus", "slo", "dashboards", "alerting"],
  ["elasticsearch", "vector search", "rag", "embeddings", "llm", "relevance"],
];
const THEME_SIZES = [13, 12, 11];
// Four attendees with off-topic hobbies: too few to form a cluster of their own.
const LONERS: string[][] = [
  ["quantum hobbies", "origami hobbies", "folding"],
  ["quantum hobbies", "bee keeping hobbies", "folding"],
  ["quantum hobbies", "vintage synths hobbies", "folding"],
  ["quantum hobbies", "sourdough hobbies", "folding"],
];

export interface DemoAttendeeSpec {
  id: string;
  interests: string[];
}

/** Deterministic: each member of a theme holds 4 of its 6 interests, rotating by position. */
export function demoSpecs(): DemoAttendeeSpec[] {
  const specs: DemoAttendeeSpec[] = [];
  let n = 1;
  THEMES.forEach((theme, t) => {
    for (let i = 0; i < THEME_SIZES[t]!; i++) {
      const interests = [0, 1, 2, 3].map((j) => theme[(i + j * (1 + (i % 2))) % theme.length]!);
      specs.push({ id: `demo-${String(n++).padStart(2, "0")}`, interests: [...new Set(interests)] });
    }
  });
  for (const interests of LONERS) specs.push({ id: `demo-${String(n++).padStart(2, "0")}`, interests });
  return specs;
}

export async function seedDemoAttendees(es: EsClient, embedder: Pick<Embedder, "embed">, now = new Date()): Promise<number> {
  const specs = demoSpecs();
  const lines: object[] = [];
  for (const s of specs) {
    const vector = await embedder.embed(s.interests.join(", "));
    lines.push(
      { index: { _index: "attendees", _id: s.id } },
      {
        id: s.id,
        display_name: `Demo attendee ${s.id.slice(5)}`,
        interests: s.interests,
        interest_vector: vector,
        consent: { cluster_map: true, qr_checkin: false },
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      },
    );
  }
  const res = await es.bulk(lines);
  if (res.errors) throw new Error("demo attendee bulk write failed");
  await es.request("POST", "/attendees/_refresh");
  return specs.length;
}

/** `npm run clusters:seed`: ensure indices, then index the demo attendees. Run `npm run clusters` afterwards. */
async function main() {
  const es = createEsClient(loadConfig());
  const embedder = createEmbedder(process.env, es);
  await ensureIndices(es, embedder.dims);
  const n = await seedDemoAttendees(es, embedder);
  console.log(`indexed ${n} synthetic opted-in attendees (demo-NN). Now run: npm run clusters`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : "demo seed failed");
    process.exit(1);
  });
}
