import { createHash } from "node:crypto";
import { open, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createTokenService } from "../api/src/auth/token.js";
import { createEsClient, type EsClient } from "../api/src/es/client.js";
import { createEmbedder } from "../api/src/es/embeddings.js";
import { ALL_ROOMS, type AttendeeDoc, type EntitlementDoc } from "../api/src/routes/register.js";

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
      consent: { cluster_map: true, qr_checkin: true },
      created_at: createdAt, expires_at: expiresAt,
    };
    const entitlement: EntitlementDoc = {
      attendee_id: id, pass_type: "synthetic-demo", rooms: label === "revoked" ? [] : [ALL_ROOMS],
      updated_at: createdAt, expires_at: expiresAt,
    };
    return { attendee, entitlement };
  });
}

export async function seedDemo(es: EsClient, now: Date, embed: (text: string) => Promise<number[]>) {
  const fixtures = demoFixtures(now);
  // Only two distinct interest sets. Use the configured inference endpoint, as the API does.
  const vectors = new Map<string, number[]>();
  for (const { attendee } of fixtures) {
    const text = attendee.interests.join(", ");
    if (!vectors.has(text)) vectors.set(text, await embed(text));
  }
  for (const { attendee, entitlement } of fixtures) {
    await es.request("PUT", `/attendees/_doc/${attendee.id}?refresh=wait_for`, {
      ...attendee, interest_vector: vectors.get(attendee.interests.join(", "))!,
    });
    await es.request("PUT", `/entitlements/_doc/${attendee.id}?refresh=wait_for`, entitlement);
  }
  return { attendees: fixtures.length, optedIn: fixtures.length, initiallyRevoked: 1 };
}

/** Change only the one deterministic synthetic demo pass. Never take an arbitrary attendee ID. */
export async function setDemoPass(es: EsClient, allowed: boolean) {
  const path = `/entitlements/_doc/${ALLOWED_DEMO_ID}`;
  const current = await es.request<{ found?: boolean; _source?: EntitlementDoc }>("GET", path, undefined, [404]);
  const doc = current.body?._source;
  if (!current.body?.found || !doc || doc.pass_type !== "synthetic-demo" || doc.attendee_id !== ALLOWED_DEMO_ID) {
    throw new Error("Synthetic demo pass missing; run the seed first");
  }
  await es.request("PUT", `${path}?refresh=wait_for`, { ...doc, rooms: allowed ? [ALL_ROOMS] : [], updated_at: new Date().toISOString() });
}

function required(env: NodeJS.ProcessEnv, key: string) {
  if (!env[key]) throw new Error(`Missing ${key}`);
  return env[key]!;
}

export async function main(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
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
  if (env.ES_USERNAME !== "companion_svc") throw new Error("Demo seed requires ES_USERNAME=companion_svc");
  const esUrl = required(env, "ES_URL");
  if (new URL(esUrl).protocol !== "https:") throw new Error("Demo seed requires HTTPS ES_URL and a trusted CA");
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
  const es = createEsClient({ esUrl, esUsername: "companion_svc", esPassword: required(env, "ES_PASSWORD") });
  const signed = sessionDestination && signingKey
    ? await createTokenService({ key: signingKey, nodeEnv: env.NODE_ENV }).sign(ALLOWED_DEMO_ID, { ttlSeconds: 900 })
    : undefined;
  // Reserve exclusively before the first ES request: a stale output file must
  // never restore/reseed a pass and then make the overall command report failure.
  const sessionHandle = sessionDestination ? await open(sessionDestination, "wx", 0o600) : undefined;
  let sessionComplete = false;
  try {
    let summary: string;
    if (args.includes("--revoke") || args.includes("--restore")) {
      await setDemoPass(es, args.includes("--restore"));
      summary = args.includes("--restore") ? "Synthetic demo pass restored." : "Synthetic demo pass revoked.";
    } else {
      const embedder = createEmbedder(env, es);
      const result = await seedDemo(es, new Date(), (text) => embedder.embed(text));
      summary = `Seeded ${result.attendees} SYNTHETIC DEMO attendees; ${result.optedIn} opted in; ${result.initiallyRevoked} initially revoked pass. No IDs or tokens printed.`;
    }
    if (sessionHandle && signed) await sessionHandle.writeFile(JSON.stringify(signed));
    sessionComplete = true;
    console.log(summary);
    if (sessionHandle) console.log("Private synthetic session file created (15-minute expiry). Do not commit or record it.");
  } finally {
    await sessionHandle?.close();
    if (sessionDestination && !sessionComplete) await rm(sessionDestination, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // ES exceptions include document paths; do not print them (attendee IDs).
    console.error("Demo seed failed. Check flags, companion_svc credentials, trusted ES CA, inference readiness, and private session-file path. No error details printed.");
    process.exitCode = 1;
  });
}
