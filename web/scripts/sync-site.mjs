#!/usr/bin/env node
// Publishes the static front door (../landing) into dist/site after `vite build`.
// Node built-ins only. Copies only what the pages actually use:
//   *.html (not preview-live.html / scene/demo.html), css/, js/, scene/, vendor/, data/ (no generator and
//   no attendee-level synthetic records), favicon.svg, share.jpg, and from assets/ ONLY the closure of
//   files referenced from the copied pages/CSS/JS (following @import, url(), import ... from,
//   fetch('...') and new URL('...', import.meta.url) recursively).
// Exits 1 when a referenced file is missing. Never copies server.mjs, test/, package.json, README.md,
// .taste-skill/, shots/, node_modules/, PLAN.md, names.json.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(process.env.SITE_SRC ?? join(here, "../../landing"));
const OUT = resolve(process.env.SITE_OUT ?? join(here, "../dist/site"));
const NEVER = new Set([".taste-skill", "shots", "node_modules", "test", "server.mjs", "package.json", "package-lock.json", "README.md", "PLAN.md", "names.json", "preview-live.html"]);
const EXCLUDE_FILES = new Set(["scene/demo.html", "scene/README.md", "data/generate-demo.mjs", "data/demo-attendees.json"]);
const TEXT = new Set([".html", ".css", ".js", ".mjs"]);

function fail(message) {
  console.error(`sync-site: ${message}`);
  process.exit(1);
}
if (!existsSync(SRC)) fail(`site source not found: ${SRC}`);

const rel = (file) => relative(SRC, file).split(sep).join("/");
const isFile = (file) => { try { return statSync(file).isFile(); } catch { return false; } };
const blocked = (r) => r.split("/").some((part) => NEVER.has(part) || part.startsWith(".")) || EXCLUDE_FILES.has(r);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NEVER.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---- 1. the always-published part
const selected = new Set();
const add = (file) => {
  const r = rel(file);
  if (r.startsWith("..") || blocked(r) || selected.has(file)) return false;
  selected.add(file);
  return true;
};
for (const name of readdirSync(SRC)) {
  const full = join(SRC, name);
  if (isFile(full) && (name.endsWith(".html") || name === "favicon.svg" || name === "share.jpg") && !NEVER.has(name)) add(full);
}
// Kit modules load some files by name at runtime (diagram icons by id, ui fragments and moments by folder),
// which no static scan can see: take the icon set (top-level files only, small) here, and the siblings of a
// fragment/moment folder below.
if (existsSync(join(SRC, "assets/icons"))) {
  for (const name of readdirSync(join(SRC, "assets/icons"))) {
    const full = join(SRC, "assets/icons", name);
    if (isFile(full) && /\.(svg|css)$/.test(name)) add(full);
  }
}
const pages = new Set(selected);
for (const dir of ["css", "js", "scene", "vendor", "data"]) if (existsSync(join(SRC, dir))) walk(join(SRC, dir)).forEach(add);

// ---- 2. closure over everything the copied text files reference (this is what pulls in assets/)
function refsIn(text, ext) {
  const out = [];
  const grab = (re) => { for (const m of text.matchAll(re)) out.push(m[1]); };
  if (ext === ".html") {
    grab(/\b(?:src|href|poster)\s*=\s*"([^"]+)"/g);
    grab(/\b(?:src|href|poster)\s*=\s*'([^']+)'/g);
    for (const m of text.matchAll(/\bsrcset\s*=\s*"([^"]+)"/g)) for (const part of m[1].split(",")) out.push(part.trim().split(/\s+/)[0]);
    grab(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g);
    // kit modules a page asks for by name; ui.js and moments.js load their folder's files at runtime
    for (const m of text.matchAll(/\bdata-ui\s*=\s*"([\w-]+)"/g)) out.push(`assets/ui/${m[1]}/fragment.js`);
    for (const m of text.matchAll(/\bdata-moment\s*=\s*"([\w-]+)"/g)) out.push(`assets/moments/${m[1]}/moment.js`);
    // inline <script>/<style> content
    for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) out.push(...refsIn(m[1], ".js"));
  }
  if (ext === ".css") {
    grab(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?/g);
    grab(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g);
  }
  if (ext === ".js" || ext === ".mjs") {
    // Comments describe usage ("import(new URL('moments/moments.js', HERE))"): do not follow them.
    text = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;{}()])\/\/[^\n]*/g, "$1");
    grab(/\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g);
    grab(/\bexport\s+[^'";]*?\s+from\s+['"]([^'"]+)['"]/g);
    grab(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g);
    grab(/\bfetch\(\s*['"`]([^'"`$]+)['"`]/g);
    grab(/new\s+URL\(\s*['"`]([^'"`$]+)['"`]\s*,\s*[A-Za-z_.$]+\s*\)/g);
    // string literals that name a kit asset (paths assembled in JS)
    grab(/['"`]((?:\.\.?\/)*assets\/[A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)['"`]/g);
  }
  return out;
}

const missing = [];
function resolveRef(fromFile, ref) {
  if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/|#|%23|\.{1,3}$|\.\.\.)/i.test(ref)) return null; // external, data:, absolute (/api, /site: served by the app), anchors, "." directory bases, "..." in comments
  const clean = ref.split(/[?#]/)[0];
  if (!clean || clean.endsWith("/")) return null;
  // Kit loaders build "<folder>/fragment.css" etc. from a runtime folder name: the bare name is not a file here.
  if (/^(?:meta\.json|fragment\.[a-z]+|moment\.[a-z]+)$/.test(clean)) return null;
  // ../api/x from js/ is the app's /site/api/x endpoint, not a file.
  if (/^(?:\.\.\/)+api\//.test(clean) || /^api\//.test(clean)) return null;
  // Relative to the referring file; a page-level fetch('x') is relative to the page, i.e. the landing root.
  return [resolve(dirname(fromFile), clean), resolve(SRC, clean)].find(isFile) ?? { missing: resolve(dirname(fromFile), clean) };
}

const queue = [...selected].filter((f) => TEXT.has(extname(f)));
const scanned = new Set();
while (queue.length) {
  const file = queue.pop();
  if (scanned.has(file)) continue;
  scanned.add(file);
  for (const ref of refsIn(readFileSync(file, "utf8"), extname(file))) {
    const hit = resolveRef(file, ref);
    if (!hit) continue;
    if (typeof hit === "object") {
      // Unresolved: only an error when it points inside the landing tree (templated or external names never get here).
      if (!rel(hit.missing).startsWith("..")) missing.push(`${rel(file)} -> ${ref}`);
      continue;
    }
    const r = rel(hit);
    if (r.startsWith("..")) continue;
    if (blocked(r)) { missing.push(`${rel(file)} -> ${ref} (resolves to excluded ${r})`); continue; }
    add(hit);
    const folder = /^(assets\/ui\/[^/]+)\/fragment\.[a-z]+$/.exec(r) ?? /^(assets\/moments\/[^/]+)\/moment\.[a-z]+$/.exec(r);
    if (folder) {
      for (const name of readdirSync(join(SRC, folder[1]))) {
        const sibling = join(SRC, folder[1], name);
        if (/^((fragment|moment)\.[a-z]+|meta\.json)$/.test(name) && isFile(sibling) && add(sibling) && TEXT.has(extname(sibling))) queue.push(sibling);
      }
    }
    // Follow code/style references; an HTML file is only followed when it is one of the site's own pages.
    if (TEXT.has(extname(hit)) && (extname(hit) !== ".html" || pages.has(hit))) queue.push(hit);
  }
}
if (missing.length) fail(`referenced files are missing from landing/ (or excluded from the build):\n  ${[...new Set(missing)].join("\n  ")}`);

// ---- 3. write dist/site from scratch (also removes anything Vite copied through the symlink)
rmSync(OUT, { recursive: true, force: true });
let bytes = 0;
for (const file of [...selected].sort()) {
  const target = join(OUT, rel(file));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(file, target, { dereference: true });
  bytes += statSync(target).size;
}
console.log(`sync-site: ${selected.size} files, ${(bytes / 1048576).toFixed(2)} MiB (${bytes} bytes) -> ${relative(process.cwd(), OUT) || OUT}`);
