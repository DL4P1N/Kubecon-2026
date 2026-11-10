// Venue Wi-Fi: the pure payload helper and one small renderer shared by profile.html and the register ticket.
// The QR is the standard Wi-Fi join code that phone cameras read. It joins a network; it does not authenticate
// the visitor or the device. Text only via textContent.

import { drawQr } from "./qr.js";

/** Escapes the characters the WIFI: format reserves: \ ; , : " */
export function escapeWifi(value) {
  return String(value ?? "").replace(/[\\;,:"]/g, (m) => "\\" + m);
}

/** `WIFI:T:WPA;S:<ssid>;P:<password>;;` (no password part for an open network). */
export function wifiQrPayload({ ssid, security = "WPA", password = "" } = {}) {
  const t = security === "nopass" || !password ? "nopass" : String(security || "WPA");
  const p = t === "nopass" ? "" : `P:${escapeWifi(password)};`;
  return `WIFI:T:${t};S:${escapeWifi(ssid)};${p};`;
}

/** True for a usable wifi object from the conference catalogue. */
export function hasWifi(c) {
  return !!(c && c.wifi && typeof c.wifi.ssid === "string" && c.wifi.ssid.trim());
}

/** Copies text; falls back to a hidden textarea. Resolves true or false, never throws. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch { return false; }
}

/** Fills `box` with the network name, the join QR and a Copy password button. */
export function renderWifi(box, wifi, { scale = 4 } = {}) {
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const name = el("p", "wifi__name");
  name.append(el("span", "t-label", "Network"), el("strong", "", wifi.ssid));
  const frame = el("span", "pxframe wifi__qr");
  const inner = el("span", "pxframe__in");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-qr", "");
  inner.append(canvas);
  frame.append(inner);
  try {
    drawQr(canvas, wifiQrPayload(wifi), { scale, label: `QR code for the Wi-Fi network ${wifi.ssid}. Scan it with your phone camera to join.` });
  } catch { /* leave it blank */ }
  const copy = el("button", "btn btn--secondary", "Copy password");
  copy.type = "button";
  const status = el("p", "wifi__status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  copy.addEventListener("click", async () => {
    status.textContent = "";
    const ok = await copyText(wifi.password ?? "");
    setTimeout(() => { status.textContent = ok ? "Password copied" : "Copy failed. Scan the code instead."; }, 30);
  });
  const row = el("div", "wifi__row");
  row.append(copy, status);
  box.replaceChildren(name, frame, row);
}
