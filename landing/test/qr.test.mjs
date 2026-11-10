import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { encodeQr, drawQr, registrationUrl, resolveColors, parseColor, contrastRatio, renderAll, QUIET_ZONE } from "../js/qr.js";
import { resetConfigCache } from "../js/companion-api.js";

// Expected symbol sizes (QR version) from an independent encoder (soldair/qrcode), byte mode, level M.
const SAMPLES = [
  ["A", 21],
  ["https://example.com/register.html?c=cloud-native-hackathon-slc-2026&via=qr", 37],
  ["http://192.168.1.23:4310/register.html?c=cloud-native-hackathon-slc-2026&via=qr", 37],
  ["demo.kJ9x0Qm2LwR7aP4tVbN1cYzE6uHs3GdF8oXiTq5W", 33],
  ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1NTBlODQwMC1lMjliLTQxZDQtYTcxNi00NDY2NTU0NDAwMDAiLCJleHAiOjE3OTQ0NDQ4MDB9.sFDr5q1Y8Yj3hX0kZpN7mWcL2vBt9aR4uE6oIgH1dSw", 53],
  ["héllo ☃ 日本", 25],
];

function bchFormat(data) {
  let d = data << 10;
  for (let i = 14; i >= 10; i--) if ((d >> i) & 1) d ^= 0x537 << (i - 10);
  return ((data << 10) | d) ^ 0x5412;
}

test("matrix structure: size, finders, timing, dark module, format info says level M with a valid BCH", () => {
  for (const [text, expectedSize] of SAMPLES) {
    const { size, modules: m } = encodeQr(text);
    assert.equal(size, expectedSize, text.slice(0, 30));
    assert.equal((size - 17) % 4, 0);
    const finder = (r0, c0) => {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(m[r0 + r][c0 + c], edge || core, `${text.slice(0, 10)} finder ${r0},${c0} at ${r},${c}`);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0);
      assert.equal(m[i][6], i % 2 === 0);
    }
    assert.equal(m[size - 8][8], true); // the always-dark module
    // format info, first copy (layout as in ISO 18004 / the encoder's setupTypeInfo)
    const pos = [];
    for (let i = 0; i < 6; i++) pos.push([i, 8]);
    pos.push([7, 8], [8, 8], [8, 7]);
    for (let i = 9; i < 15; i++) pos.push([8, 14 - i]);
    let bits = 0;
    pos.forEach(([r, c], i) => { if (m[r][c]) bits |= 1 << i; });
    const copy2 = [];
    for (let i = 0; i < 8; i++) copy2.push([8, size - i - 1]);
    for (let i = 8; i < 15; i++) copy2.push([size - 15 + i, 8]);
    let bits2 = 0;
    copy2.forEach(([r, c], i) => { if (m[r][c]) bits2 |= 1 << i; });
    assert.equal(bits, bits2, "both format copies agree");
    const data = (bits ^ 0x5412) >> 10;
    assert.equal(bits, bchFormat(data), "BCH(15,5) is valid");
    assert.equal(data >> 3, 0b00, "error correction level M");
  }
});

// ----- decode with an independent decoder (OpenCV) when this machine has it

function pngGray(width, height, pixel) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = pixel(x, y);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const hasCv2 = spawnSync("python3", ["-I", "-c", "import cv2"], { encoding: "utf8" }).status === 0;

function decodeWithOpenCv(file) {
  const r = spawnSync("python3", ["-I", "-c", "import cv2,sys\nimg=cv2.imread(sys.argv[1])\nt,_,_=cv2.QRCodeDetector().detectAndDecode(img)\nsys.stdout.buffer.write(t.encode('utf-8'))", file], { encoding: "buffer" });
  return r.stdout.toString("utf8");
}

test("a rendered code decodes back to the original text (OpenCV QR decoder)", { skip: !hasCv2 && "python3 with cv2 not available" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-qr-"));
  try {
    for (const [text] of SAMPLES) {
      const canvas = fakeCanvas();
      const info = drawQr(canvas, text, { scale: 10 });
      const bmp = canvas.bitmap();
      const file = path.join(dir, "q.png");
      fs.writeFileSync(file, pngGray(info.pixels, info.pixels, (x, y) => (bmp[y][x] === "ink" ? 0 : 255)));
      assert.equal(decodeWithOpenCv(file), text, text.slice(0, 40));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----- drawQr on a fake canvas

function fakeCanvas({ attrs = {}, dataset = {} } = {}) {
  const calls = [];
  const state = { fillStyle: null };
  const ctx = {
    imageSmoothingEnabled: true,
    set fillStyle(v) { state.fillStyle = v; },
    get fillStyle() { return state.fillStyle; },
    fillRect(x, y, w, h) { calls.push({ x, y, w, h, color: state.fillStyle }); },
  };
  const a = { ...attrs };
  return {
    width: 300, height: 300, style: {}, dataset, ctx, calls,
    getContext: () => ctx,
    hasAttribute: (k) => k in a, getAttribute: (k) => a[k] ?? null, setAttribute: (k, v) => { a[k] = String(v); }, removeAttribute: (k) => { delete a[k]; },
    attrs: a,
    /** Paint the recorded calls onto a pixel grid; returns rows of "ink" | "paper". */
    bitmap() {
      const paperColor = calls[0].color;
      const g = Array.from({ length: this.height }, () => Array(this.width).fill(null));
      for (const c of calls) for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) g[y][x] = c.color === paperColor ? "paper" : "ink";
      return g;
    },
  };
}

test("drawQr: integer module sizes, 4-module quiet zone, no smoothing, pixelated, exact backing store", () => {
  const text = "https://example.com/register.html?c=x&via=qr";
  const { size, modules } = encodeQr(text);
  const canvas = fakeCanvas();
  const info = drawQr(canvas, text, { scale: 5 });
  const total = size + 2 * QUIET_ZONE;
  assert.equal(QUIET_ZONE, 4);
  assert.equal(canvas.width, total * 5);
  assert.equal(canvas.height, total * 5);
  assert.equal(canvas.width % total, 0);
  assert.equal(canvas.style.imageRendering, "pixelated");
  assert.equal(canvas.style.width, `${total * 5}px`);
  assert.equal(canvas.ctx.imageSmoothingEnabled, false);
  assert.equal(info.size, size);
  for (const c of canvas.calls) for (const v of [c.x, c.y, c.w, c.h]) assert.ok(Number.isInteger(v));
  const dark = canvas.calls.slice(1);
  assert.ok(dark.every((c) => c.w === 5 && c.h === 5 && c.x % 5 === 0 && c.y % 5 === 0));
  const bmp = canvas.bitmap();
  for (let r = 0; r < total; r++) for (let c = 0; c < total; c++) {
    const inside = r >= QUIET_ZONE && c >= QUIET_ZONE && r < QUIET_ZONE + size && c < QUIET_ZONE + size;
    const expect = inside && modules[r - QUIET_ZONE][c - QUIET_ZONE] ? "ink" : "paper";
    assert.equal(bmp[r * 5 + 2][c * 5 + 2], expect, `module ${r},${c}`);
    assert.equal(bmp[r * 5][c * 5], expect); // whole module is one colour
    assert.equal(bmp[r * 5 + 4][c * 5 + 4], expect);
  }
});

test("drawQr: device pixel ratio keeps modules whole device pixels", () => {
  globalThis.devicePixelRatio = 2.4; // rounded to 2
  try {
    const canvas = fakeCanvas();
    const info = drawQr(canvas, "A", { scale: 4 });
    assert.equal(canvas.width, (21 + 8) * 4 * 2);
    assert.equal(canvas.style.width, `${(21 + 8) * 4}px`);
    assert.equal(info.pixels, canvas.width);
  } finally { delete globalThis.devicePixelRatio; }
});

test("drawQr: role and aria-label are set only when missing; colours default and come from custom properties", () => {
  const c1 = fakeCanvas();
  drawQr(c1, "https://example.com/register.html");
  assert.equal(c1.attrs.role, "img");
  assert.match(c1.attrs["aria-label"], /Scan it with your phone camera to open the registration page/);
  assert.equal(c1.calls[0].color, "rgb(255, 255, 255)");
  assert.equal(c1.calls[1].color, "rgb(17, 17, 17)");
  const c2 = fakeCanvas({ attrs: { role: "presentation", "aria-label": "Mine" } });
  drawQr(c2, "x");
  assert.equal(c2.attrs.role, "presentation");
  assert.equal(c2.attrs["aria-label"], "Mine");
  const c3 = fakeCanvas();
  drawQr(c3, "demo.abc", { label: "Your ticket" });
  assert.equal(c3.attrs["aria-label"], "Your ticket");

  globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => ({ "--qr-ink": " #0a2540 ", "--qr-paper": "rgb(250, 250, 240)" })[n] ?? "" });
  try {
    const c4 = fakeCanvas();
    const r = drawQr(c4, "x");
    assert.equal(r.adjusted, false);
    assert.equal(c4.calls[0].color, "rgb(250, 250, 240)");
    assert.equal(c4.calls[1].color, "rgb(10, 37, 64)");
    assert.equal(c4.attrs["data-qr-adjusted"], undefined);
  } finally { delete globalThis.getComputedStyle; }
});

test("drawQr: unscannable colour pairs (low contrast, inverted) are replaced by the defaults", () => {
  for (const [ink, paper] of [["#777", "#888"], ["#ffffff", "#111111"], ["#333", "#333"], ["rgba(0,0,0,0.3)", "#fff"]]) {
    const c = fakeCanvas();
    const r = drawQr(c, "x", { ink, paper });
    assert.equal(r.adjusted, true, `${ink} on ${paper}`);
    assert.equal(c.attrs["data-qr-adjusted"], "true");
    assert.equal(c.calls[0].color, "#ffffff");
    assert.equal(c.calls[1].color, "#111111");
  }
  assert.equal(resolveColors("#000", "#fff").adjusted, false);
  assert.equal(resolveColors("", "").adjusted, false);
  assert.ok(contrastRatio([0, 0, 0], [255, 255, 255]) > 20.9);
  assert.deepEqual(parseColor("#abc"), [170, 187, 204]);
  assert.deepEqual(parseColor("rgb(1 2 3)"), [1, 2, 3]);
  assert.equal(parseColor("nonsense"), null);
});

test("registrationUrl and data-qr=self (public URL from /api/config, slug from ?c=)", async () => {
  assert.equal(
    registrationUrl({ origin: "http://192.168.1.5:4310", slug: "my-conf", pagePath: "/register.html" }),
    "http://192.168.1.5:4310/register.html?c=my-conf&via=qr",
  );
  assert.equal(
    registrationUrl({ origin: "https://x.test/ignored/path", slug: "a b", pagePath: "/sub/register.html" }),
    "https://x.test/sub/register.html?c=a+b&via=qr",
  );

  const realFetch = globalThis.fetch;
  const saved = { location: globalThis.location };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ appBase: "http://localhost:5173", apiBase: "http://localhost:3000", publicUrl: "http://192.168.1.5:4310", chat: "scripted" }));
    const mk = (attrs, dataset = {}) => Object.assign(fakeCanvas({ attrs }), { dataset });
    const self = mk({ "data-qr": "self" }, { qrConference: "from-attr" });
    const literal = mk({ "data-qr": "hello world" });
    const empty = mk({ "data-qr": "" });
    const root = { querySelectorAll: () => [self, literal, empty] };

    resetConfigCache();
    globalThis.location = { search: "?c=from-url&via=github", origin: "http://localhost:4310" };
    await renderAll(root);
    const REG = new URL("../register.html", new URL("../js/qr.js", import.meta.url)).pathname; // /register.html in a browser, a file path under file://
    const expected = (url) => encodeQr(url.replace("/register.html", REG)).size + 8;
    assert.equal(self.width / 6, expected("http://192.168.1.5:4310/register.html?c=from-url&via=qr"));
    assert.equal(literal.width / 6, expected("hello world"));
    assert.equal(empty.calls.length, 0, "empty data-qr is left alone");

    // without ?c= it falls back to data-qr-conference
    const self2 = mk({ "data-qr": "self" }, { qrConference: "from-attr" });
    globalThis.location = { search: "", origin: "http://localhost:4310" };
    await renderAll({ querySelectorAll: () => [self2] });
    assert.equal(self2.width / 6, expected("http://192.168.1.5:4310/register.html?c=from-attr&via=qr"));
    // and the path comes from this module's location: ../register.html next to js/
    assert.ok(new URL("../register.html", new URL("../js/qr.js", import.meta.url)).pathname.endsWith("/landing/register.html"));
  } finally {
    globalThis.fetch = realFetch;
    globalThis.location = saved.location;
    resetConfigCache();
  }
});

test("renderAll without /api/config falls back to location.origin and never throws", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("nope", { status: 404 });
    resetConfigCache();
    globalThis.location = { search: "", origin: "http://localhost:8000" };
    const c = Object.assign(fakeCanvas({ attrs: { "data-qr": "self" } }), { dataset: {} });
    await renderAll({ querySelectorAll: () => [c] });
    assert.ok(c.width > 0);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.location;
    resetConfigCache();
  }
});
