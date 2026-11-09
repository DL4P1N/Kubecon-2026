import { startTelemetry, shutdownTelemetry } from "./telemetry/sdk.js";

try {
  startTelemetry("companion-retention");
  // Load application modules only after instrumentation has been registered.
  const { loadConfig } = await import("./config.js");
  const { createEsClient } = await import("./es/client.js");
  const { runRetention } = await import("./retention.js");
  const deleted = await runRetention(createEsClient(loadConfig()));
  console.log(JSON.stringify({ deleted }));
} catch {
  // Elasticsearch error bodies can include source data; never print them.
  console.error("Retention cleanup failed");
  process.exitCode = 1;
} finally {
  await shutdownTelemetry();
}
