import { createHash } from "node:crypto";
import { open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createTokenService } from "../api/src/auth/token.js";
import { createPgDb, vectorLiteral, type Db } from "../api/src/db/client.js";
import { createEmbedder } from "../api/src/embed/embedder.js";
import { ALL_ROOMS } from "../api/src/routes/register.js";

/** Row shapes of `attendees` / `entitlements` this seed writes (timestamps as ISO strings). */
interface AttendeeDoc {
  id: string;
  display_name: string;
  interests: string[];
  consent_cluster_map: boolean;
  consent_qr_checkin: boolean;
  created_at: string;
  expires_at: string;
}
interface EntitlementDoc {
  attendee_id: string;
  pass_type: string;
  rooms: string[];
  updated_at: string;
  expires_at: string;
}

/** Synthetic demo records always expire after 24 hours, whatever ATTENDEE_RETENTION_HOURS says for real profiles. */
const DEMO_TTL_MS = 24 * 60 * 60 * 1000;

/** Fixed synthetic namespace: reruns cannot accumulate or touch real attendees. Never log IDs. */
const demoId = (label: string) => createHash("sha256").update(`conference-companion:SYNTHETIC-DEMO:v1:${label}`).digest("hex");
export const ALLOWED_DEMO_ID = demoId("allowed");

export function demoFixtures(now: Date) {
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + DEMO_TTL_MS).toISOString();
  return Array.from({ length: 12 }, (_, index) => {
    const label = index === 0 ? "allowed" : index === 1 ? "revoked" : `member-${index + 1}`;
    const id = demoId(label);
    const interests = index < 6 ? ["security", "kubernetes"] : ["observability", "kubernetes"];
    const attendee: AttendeeDoc = {
      id, display_name: `SYNTHETIC DEMO ${label}`, interests,
      consent_cluster_map: true, consent_qr_checkin: true,
      created_at: createdAt, expires_at: expiresAt,
    };
    const entitlement: EntitlementDoc = {
      attendee_id: id, pass_type: "synthetic-demo", rooms: label === "revoked" ? [] : [ALL_ROOMS],
      updated_at: createdAt, expires_at: expiresAt,
    };
    return { attendee, entitlement };
  });
}

export async function seedDemo(db: Db, now: Date, embed: (text: string) => Promise<number[]>) {
  const fixtures = demoFixtures(now);
  // Only two distinct interest sets. Use the configured embedder, as the API does.
  const vectors = new Map<string, number[]>();
  for (const { attendee } of fixtures) {
    const text = attendee.interests.join(", ");
    if (!vectors.has(text)) vectors.set(text, await embed(text));
  }
  for (const { attendee, entitlement } of fixtures) {
    await db.query(
      `insert into attendees (id, display_name, interests, interest_vector, consent_cluster_map, consent_qr_checkin, created_at, expires_at)
       values ($1, $2, $3::text[], $4::vector, $5, $6, $7::timestamptz, $8::timestamptz)
       on conflict (id) do update set display_name = excluded.display_name, interests = excluded.interests,
         interest_vector = excluded.interest_vector, consent_cluster_map = excluded.consent_cluster_map,
         consent_qr_checkin = excluded.consent_qr_checkin, created_at = excluded.created_at, expires_at = excluded.expires_at`,
      [attendee.id, attendee.display_name, attendee.interests, vectorLiteral(vectors.get(attendee.interests.join(", "))!),
        attendee.consent_cluster_map, attendee.consent_qr_checkin, attendee.created_at, attendee.expires_at],
    );
    await db.query(
      `insert into entitlements (attendee_id, pass_type, rooms, updated_at, expires_at)
       values ($1, $2, $3::text[], $4::timestamptz, $5::timestamptz)
       on conflict (attendee_id) do update set pass_type = excluded.pass_type, rooms = excluded.rooms,
         updated_at = excluded.updated_at, expires_at = excluded.expires_at`,
      [entitlement.attendee_id, entitlement.pass_type, entitlement.rooms, entitlement.updated_at, entitlement.expires_at],
    );
  }
  return { attendees: fixtures.length, optedIn: fixtures.length, initiallyRevoked: 1 };
}

/** Change only the one deterministic synthetic demo pass. Never take an arbitrary attendee ID. */
export async function setDemoPass(db: Db, allowed: boolean) {
  const { rows } = await db.query<{ pass_type: string }>(
    "select pass_type from entitlements where attendee_id = $1",
    [ALLOWED_DEMO_ID],
  );
  if (rows[0]?.pass_type !== "synthetic-demo") throw new Error("Synthetic demo pass missing; run the seed first");
  await db.query(
    "update entitlements set rooms = $2::text[], updated_at = $3::timestamptz where attendee_id = $1 and pass_type = 'synthetic-demo'",
    [ALLOWED_DEMO_ID, allowed ? [ALL_ROOMS] : [], new Date().toISOString()],
  );
}

function required(env: NodeJS.ProcessEnv, key: string) {
  if (!env[key]) throw new Error(`Missing ${key}`);
  return env[key]!;
}

/** `deps.db` lets tests run the whole command against an in-process database; the caller then owns closing it. */
export async function main(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, deps: { db?: Db } = {}) {
  const switches = new Set(["--dry-run", "--revoke", "--restore"]);
  const sessionIndex = args.indexOf("--session-file");
  const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
  const remaining = args.filter((_, index) => index !== sessionIndex && index !== sessionIndex + 1);
  // sessionIndex=-1 must not consume args[0].
  const flags = sessionIndex < 0 ? args : remaining;
  if (flags.some((arg) => !switches.has(arg)) || flags.length > 1 || (sessionIndex >= 0 && !sessionFile)) {
    throw new Error("Usage: seed-demo.mts [--dry-run | --revoke | --restore] [--session-file /private/path.json]");
  }
  if (args.includes("--dry-run")) {
    const fixtures = demoFixtures(new Date());
    console.log(`DRY RUN: ${fixtures.length} synthetic attendees, ${fixtures.length} opted in; security=6, observability=6, kubernetes=12; 1 initially revoked pass. No network or files written.`);
    return;
  }
  const databaseUrl = deps.db ? "" : required(env, "DATABASE_URL");
  // Non-local hosts are always reached over verified TLS (api/src/db/client.ts); DATABASE_CA_FILE names the CA.
  // Validate optional token output before writes; secrets belong outside the checkout.
  let signingKey: string | undefined;
  let sessionDestination: string | undefined;
  if (sessionFile) {
    if (!isAbsolute(sessionFile)) throw new Error("Session file must be an absolute path outside the checkout");
    // Resolve the parent too: an outside symlink must not redirect a secret into the repo.
    const path = resolve(await realpath(dirname(sessionFile)), basename(sessionFile));
    const checkout = await realpath(fileURLToPath(new URL("../", import.meta.url)));
    const fromCheckout = relative(checkout, path);
    const outside = fromCheckout === ".." || fromCheckout.startsWith(`..${sep}`) || isAbsolute(fromCheckout);
    if (!isAbsolute(sessionFile) || !outside) {
      throw new Error("Session file must be an absolute path outside the checkout");
    }
    signingKey = required(env, "TOKEN_SIGNING_KEY");
    createTokenService({ key: signingKey, nodeEnv: env.NODE_ENV });
    sessionDestination = path;
  }
  const db = deps.db ?? createPgDb(databaseUrl, { caFile: env.DATABASE_CA_FILE || undefined, max: 1 });
  const signed = sessionDestination && signingKey
    ? await createTokenService({ key: signingKey, nodeEnv: env.NODE_ENV }).sign(ALLOWED_DEMO_ID, { ttlSeconds: 900 })
    : undefined;
  // Reserve exclusively before the first database query: a stale output file must
  // never restore/reseed a pass and then make the overall command report failure.
  const sessionHandle = sessionDestination ? await open(sessionDestination, "wx", 0o600) : undefined;
  let sessionComplete = false;
  try {
    let summary: string;
    if (args.includes("--revoke") || args.includes("--restore")) {
      await setDemoPass(db, args.includes("--restore"));
      summary = args.includes("--restore") ? "Synthetic demo pass restored." : "Synthetic demo pass revoked.";
    } else {
      const embedder = createEmbedder(env);
      const result = await seedDemo(db, new Date(), (text) => embedder.embed(text, "passage"));
      summary = `Seeded ${result.attendees} SYNTHETIC DEMO attendees; ${result.optedIn} opted in; ${result.initiallyRevoked} initially revoked pass. No IDs or tokens printed.`;
    }
    if (sessionHandle && signed) await sessionHandle.writeFile(JSON.stringify(signed));
    sessionComplete = true;
    console.log(summary);
    if (sessionHandle) console.log("Private synthetic session file created (15-minute expiry). Do not commit or record it.");
  } finally {
    await sessionHandle?.close();
    if (!deps.db) await db.close();
    if (sessionDestination && !sessionComplete) await rm(sessionDestination, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Driver errors can include row values (attendee IDs); do not print them.
    console.error("Demo seed failed. Check flags, DATABASE_URL, DATABASE_CA_FILE, embedder readiness, and private session-file path. No error details printed.");
    process.exitCode = 1;
  });
}
