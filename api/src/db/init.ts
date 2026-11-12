import { loadConfig } from "../config.js";
import { createPgDb } from "./client.js";
import { migrate } from "./schema.js";

/** `npm run db:init`: create the extensions, tables and indexes if missing (idempotent). */
async function main() {
  const config = loadConfig();
  const db = createPgDb(config.databaseUrl, { caFile: config.databaseCaFile });
  try {
    await migrate(db);
    console.log("schema is up to date");
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
