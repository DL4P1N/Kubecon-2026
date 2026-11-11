#!/usr/bin/env node
// Reproducible local Conference Companion stack on a dedicated kind cluster.
// Usage: node deploy/local/companion.mjs up|serve|status [options]; see deploy/local/README.md.
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const USAGE = `Usage:
  node deploy/local/companion.mjs up     [--name NAME] [--accept-elastic-trial]
  node deploy/local/companion.mjs serve  [--name NAME] [--port PORT]
  node deploy/local/companion.mjs status [--name NAME]`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [command, ...args] = process.argv.slice(2);
const option = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${flag} needs a value.\n${USAGE}`);
  return args[i + 1];
};

const EXPECTED_TALKS = 417;
const namespace = 'conference-companion';
const name = option('--name', 'companion-local');
const context = `kind-${name}`;
const stateRoot = path.join(root, 'deploy/local/.state');
const state = path.join(stateRoot, name);
const files = {
  kubeconfig: path.join(state, 'kubeconfig'),
  marker: path.join(state, 'owned.json'),
  credentials: path.join(state, 'credentials.json'),
  cert: path.join(state, 'tls.crt'),
  key: path.join(state, 'tls.key'),
};
const kubeArgs = ['--kubeconfig', files.kubeconfig, '--context', context];

// ---------------------------------------------------------------- helpers

const exists = async (p) => access(p).then(() => true, () => false);
const run = (bin, argv, opts = {}) => execFileSync(bin, argv, { cwd: root, stdio: 'inherit', ...opts });
const capture = (bin, argv, opts = {}) =>
  execFileSync(bin, argv, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...opts });
const kubectl = (...argv) => capture('kubectl', [...kubeArgs, '-n', namespace, ...argv]);
const apply = (docs) =>
  capture('kubectl', [...kubeArgs, '-n', namespace, 'apply', '-f', '-'], { input: docs.map((d) => YAML.stringify(d)).join('---\n') });
const kindClusters = () => capture('kind', ['get', 'clusters']).split(/\s+/).filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function privateDir(p) {
  await mkdir(p, { recursive: true, mode: 0o700 });
  await chmod(p, 0o700);
}

async function privateWrite(p, data) {
  await writeFile(p, data, { mode: 0o600, flag: 'wx' }); // never overwrite existing private state
  await chmod(p, 0o600);
}

const secret = (secretName, data, type = 'Opaque') => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name: secretName, namespace },
  type,
  data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Buffer.from(v).toString('base64')])),
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Loopback-only port-forward on an ephemeral port; resolves once kubectl reports it is listening. */
async function portForward(target, remotePort) {
  const port = await freePort();
  const child = spawn('kubectl', [...kubeArgs, '-n', namespace, 'port-forward', '--address', '127.0.0.1', target, `${port}:${remotePort}`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Port-forward to ${target} did not start within 30s.`));
    }, 30_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Forwarding from')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Port-forward to ${target} exited with code ${code}.`));
    });
  });
  return { port, stop: () => child.kill('SIGTERM') };
}

/** Elasticsearch request through the private port-forward; credentials go via stdin, never argv. Errors carry curl's stderr. */
function es(port, user, password, endpoint) {
  try {
    const body = capture('curl', ['-sS', '--fail', '--cacert', files.cert, '--config', '-', `https://localhost:${port}${endpoint}`], {
      input: `user = "${user}:${password}"\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`${endpoint}: ${String(err.stderr ?? err.message).trim()}`);
  }
}

async function retry(label, attempts, fn) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw new Error(`${label}: ${err.message}`);
      await sleep(2000);
    }
  }
}

/** Point every cc-api/cc-web container in a workload at the freshly built cluster-local images. */
function retag(doc, images) {
  const podSpec = doc.kind === 'CronJob' ? doc.spec.jobTemplate.spec.template.spec : doc.spec?.template?.spec;
  for (const container of podSpec?.containers ?? []) {
    const base = container.image.split(':')[0];
    if (images[base]) container.image = images[base];
  }
  return doc;
}

const readDocs = async (rel) =>
  YAML.parseAllDocuments(await readFile(path.join(root, rel), 'utf8')).map((d) => d.toJSON()).filter(Boolean);

// ---------------------------------------------------------------- private state + cluster

async function prepare() {
  await privateDir(stateRoot);
  await privateDir(state);

  if (!(await exists(files.marker))) {
    if (kindClusters().includes(name)) throw new Error(`Refusing to adopt existing kind cluster '${name}' without an ownership marker. Choose another --name.`);
    await privateWrite(files.marker, `${JSON.stringify({ name, context, createdAt: new Date().toISOString() })}\n`);
    const generated = {
      elasticPassword: randomBytes(32).toString('base64url'),
      servicePassword: randomBytes(32).toString('base64url'),
      tokenSigningKey: randomBytes(48).toString('base64url'),
      organizerKey: randomBytes(32).toString('base64url'),
    };
    await privateWrite(files.credentials, `${JSON.stringify(generated, null, 2)}\n`);
  } else {
    const owned = JSON.parse(await readFile(files.marker, 'utf8'));
    if (owned.name !== name || owned.context !== context) throw new Error('Ownership marker does not match --name; refusing.');
    if (!(await exists(files.credentials))) throw new Error('Private credentials are missing; refusing to rotate them. Restore them from a secure backup.');
  }

  if (!(await exists(files.kubeconfig))) {
    if (kindClusters().includes(name)) throw new Error('Owned cluster exists but its dedicated kubeconfig is missing; refusing to adopt it.');
    run('kind', ['create', 'cluster', '--name', name, '--config', path.join(root, 'deploy/local/kind.yaml'), '--kubeconfig', files.kubeconfig, '--wait', '180s']);
    await chmod(files.kubeconfig, 0o600);
  }
  if (!kindClusters().includes(name)) throw new Error(`Owned cluster '${name}' no longer exists; refusing to recreate it because its data may be gone.`);

  const haveCert = await exists(files.cert);
  const haveKey = await exists(files.key);
  if (haveCert !== haveKey) throw new Error('Only half of the private TLS keypair exists; refusing to rotate it.');
  if (!haveCert) {
    // stderr is captured (only progress dots on success) and surfaces in the thrown error on failure.
    run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '365', '-keyout', files.key, '-out', files.cert, '-config', path.join(root, 'scripts/es-cert.conf')], { stdio: ['ignore', 'ignore', 'pipe'] });
    await chmod(files.key, 0o600);
    await chmod(files.cert, 0o600);
  }
}

function oauthFromEnv() {
  const out = {};
  for (const provider of ['GITHUB', 'GOOGLE', 'LINKEDIN']) {
    const keys = ['CLIENT_ID', 'CLIENT_SECRET', 'OAUTH_REDIRECT_URI'].map((k) => `${provider}_${k}`);
    const present = keys.filter((k) => process.env[k]);
    if (present.length === keys.length) for (const k of keys) out[k] = process.env[k];
    else if (present.length > 0) throw new Error(`Incomplete ${provider} OAuth settings: export all of ${keys.join(', ')} or none.`);
  }
  if (process.env.IDENTITY_HASH_KEY) out.IDENTITY_HASH_KEY = process.env.IDENTITY_HASH_KEY;
  return out;
}

async function collectorDocs() {
  const docs = [...(await readDocs('deploy/k8s/otel-collector/configmap.yaml')), ...(await readDocs('deploy/k8s/otel-collector/deployment.yaml'))];
  const endpoint = process.env.DASH0_OTLP_ENDPOINT;
  const token = process.env.DASH0_AUTH_TOKEN;
  if (Boolean(endpoint) !== Boolean(token)) throw new Error('Export both DASH0_OTLP_ENDPOINT and DASH0_AUTH_TOKEN, or neither.');
  if (endpoint) return [secret('dash0-credentials', { endpoint, token }), ...docs];

  // No Dash0: keep the committed receivers/processors (privacy filtering) and export to debug only.
  for (const doc of docs) {
    if (doc.kind === 'ConfigMap') {
      const config = YAML.parse(doc.data['config.yaml']);
      delete config.exporters['otlphttp/dash0'];
      for (const pipeline of Object.values(config.service.pipelines)) pipeline.exporters = pipeline.exporters.filter((e) => e !== 'otlphttp/dash0');
      doc.data['config.yaml'] = YAML.stringify(config);
    }
    if (doc.kind === 'Deployment') for (const c of doc.spec.template.spec.containers) delete c.env;
  }
  return docs;
}

async function waitForJob(job, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const conditions = JSON.parse(kubectl('get', `job/${job}`, '-o', 'json')).status?.conditions ?? [];
    const done = (type) => conditions.some((c) => c.type === type && c.status === 'True');
    if (done('Complete')) return;
    if (done('Failed')) throw new Error(`Job ${job} failed; inspect it with kubectl logs job/${job}.`);
    await sleep(5000);
  }
  throw new Error(`Job ${job} did not finish within ${timeoutMs / 60000} minutes; rerun 'up' to keep waiting.`);
}

// ---------------------------------------------------------------- commands

async function up() {
  const oauth = oauthFromEnv();
  const collector = await collectorDocs();
  await prepare();
  const creds = JSON.parse(await readFile(files.credentials, 'utf8'));
  const cert = await readFile(files.cert, 'utf8');
  if (Object.keys(oauth).length > 0 && !oauth.IDENTITY_HASH_KEY) {
    if (!creds.identityHashKey) {
      creds.identityHashKey = randomBytes(48).toString('base64url');
      await privateWrite(files.credentials, `${JSON.stringify(creds, null, 2)}\n`);
    }
    oauth.IDENTITY_HASH_KEY = creds.identityHashKey;
  }
  apply([{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } }]);

  apply([
    secret('elasticsearch-admin', { password: creds.elasticPassword }),
    secret('elasticsearch-tls', { 'tls.crt': cert, 'tls.key': await readFile(files.key, 'utf8') }, 'kubernetes.io/tls'),
    secret('elasticsearch-http-ca', { 'ca.crt': cert }),
    secret('companion-app-secrets', {
      ES_USERNAME: 'companion_svc',
      ES_PASSWORD: creds.servicePassword,
      TOKEN_SIGNING_KEY: creds.tokenSigningKey,
      ORGANIZER_KEY: creds.organizerKey,
      ...oauth,
    }),
  ]);

  console.log('Starting Elasticsearch (first start can take several minutes)...');
  kubectl('apply', '-k', path.join(root, 'deploy/k8s/elasticsearch'));
  kubectl('rollout', 'status', 'statefulset/elasticsearch', '--timeout=900s');

  const esForward = await portForward('service/elasticsearch', 9200);
  try {
    const admin = (endpoint) => es(esForward.port, 'elastic', creds.elasticPassword, endpoint);
    const { license } = await retry('Elasticsearch did not answer', 45, () => admin('/_license'));
    const licensed = ['trial', 'platinum', 'enterprise'].includes(license.type) && license.status === 'active';
    if (!licensed && !args.includes('--accept-elastic-trial')) {
      throw new Error('No inference-capable Elastic license is active. Rerun with --accept-elastic-trial only if you accept the Elastic trial terms.');
    }
    // Least-privilege role/user plus (if accepted above) trial activation; same script as the documented manual path.
    run('bash', [path.join(root, 'scripts/es-setup.sh')], {
      env: { ...process.env, ES_URL: `https://localhost:${esForward.port}`, ES_CA_CERT: files.cert, ELASTIC_PASSWORD: creds.elasticPassword, ES_PASSWORD: creds.servicePassword },
    });

    apply(collector);

    const tag = `local-${Date.now().toString(36)}`;
    const images = { 'cc-api': `cc-api-${name}:${tag}`, 'cc-web': `cc-web-${name}:${tag}` };
    run('docker', ['build', '-f', 'api/Dockerfile', '-t', images['cc-api'], '.']);
    run('docker', ['build', '-f', 'web/Dockerfile', '-t', images['cc-web'], '.']);
    run('kind', ['load', 'docker-image', '--name', name, images['cc-api'], images['cc-web']]);

    const app = YAML.parseAllDocuments(capture('kubectl', ['kustomize', path.join(root, 'deploy/k8s/app')])).map((d) => d.toJSON()).filter(Boolean);
    const cronJobs = [...(await readDocs('deploy/k8s/app/clusters-cronjob.yaml')), ...(await readDocs('deploy/k8s/app/retention-cronjob.yaml'))];
    apply([...app, ...cronJobs].map((doc) => retag(doc, images)));
    for (const workload of ['deployment/otel-collector', 'deployment/api', 'deployment/web']) kubectl('rollout', 'status', workload, '--timeout=300s');

    // Seeding upserts talks by id, so it is safe to rerun; skip it once the full catalog is present.
    const talkCount = () => es(esForward.port, 'companion_svc', creds.servicePassword, '/talks/_count').count;
    let count;
    try {
      count = talkCount();
    } catch {
      count = 0; // talks index/alias not created yet
    }
    if (count !== EXPECTED_TALKS) {
      console.log(`Seeding the ${EXPECTED_TALKS}-talk catalog (Elasticsearch embeds every talk; this can take many minutes)...`);
      kubectl('delete', 'job/seed-talks', '--ignore-not-found', '--wait=true');
      apply((await readDocs('deploy/k8s/app/seed-job.yaml')).map((doc) => retag(doc, images)));
      await waitForJob('seed-talks', 30 * 60_000);
      count = talkCount();
    }
    if (count !== EXPECTED_TALKS) throw new Error(`Expected ${EXPECTED_TALKS} talks after seeding; Elasticsearch reports ${count}.`);
  } finally {
    esForward.stop();
  }

  const { status } = await apiStatus();
  console.log(`Ready: cluster ${name}, namespace ${namespace}, ${EXPECTED_TALKS} talks indexed, API status ${status}.`);
  console.log(`Serve it with: node deploy/local/companion.mjs serve${name === 'companion-local' ? '' : ` --name ${name}`}`);
}

async function requireOwned() {
  if (!(await exists(files.marker)) || !(await exists(files.kubeconfig))) throw new Error(`No local state for '${name}'; run 'up' first.`);
  const owned = JSON.parse(await readFile(files.marker, 'utf8'));
  if (owned.name !== name || owned.context !== context) throw new Error('Ownership marker does not match --name; refusing.');
}

/** Real end-to-end probe: public status route plus a real catalog search through the API service. */
async function apiStatus() {
  const forward = await portForward('service/api', 3000);
  try {
    const base = `http://127.0.0.1:${forward.port}`;
    const status = await retry('API did not answer /api/status', 15, async () => {
      const res = await fetch(`${base}/api/status`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    });
    const search = await fetch(`${base}/api/search?q=${encodeURIComponent('kubernetes security')}`);
    if (!search.ok) throw new Error(`Catalog search failed with HTTP ${search.status}.`);
    const { hits = [] } = await search.json();
    if (hits.length === 0) throw new Error('Catalog search returned no talks.');
    return { status: status.status, elasticsearchReachable: status.elasticsearch.reachable, searchResults: hits.length };
  } finally {
    forward.stop();
  }
}

async function status() {
  await requireOwned();
  process.stdout.write(kubectl('get', 'pods,services'));
  console.log(JSON.stringify(await apiStatus()));
}

async function serve() {
  await requireOwned();
  const port = option('--port', '8080');
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid --port.');
  console.log(`Serving on http://127.0.0.1:${port} (Ctrl-C to stop).`);
  const child = spawn('kubectl', [...kubeArgs, '-n', namespace, 'port-forward', '--address', '127.0.0.1', 'service/web', `${port}:8080`], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 1));
}

try {
  if (command === 'up') await up();
  else if (command === 'serve') await serve();
  else if (command === 'status') await status();
  else throw new Error(USAGE);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
