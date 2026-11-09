import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:https";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";

it("rejects incomplete TLS configuration", () => {
  expect(() => loadConfig({ API_TLS_CERT_FILE: "cert.pem" })).toThrow("set together");
  expect(() => loadConfig({ API_TLS_KEY_FILE: "key.pem" })).toThrow("set together");
});

const openssl = process.env.OPENSSL || "openssl";
const available = spawnSync(openssl, ["version"]).status === 0;
it.skipIf(!available)("serves trusted HTTPS and rejects untrusted CAs and mismatched names", async () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-tls-test-"));
  const cert = join(directory, "cert.pem");
  const key = join(directory, "key.pem");
  const generated = spawnSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", key, "-out", cert], { stdio: "ignore" });
  expect(generated.status).toBe(0);
  const app = buildServer(loadConfig({ API_TLS_CERT_FILE: cert, API_TLS_KEY_FILE: key }));
  try {
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    const request = (ca?: Buffer, servername = "localhost") => new Promise<number | undefined>((resolve, reject) => {
      const req = get({ hostname: "127.0.0.1", port: address.port, path: "/healthz", servername, ca }, (res) => {
        res.resume(); resolve(res.statusCode);
      });
      req.on("error", reject);
    });
    await expect(request(readFileSync(cert))).resolves.toBe(200);
    await expect(request()).rejects.toThrow();
    await expect(request(readFileSync(cert), "wrong-host")).rejects.toThrow(/hostname|altnames/i);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
