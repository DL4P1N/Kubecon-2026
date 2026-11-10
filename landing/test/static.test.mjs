import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startApp, rawGet } from "./helpers.mjs";

let root, outside, srv;

before(async () => {
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "cc-outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP-SECRET");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-root-"));
  const w = (rel, data) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  };
  w("index.html", "<!doctype html><title>home</title>");
  w("about/index.html", "<!doctype html><title>about</title>");
  w("js/app.mjs", "export const a = 1;");
  w("js/app.js", "export const b = 2;");
  w("data/x.json", "{}");
  w("assets/pic.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  w("assets/logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'/>");
  w("assets/f.woff2", Buffer.from("wOF2"));
  w("assets/blob.xyz", "bin");
  w("server.mjs", "SERVER-SOURCE");
  w("test/a.test.mjs", "TEST-SOURCE");
  w(".taste-skill/gate.json", "{}");
  w("node_modules/pkg/index.js", "x");
  w("sub/node_modules/pkg/index.js", "x");
  w(".env", "SECRET=1");
  w("sub/.hidden", "x");
  w("range.txt", "0123456789");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link-out.txt"));
  fs.symlinkSync(path.join(root, "server.mjs"), path.join(root, "link-to-server.txt"));
  srv = await startApp({ root });
});

after(async () => {
  await srv.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const get = (p, init) => fetch(srv.base + p, init);

test("serves index.html for / and for directories", async () => {
  assert.match(await (await get("/")).text(), /home/);
  assert.match(await (await get("/about/")).text(), /about/);
  assert.match(await (await get("/about")).text(), /about/);
});

test("content types", async () => {
  const ct = async (p) => (await get(p)).headers.get("content-type");
  assert.equal(await ct("/js/app.mjs"), "text/javascript; charset=utf-8");
  assert.equal(await ct("/js/app.js"), "text/javascript; charset=utf-8");
  assert.equal(await ct("/data/x.json"), "application/json; charset=utf-8");
  assert.equal(await ct("/assets/pic.png"), "image/png");
  assert.equal(await ct("/assets/logo.svg"), "image/svg+xml");
  assert.equal(await ct("/assets/f.woff2"), "font/woff2");
  assert.equal(await ct("/"), "text/html; charset=utf-8");
  assert.equal(await ct("/assets/blob.xyz"), "application/octet-stream");
  assert.equal((await get("/js/app.js")).headers.get("x-content-type-options"), "nosniff");
});

test("never serves server.mjs, test/, .taste-skill/, node_modules/ or dotfiles", async () => {
  for (const p of [
    "/server.mjs", "/SERVER.MJS", "/Server.mjs", "/test/a.test.mjs", "/TEST/a.test.mjs", "/.taste-skill/gate.json",
    "/node_modules/pkg/index.js", "/sub/node_modules/pkg/index.js", "/.env", "/sub/.hidden", "/test", "/test/",
  ]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    const body = await r.text();
    assert.ok(!/SERVER-SOURCE|TEST-SOURCE|SECRET/.test(body), p);
  }
});

test("path traversal attempts are refused", async () => {
  const attempts = [
    "/../server.mjs", "/..%2fserver.mjs", "/%2e%2e/server.mjs", "/%2e%2e%2fserver.mjs", "/js/../server.mjs",
    "/js/..%2f..%2fserver.mjs", "/..\\server.mjs", "/%5c..%5cserver.mjs", "/%00", "/js/app.js%00.png",
    "/%2e%2e/%2e%2e/etc/passwd", "/....//server.mjs", "/%252e%252e/server.mjs", "//etc/passwd", "/%c0%ae%c0%ae/server.mjs",
  ];
  for (const p of attempts) {
    const r = await rawGet(srv.port, p);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    assert.ok(!/SERVER-SOURCE|root:/.test(r.body), p);
  }
  assert.equal((await rawGet(srv.port, "/%E0%A4%A")).status, 404); // malformed percent-encoding
});

test("symlinks that leave the root or point at denied files are not followed", async () => {
  assert.equal((await get("/link-out.txt")).status, 404);
  assert.equal((await get("/link-to-server.txt")).status, 404);
});

test("only GET and HEAD for static files; HEAD has no body", async () => {
  assert.equal((await get("/", { method: "POST" })).status, 405);
  const h = await get("/js/app.js", { method: "HEAD" });
  assert.equal(h.status, 200);
  assert.equal(h.headers.get("content-length"), String("export const b = 2;".length));
  assert.equal(await h.text(), "");
});

test("range requests", async () => {
  const r = await get("/range.txt", { headers: { range: "bytes=2-4" } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), "234");
  assert.equal(r.headers.get("content-range"), "bytes 2-4/10");
  assert.equal((await get("/range.txt", { headers: { range: "bytes=50-60" } })).status, 416);
});

test("the real landing/ tree: server.mjs and test/ are not served, our modules are", async () => {
  const real = await startApp();
  try {
    assert.equal((await fetch(real.base + "/server.mjs")).status, 404);
    assert.equal((await fetch(real.base + "/test/static.test.mjs")).status, 404);
    assert.equal((await fetch(real.base + "/.taste-skill/gate.json")).status, 404);
    const js = await fetch(real.base + "/js/chat.js");
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /^text\/javascript/);
    const data = await fetch(real.base + "/data/conferences.json");
    assert.equal(data.status, 200);
    assert.ok(Array.isArray(await data.json()));
    assert.equal((await fetch(real.base + "/vendor/qrcode.js")).status, 200);
  } finally {
    await real.close();
  }
});

test("unknown /api routes are JSON 404s and wrong methods are 405", async () => {
  const a = await get("/api/nope");
  assert.equal(a.status, 404);
  assert.deepEqual(await a.json(), { error: "not_found" });
  assert.equal((await get("/api/chat")).status, 405);
  assert.equal((await get("/api/register")).status, 405);
  assert.equal((await get("/api/config", { method: "POST" })).status, 405);
});
