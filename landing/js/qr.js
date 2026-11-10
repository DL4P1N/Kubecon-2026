// QR rendering for the landing pages. Plain ES module.
// Encoder: vendor/qrcode.js (qrcode-generator by Kazuhiko Arase, MIT, licence header kept).
//
//   drawQr(canvas, text, opts)  draw `text` as a pixel-art QR code on a <canvas>
//   canvas[data-qr="..."]       auto-rendered on DOM ready; data-qr="self" = the registration URL
//
// Byte mode, error correction M, 4-module quiet zone, integer-sized square modules,
// no smoothing. Colours come from the canvas's CSS custom properties --qr-ink / --qr-paper.

import qrcode from "../vendor/qrcode.js";
import { getConfig, onReady } from "./companion-api.js";
import { DEFAULT_SLUG } from "./conferences.js";

export const QUIET_ZONE = 4;
export const DEFAULT_INK = "#111111";
export const DEFAULT_PAPER = "#ffffff";
/** Minimum WCAG contrast ratio between ink and paper before we fall back to the defaults. */
export const MIN_CONTRAST = 4;
export const DEFAULT_SCALE = 6; // CSS pixels per module

/** Encodes `text` (UTF-8, byte mode, level M). Returns `{size, modules}` where modules[row][col] is true for dark. */
export function encodeQr(text, level = "M") {
  const utf8 = new TextEncoder().encode(String(text));
  // qrcode-generator's default byte encoder takes one char per byte, so hand it a Latin-1 view of the UTF-8 bytes.
  let latin1 = "";
  for (const b of utf8) latin1 += String.fromCharCode(b);
  const qr = qrcode(0, level);
  qr.addData(latin1, "Byte");
  qr.make();
  const size = qr.getModuleCount();
  const modules = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(qr.isDark(r, c));
    modules.push(row);
  }
  return { size, modules };
}

// ------------------------------------------------------------------ colour

/** Parses #rgb, #rrggbb, rgb()/rgba() into [r,g,b] (0-255), else null. Semi-transparent colours are rejected. */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [...m[1]].map((h) => parseInt(h + h, 16));
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (!(a >= 0.99)) return null;
    return [m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)));
  }
  if (v === "black") return [0, 0, 0];
  if (v === "white") return [255, 255, 255];
  return null;
}

export function luminance([r, g, b]) {
  const f = (x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Normalises any CSS colour the browser understands to [r,g,b] using a scratch canvas context. */
function parseViaBrowser(value) {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.fillStyle = "#010203";
    ctx.fillStyle = value; // invalid values leave the sentinel in place
    const out = ctx.fillStyle;
    if (out === "#010203" && value.trim().toLowerCase() !== "#010203") return null;
    return parseColor(out);
  } catch {
    return null;
  }
}

/**
 * Resolves ink and paper. Ink must be darker than paper with enough contrast to scan;
 * otherwise both fall back to the defaults and `adjusted` is true.
 */
export function resolveColors(inkValue, paperValue) {
  const dflt = { ink: DEFAULT_INK, paper: DEFAULT_PAPER };
  const toRgb = (v) => (v ? parseColor(v) ?? (typeof document !== "undefined" ? parseViaBrowser(v) : null) : null);
  const ink = toRgb(inkValue);
  const paper = toRgb(paperValue);
  const inkRgb = ink ?? parseColor(DEFAULT_INK);
  const paperRgb = paper ?? parseColor(DEFAULT_PAPER);
  const ok = luminance(inkRgb) < luminance(paperRgb) && contrastRatio(inkRgb, paperRgb) >= MIN_CONTRAST;
  // A colour we were given but cannot use (unparsable, translucent) counts as adjusted too.
  const unusable = Boolean((inkValue && !ink) || (paperValue && !paper));
  if (!ok) return { ...dflt, adjusted: Boolean(inkValue || paperValue) };
  if (unusable) return { ...dflt, adjusted: true };
  const css = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;
  return { ink: css(inkRgb), paper: css(paperRgb), adjusted: false };
}

// -------------------------------------------------------------------- draw

function cssVar(canvas, name) {
  try {
    return getComputedStyle(canvas).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

/**
 * Draws `text` into `canvas`.
 * opts: { scale = CSS px per module (integer, default 6), level = "M"|"Q", ink, paper, label }
 * Backing store = (modules + 2 * quiet zone) * scale * round(devicePixelRatio) exactly, so every module is a whole
 * number of device pixels; the element's inline CSS size is set to the matching whole number of CSS pixels.
 * Returns `{ size, pixels, quiet, adjusted }`.
 */
export function drawQr(canvas, text, opts = {}) {
  const { size, modules } = encodeQr(text, opts.level === "Q" ? "Q" : "M");
  const quiet = QUIET_ZONE;
  const total = size + quiet * 2;
  const cssScale = Math.max(1, Math.floor(Number(opts.scale ?? canvas.dataset?.qrScale) || DEFAULT_SCALE));
  const dpr = Math.max(1, Math.round((typeof devicePixelRatio === "number" && devicePixelRatio) || 1));
  const px = cssScale * dpr;

  const colors = resolveColors(opts.ink ?? cssVar(canvas, "--qr-ink"), opts.paper ?? cssVar(canvas, "--qr-paper"));

  canvas.width = total * px;
  canvas.height = total * px;
  canvas.style.width = `${total * cssScale}px`;
  canvas.style.height = `${total * cssScale}px`;
  canvas.style.imageRendering = "crisp-edges"; // older Firefox
  canvas.style.imageRendering = "pixelated";
  if (colors.adjusted) canvas.setAttribute("data-qr-adjusted", "true");
  else canvas.removeAttribute?.("data-qr-adjusted");

  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = colors.paper;
  ctx.fillRect(0, 0, total * px, total * px);
  ctx.fillStyle = colors.ink;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
    }
  }

  if (!canvas.hasAttribute("role")) canvas.setAttribute("role", "img");
  if (!canvas.hasAttribute("aria-label")) {
    canvas.setAttribute(
      "aria-label",
      opts.label ??
        canvas.dataset?.qrLabel ??
        (/^https?:\/\//i.test(String(text))
          ? "QR code. Scan it with your phone camera to open the registration page."
          : "QR code. Scanning it reads the encoded ticket code."),
    );
  }
  return { size, pixels: total * px, quiet, adjusted: colors.adjusted };
}

// -------------------------------------------------------------- auto render

/** URL for data-qr="self": registration page on the phone-reachable origin. */
export function registrationUrl({ origin, slug, pagePath }) {
  const base = new URL(origin).origin;
  const u = new URL(pagePath, base);
  u.searchParams.set("c", slug);
  u.searchParams.set("via", "qr");
  return u.href;
}

export async function renderAll(root = document) {
  const canvases = [...root.querySelectorAll("canvas[data-qr]")].filter((c) => c.getAttribute("data-qr").trim() !== "");
  if (!canvases.length) return;
  const pagePath = new URL("../register.html", import.meta.url).pathname;
  for (const canvas of canvases) {
    try {
      const value = canvas.getAttribute("data-qr").trim();
      let text = value;
      if (value === "self") {
        const { publicUrl } = await getConfig();
        const slug = new URLSearchParams(location.search).get("c") || canvas.dataset.qrConference || DEFAULT_SLUG;
        text = registrationUrl({ origin: publicUrl || location.origin, slug, pagePath });
      }
      drawQr(canvas, text);
    } catch {
      // leave the canvas blank rather than throw into the page
    }
  }
}

onReady(() => {
  renderAll();
});
