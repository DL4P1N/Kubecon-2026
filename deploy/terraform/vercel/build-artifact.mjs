#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, '../../..');
const outputDir = resolve(moduleDir, 'artifacts');
const image = 'conference-companion-web:vercel-artifact';
const run = (args) => {
  const result = spawnSync('docker', args, { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const temp = mkdtempSync(`${tmpdir()}/cc-vercel-`);
let container;
try {
  run(['build', '-f', 'web/Dockerfile', '-t', image, '.']);
  container = spawnSync('docker', ['create', image], { encoding: 'utf8' });
  if (container.status !== 0) throw new Error(container.stderr || 'docker create failed');
  const id = container.stdout.trim();
  try {
    run(['cp', `${id}:/usr/share/nginx/html/.`, temp]);
  } finally {
    run(['rm', '-f', id]);
  }
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  cpSync(temp, outputDir, { recursive: true });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
