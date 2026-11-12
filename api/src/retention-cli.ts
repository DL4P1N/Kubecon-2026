import { startTelemetry, shutdownTelemetry } from "./telemetry/sdk.js";

try {
  startTelemetry("companion-retention");
  // Load application modules only after instrumentation has been registered.
  const { loadConfig } = await import("./config.js");
  const { createPgDb } = await import("./db/client.js");
  const { runRetention } = await import("./retention.js");
  const config = loadConfig();
  const db = createPgDb(config.databaseUrl, { caFile: config.databaseCaFile });
  try {
    const deleted = await runRetention(db);
    console.log(JSON.stringify({ deleted }));
  } finally {
    await db.close();
  }
} catch {
  // Database errors can include row values; never print them.
  console.error("Retention cleanup failed");
  process.exitCode = 1;
} finally {
  await shutdownTelemetry();
}
