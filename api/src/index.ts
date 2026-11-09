import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = buildServer(config);

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`api listening on ${config.host}:${config.port}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}
