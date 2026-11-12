// Run on the cluster owner's laptop. Generated keys stay in a private temp directory.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const context = process.env.KUBE_CONTEXT;
const namespace = process.env.KUBE_NAMESPACE;
const publicHost = process.env.TLS_PUBLIC_HOST || "companion.localhost";
if (!/^[a-zA-Z0-9.-]+$/.test(publicHost)) throw new Error("TLS_PUBLIC_HOST must be a DNS hostname");
if (!context || !namespace || !/^[a-z0-9-]+$/.test(namespace)) {
  throw new Error("Set KUBE_CONTEXT and KUBE_NAMESPACE explicitly before provisioning");
}
process.umask(0o077);
const output = mkdtempSync(join(tmpdir(), "companion-transport-tls-"));
const openssl = process.env.OPENSSL || "openssl";
function run(command, args, input) {
  const result = spawnSync(command, args, { encoding: "utf8", input });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
const kubectlArgs = ["--context", context, "-n", namespace];
run("kubectl", [...kubectlArgs, "get", "namespace", namespace]);
const ca = join(output, "ca.crt");
const caKey = join(output, "ca.key");
run(openssl, ["req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "7", "-sha256",
  "-subj", "/CN=Conference Companion demo transport CA", "-keyout", caKey, "-out", ca,
  "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
for (const [service, secret] of [["api", "companion-api-tls"], ["web", "companion-web-tls"]]) {
  const key = join(output, `${service}.key`);
  const csr = join(output, `${service}.csr`);
  const cert = join(output, `${service}.crt`);
  const extensions = join(output, `${service}.ext`);
  const names = [`DNS:${service}`, `DNS:${service}.${namespace}`, `DNS:${service}.${namespace}.svc`, `DNS:${service}.${namespace}.svc.cluster.local`];
  if (service === "web") names.push("DNS:localhost", "IP:127.0.0.1", `DNS:${publicHost}`);
  writeFileSync(extensions, `subjectAltName=${names.join(",")}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
  run(openssl, ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${service}`, "-keyout", key, "-out", csr]);
  run(openssl, ["x509", "-req", "-in", csr, "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-out", cert,
    "-days", "7", "-sha256", "-extfile", extensions]);
  run(openssl, ["verify", "-CAfile", ca, cert]);
  const manifest = run("kubectl", [...kubectlArgs, "create", "secret", "generic", secret, "--type=kubernetes.io/tls",
    `--from-file=tls.crt=${cert}`, `--from-file=tls.key=${key}`, `--from-file=ca.crt=${ca}`,
    "--dry-run=client", "-o", "json"]);
  run("kubectl", [...kubectlArgs, "apply", "-f", "-"], manifest);
  console.log(`Provisioned ${secret}`);
}
console.log(`Public trust CA: ${ca}`);
console.log("Retain this private temporary directory only on the cluster owner's laptop. Certificates expire in 7 days.");
