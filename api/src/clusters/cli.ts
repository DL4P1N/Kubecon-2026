import type { Db } from "../db/client.js";
import { startTelemetry, shutdownTelemetry } from "../telemetry/sdk.js";

/**
 * `npm run clusters` / the K8s CronJob entrypoint (`node dist/clusters/cli.js`).
 * Like retention-cli.ts: telemetry starts before the app modules load, and is
 * flushed in `finally` so the short-lived process still exports its
 * `clusters.run` span (counts only).
 */
let db: Db | undefined;
try {
  startTelemetry("companion-clusters");
  // Load application modules only after instrumentation has been registered.
  const { loadConfig } = await import("../config.js");
  const { createPgDb } = await import("../db/client.js");
  const { runClusterJob } = await import("./job.js");
  const config = loadConfig();
  db = createPgDb(config.databaseUrl, { caFile: config.databaseCaFile });
  const r = await runClusterJob(db);
  console.log(
    `clusters.run ${r.runId}: ${r.attendees} opted-in attendees, k=${r.k}, ${r.shown} clusters shown, ${r.suppressed} suppressed, ${r.skipped} skipped (no usable vector)`,
  );
} catch (err) {
  // Driver messages can include SQL or row data: print only the error class and the SQLSTATE code.
  const code = (err as { code?: unknown } | null)?.code;
  console.error(`Cluster job failed (${typeof code === "string" ? code : err instanceof Error ? err.name : "unknown"})`);
  process.exitCode = 1;
} finally {
  await db?.close().catch(() => undefined);
  await shutdownTelemetry();
}
