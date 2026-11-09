import { startTelemetry, shutdownTelemetry } from "../telemetry/sdk.js";

/**
 * `npm run clusters` / the K8s CronJob entrypoint (`node dist/clusters/cli.js`).
 * Like retention-cli.ts: telemetry starts before the app modules load, and is
 * flushed in `finally` so the short-lived process still exports its
 * `clusters.run` span (counts only).
 */
try {
  startTelemetry("companion-clusters");
  // Load application modules only after instrumentation has been registered.
  const { loadConfig } = await import("../config.js");
  const { createEsClient } = await import("../es/client.js");
  const { runClusterJob } = await import("./job.js");
  const r = await runClusterJob(createEsClient(loadConfig()), {
    dims: process.env.EMBEDDING_DIMS ? Number(process.env.EMBEDDING_DIMS) : undefined,
  });
  console.log(
    `clusters.run ${r.runId}: ${r.attendees} opted-in attendees, k=${r.k}, ${r.shown} clusters shown, ${r.suppressed} suppressed, ${r.skipped} skipped (no usable vector)`,
  );
} catch (err) {
  // Elasticsearch error bodies can include source data: print only the error class and a safe type.
  const type = (err as { errorType?: unknown } | null)?.errorType;
  console.error(`Cluster job failed (${typeof type === "string" ? type : err instanceof Error ? err.name : "unknown"})`);
  process.exitCode = 1;
} finally {
  await shutdownTelemetry();
}
