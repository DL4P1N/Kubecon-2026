import { loadConfig } from "./config.js";
import { createEsClient } from "./es/client.js";
import { runRetention } from "./retention.js";

try {
  const deleted = await runRetention(createEsClient(loadConfig()));
  console.log(JSON.stringify({ deleted }));
} catch {
  // Elasticsearch error bodies can include source data; never print them.
  console.error("Retention cleanup failed");
  process.exitCode = 1;
}
