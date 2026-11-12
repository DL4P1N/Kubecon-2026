import type { Db } from "../src/db/client.js";
import type { CatalogTalk } from "../src/db/talks.js";
import { insertTalks, testDb } from "./pg.js";

/** `h` hours after 2026-11-10T00:00Z as an ISO string. */
export const at = (h: number) => new Date(Date.UTC(2026, 10, 10, 0, 0) + h * 3600_000).toISOString();

export function mk(id: string, startHour: number, endHour: number, extra: Partial<CatalogTalk> = {}): CatalogTalk {
  return {
    id,
    title: `Talk ${id}`,
    speaker: "Someone",
    abstract: "About things.",
    track: "Security",
    room: "Hall A",
    level: "intermediate",
    start: at(startHour),
    end: at(endHour),
    tags: ["x"],
    ...extra,
  };
}

/** A small realistic catalog. A and B overlap (9-10); E is a Contribfest workshop. */
export const A = mk("a", 9, 10, {
  title: "Supply chain security for container builds",
  abstract: "Sign and verify build artifacts with sigstore and attestations.",
  tags: ["supply-chain", "security"], level: "beginner", track: "Security", room: "Hall A", speaker: "Ada Lovelace",
});
export const B = mk("b", 9, 10, {
  title: "Securing the software supply chain end to end",
  abstract: "Provenance, SBOMs and policy gates for everything you ship.",
  tags: ["supply-chain"], level: "beginner", track: "Security", room: "Hall B", speaker: "Grace Hopper",
});
export const C = mk("c", 11, 12, {
  title: "Scaling Kubernetes clusters with autoscaling",
  abstract: "HPA, KEDA and node autoscalers under bursty traffic.",
  tags: ["kubernetes", "autoscaling"], level: "intermediate", track: "Platform", room: "Hall A", speaker: "Linus Torvalds",
});
export const D = mk("d", 13, 14, {
  title: "Observability with OpenTelemetry",
  abstract: "Traces, metrics and logs from one collector pipeline.",
  tags: ["observability"], level: "advanced", track: "Observability", room: "Hall C", speaker: "Ada Lovelace",
});
export const E = mk("e", 11, 12, {
  title: "Contribfest: fix a Kubernetes bug",
  abstract: "Hands-on workshop with maintainers.",
  tags: ["kubernetes", "contribution"], level: "beginner", track: "Contribfest", room: "Hall B", speaker: "Maintainers",
});
export const CATALOG = [A, B, C, D, E];

/** Fresh PGlite with the production schema and the catalog above (or `talks`). */
export async function seededDb(talks: CatalogTalk[] = CATALOG): Promise<Db> {
  const db = await testDb();
  await insertTalks(db, talks);
  return db;
}

/** Wraps a Db and records every statement text, so tests can assert "no query ran". */
export function recordingDb(db: Db): Db & { statements: string[] } {
  const statements: string[] = [];
  const wrap = (d: Db): Db => ({
    async query(text, params) {
      statements.push(text);
      return d.query(text, params);
    },
    exec: (text) => d.exec(text),
    transaction: (fn) => d.transaction((tx) => fn(wrap(tx))),
    close: () => d.close(),
  });
  return Object.assign(wrap(db), { statements });
}

/** A Db whose every query fails with the given driver-style error. */
export function failingDb(err: { code?: string; message: string }): Db {
  const fail = async () => {
    throw Object.assign(new Error(err.message), { code: err.code });
  };
  return { query: fail, exec: fail, transaction: fail, close: async () => undefined };
}
