import { loadConfig } from "./config.js";
import { migrate } from "./db/schema.js";
import { buildServer } from "./server.js";
import { shutdownTelemetry } from "./telemetry/sdk.js";

const config = loadConfig();
const app = buildServer(config);

try {
  await migrate(app.db);
  // Load the embedding model before taking traffic so the first search is not slow.
  await (app.embedder as { warm?: () => Promise<void> }).warm?.();
  await app.listen({ port: config.port, host: config.host });
  console.log(`api listening on ${config.host}:${config.port}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app
      .close()
      .then(shutdownTelemetry)
      .finally(() => process.exit(0));
  });
}
