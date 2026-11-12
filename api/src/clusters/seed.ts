import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { createPgDb, vectorLiteral, type Db } from "../db/client.js";
import { migrate } from "../db/schema.js";
import { createEmbedder, type Embedder } from "../embed/embedder.js";

/**
 * Demo data for the cluster map: 40 SYNTHETIC attendees who all opted in.
 * They are made-up people (ids `demo-NN`), not real registrations, and always
 * expire after 24 hours, even though real profiles are kept by default (synthetic data is never kept).
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

export async function seedDemoAttendees(db: Db, embedder: Pick<Embedder, "embed">, now = new Date()): Promise<number> {
  const specs = demoSpecs();
  const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  for (const s of specs) {
    const vector = await embedder.embed(s.interests.join(", "), "passage");
    await db.query(
      `insert into attendees (id, display_name, interests, interest_vector, consent_cluster_map, consent_qr_checkin, created_at, expires_at)
       values ($1, $2, $3, $4::vector, true, true, $5, $6)
       on conflict (id) do update set display_name = excluded.display_name, interests = excluded.interests,
         interest_vector = excluded.interest_vector, consent_cluster_map = true, consent_qr_checkin = true,
         created_at = excluded.created_at, expires_at = excluded.expires_at`,
      [s.id, `Demo attendee ${s.id.slice(5)}`, s.interests, vectorLiteral(vector), now.toISOString(), expires],
    );
  }
  return specs.length;
}

/** `npm run clusters:seed`: ensure the schema, then insert the demo attendees. Run `npm run clusters` afterwards. */
async function main() {
  const config = loadConfig();
  const db = createPgDb(config.databaseUrl, { caFile: config.databaseCaFile });
  try {
    await migrate(db);
    const n = await seedDemoAttendees(db, createEmbedder());
    console.log(`inserted ${n} synthetic opted-in attendees (demo-NN). Now run: npm run clusters`);
  } finally {
    await db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : "demo seed failed");
    process.exit(1);
  });
}
