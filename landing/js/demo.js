// Conference Companion: demo layer (presenter bar, organiser overlay, live walk-in).
// Inert unless demo mode is on: ?demo=1 in the URL, or the D key (remembered for the tab in sessionStorage).
// Everything is created at runtime, fixed-position, and removed again when demo mode turns off.
// No dependencies. Every fetch / stream / channel fails silently.

import { getLiveAggregates, liveRoomRows, liveClusterRows, ROOM_LEVEL_STEPS, applyAppLinks } from "./companion-api.js";

const STORE_KEY = "cc.demo";
const CHANNEL = "cc-demo";
const DATA_URL = new URL("../data/demo-aggregates.json", import.meta.url);
const EVENTS_URL = "/api/events"; // absolute same-origin: the real API under /site/, landing/server.mjs on the preview
const WALKIN_NAMES = ["Ana", "Ravi", "Mei", "Jonas", "Priya", "Kofi", "Lena", "Omar", "Yuki", "Tess"];
const DEDUPE_MS = 3000;
// rooms the scene's guide() knows (scene/README.md: keynote is the main stage; room-a..room-d, lounge); guide() returns false for unknown ones
const NAV_ROOMS = [["stage", "Main stage"], ["lounge", "Lounge"], ["room-a", "Room A"], ["room-b", "Room B"], ["room-c", "Room C"], ["room-d", "Room D"]];
const LIVE_POLL_MS = 15_000; // real aggregates (getLiveAggregates), re-read this often while demo mode is on
const TAG_SYNTH = "Synthetic demo data";
const TAG_LIVE = "Live data";
const TOAST_MS = 4000;
const ROOM_LABELS = { keynote: "Keynote", "room-a": "Room A", "room-b": "Room B", "room-c": "Room C", "room-d": "Room D", lounge: "Lounge" };
const VIA_LABELS = { qr: "QR code", github: "GitHub" };

const root = document.documentElement;
const reg = { demo: null }; // the live instance while demo mode is on

// ------------------------------------------------------------------ small helpers
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : (typeof v === "string" && v.trim() !== "" && Number.isFinite(+v) ? +v : null));
const pad2 = (n) => String(n).padStart(2, "0");
const fmt = (n) => (n == null ? "" : Number(n).toLocaleString("en-US"));
const pretty = (s) => String(s).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function cleanLabel(v) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  const s = String(v).replace(/[^\p{L}\p{N}]/gu, "").slice(0, 12);
  return s;
}
function firstName(v) {
  const t = (typeof v === "string" ? v : "").trim().split(/\s+/)[0] || "";
  return cleanLabel(t);
}

function isTyping(t) {
  if (!t || !t.closest) return false;
  if (t.isContentEditable) return true;
  return !!t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
}
const reduceMotion = () => safe(() => matchMedia("(prefers-reduced-motion: reduce)").matches, false);

// ------------------------------------------------------------------ demo flag
function readFlag() {
  const q = safe(() => new URLSearchParams(location.search).get("demo"), null);
  if (q === "1" || q === "true" || q === "on") { writeFlag(true); return true; }
  if (q === "0" || q === "false" || q === "off") { writeFlag(false); return false; }
  return safe(() => sessionStorage.getItem(STORE_KEY) === "1", false);
}
function writeFlag(on) { safe(() => sessionStorage.setItem(STORE_KEY, on ? "1" : "0")); }

// ------------------------------------------------------------------ aggregates (read once, cached)
let dataPromise = null;
function loadData() {
  if (!dataPromise) {
    dataPromise = fetch(DATA_URL, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => (j && typeof j === "object" ? j : null))
      .catch(() => null);
  }
  return dataPromise;
}

// counts can be {tag: n} or [{tag|topic|label|name, count}]
function countList(v, keys = ["tag", "topic", "label", "name", "id"]) {
  if (!v) return [];
  if (Array.isArray(v)) {
    return v.map((r) => {
      if (!r || typeof r !== "object") return null;
      const k = keys.map((x) => r[x]).find((x) => typeof x === "string" && x);
      const c = num(r.count);
      return k && c != null ? { key: k, count: c } : null;
    }).filter(Boolean);
  }
  if (typeof v === "object") {
    return Object.entries(v).map(([k, c]) => ({ key: k, count: num(c) })).filter((r) => r.count != null);
  }
  return [];
}

// ------------------------------------------------------------------ HUD views: each returns {sum, node} or null
function barRow(label, value, max, opts = {}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const row = h("div", { class: "demo-row" + (opts.muted ? " is-muted" : "") + (opts.cls ? " " + opts.cls : "") },
    h("span", { class: "demo-row__l", text: label, title: opts.title || label }),
    h("span", { class: "demo-row__v", text: opts.valueText != null ? opts.valueText : fmt(value) }),
    opts.flag ? h("span", { class: "demo-flag", text: opts.flag }) : null,
    h("span", { class: "demo-track", "aria-hidden": "true" }, h("span", { class: "demo-fill", style: "width:" + pct.toFixed(1) + "%" })));
  return row;
}
function bigStat(label, value, sub) {
  return h("div", { class: "demo-stat" },
    h("span", { class: "demo-stat__v", text: value }),
    h("span", { class: "demo-stat__l", text: label }),
    sub ? h("span", { class: "demo-stat__s", text: sub }) : null);
}
const section = (title, ...kids) => h("div", { class: "demo-sec" }, title ? h("p", { class: "demo-sec__t", text: title }) : null, ...kids);

// live clusters: the API's own topic counts (top 6, "other" bucket, folded line when the API reports suppressed groups)
function viewClustersLive(live) {
  const c = liveClusterRows(live);
  if (!c) return null;
  const max = Math.max(...c.rows.map((r) => r.count), c.other ? c.other.count : 0, 1);
  const node = section("Interest clusters", h("p", { class: "demo-src", text: "Live · opted-in attendees" }));
  for (const r of c.rows) node.append(barRow(r.label, r.count, max));
  if (c.other) node.append(barRow("Other (groups under 5)", c.other.count, max, { muted: true }));
  if (c.suppressedGroups > 0) node.append(h("p", { class: "demo-note", text: `${fmt(c.suppressedGroups)} ${c.suppressedGroups === 1 ? "group" : "groups"} under 5 folded into other` }));
  return { sum: `${c.rows.length} topics${c.other ? `, ${fmt(c.other.count)} in other` : ""}`, node, live: true };
}
function viewClusters(d, st) {
  if (st && st.agg) { const v = viewClustersLive(st.agg); if (v) return v; }
  const list = (Array.isArray(d.clusters) ? d.clusters : [])
    .map((c) => (c && typeof c === "object" && num(c.count) != null ? { id: String(c.id || ""), label: String(c.label || c.id || ""), count: num(c.count), tags: c.topTags } : null))
    .filter(Boolean);
  if (!list.length) return null;
  const main = list.filter((c) => c.id !== "other");
  const other = list.filter((c) => c.id === "other");
  const max = Math.max(...list.map((c) => c.count), 1);
  const node = section("Interest clusters");
  for (const c of main) node.append(barRow(c.label, c.count, max, { title: c.label + (Array.isArray(c.tags) && c.tags.length ? " (" + c.tags.slice(0, 3).join(", ") + ")" : "") }));
  for (const c of other) node.append(barRow("Other (groups under 5)", c.count, max, { muted: true }));
  const sg = num(d.suppressedGroups);
  if (sg != null) node.append(h("p", { class: "demo-note", text: `${fmt(sg)} ${sg === 1 ? "group" : "groups"} under 5 folded into other` }));
  const otherN = other.reduce((a, c) => a + c.count, 0);
  return { sum: `${main.length} clusters${other.length ? `, ${fmt(otherN)} in other` : ""}`, node };
}

function viewScan(d) {
  const s = d.scanTotals;
  if (!s || typeof s !== "object") return null;
  const allowed = num(s.allowed), denied = num(s.denied);
  if (allowed == null && denied == null) return null;
  const a = allowed || 0, dn = denied || 0, tot = a + dn;
  const node = section("Door scans");
  node.append(h("div", { class: "demo-pair" }, bigStat("Allowed", fmt(a)), bigStat("Denied", fmt(dn), tot ? Math.round((dn / tot) * 100) + "% of scans" : "")));
  node.append(h("div", { class: "demo-split", "aria-hidden": "true" },
    h("span", { class: "demo-split__a", style: "width:" + (tot ? (a / tot) * 100 : 0).toFixed(1) + "%" }),
    h("span", { class: "demo-split__d", style: "width:" + (tot ? (dn / tot) * 100 : 0).toFixed(1) + "%" })));
  const reasons = countList(s.byReason).sort((x, y) => y.count - x.count);
  if (reasons.length) {
    const rmax = Math.max(...reasons.map((r) => r.count), 1);
    node.append(h("p", { class: "demo-sec__t", text: "Denied because" }));
    for (const r of reasons) node.append(barRow(cap(pretty(r.key)), r.count, rmax));
  }
  return { sum: `${fmt(a)} allowed, ${fmt(dn)} denied`, node };
}

function slotsOf(d) {
  const rows = Array.isArray(d.roomOccupancy) ? d.roomOccupancy.filter((r) => r && typeof r === "object" && r.slot != null) : [];
  const slots = [];
  for (const r of rows) if (!slots.includes(String(r.slot))) slots.push(String(r.slot));
  return { rows, slots };
}
// live rooms: one coarse level per room from the door-scan route, drawn as text plus a 3-step bar. No counts exist.
function viewRoomsLive(live) {
  const rows = liveRoomRows(live.roomLevels, ROOM_LABELS);
  if (!rows.length) return null;
  const node = section("Room activity", h("p", { class: "demo-src", text: "Live · door scans, last 10 min" }));
  for (const r of rows) {
    const bar = h("span", { class: "demo-steps", role: "img", "aria-label": r.level, "data-step": String(r.step) });
    for (let i = 1; i <= ROOM_LEVEL_STEPS; i++) bar.append(h("span", { class: "demo-steps__s" + (i <= r.step ? " is-on" : "") }));
    node.append(h("div", { class: "demo-row demo-row--level", title: `${r.name}: ${r.level}` },
      h("span", { class: "demo-row__l", text: r.name }),
      h("span", { class: "demo-row__v", text: r.text }),
      bar));
  }
  const many = rows.filter((r) => r.step === ROOM_LEVEL_STEPS).length;
  return { sum: `${rows.length} ${rows.length === 1 ? "room" : "rooms"}${many ? `, ${many} with many recent check-ins` : ""}`, node, live: true };
}
function viewRooms(d, st) {
  if (st.agg) { const v = viewRoomsLive(st.agg); if (v) return v; }
  const { rows, slots } = slotsOf(d);
  if (!slots.length) return null;
  if (st.slot == null || !slots.includes(st.slot)) {
    let best = slots[0], bestN = -1;
    for (const sl of slots) {
      const n = rows.filter((r) => String(r.slot) === sl).reduce((a, r) => a + (num(r.scannedIn) || 0), 0);
      if (n > bestN) { bestN = n; best = sl; }
    }
    st.slot = best;
  }
  const i = slots.indexOf(st.slot);
  const mine = rows.filter((r) => String(r.slot) === st.slot);
  const max = Math.max(...mine.map((r) => Math.max(num(r.capacity) || 0, 0)), 1);
  const node = section("Room occupancy");
  const step = (dir, glyph, name) => h("button", { type: "button", class: "demo-step", "data-slot-step": dir, "aria-label": name, text: glyph });
  node.append(h("div", { class: "demo-stepper" }, step("-1", "‹", "Previous time slot"),
    h("span", { class: "demo-stepper__v" }, h("b", { text: st.slot }), h("span", { text: ` ${pad2(i + 1)} / ${pad2(slots.length)}` })),
    step("1", "›", "Next time slot")));
  let fulls = 0, scanned = 0;
  for (const r of mine) {
    const si = num(r.scannedIn) || 0, cp = num(r.capacity);
    const full = cp != null && cp > 0 && si >= cp;
    if (full) fulls++;
    scanned += si;
    const name = typeof r.room === "string" && r.room ? r.room : (ROOM_LABELS[r.sceneRoom] || cap(pretty(r.sceneRoom || "room")));
    node.append(barRow(name, si, max, { valueText: `${fmt(si)} / ${cp != null ? fmt(cp) : "?"}`, flag: full ? "Full" : "", cls: "demo-row--inline" + (full ? " is-full" : ""), title: `${name}: ${fmt(si)} scanned in of ${cp != null ? fmt(cp) : "?"}` }));
    // bar tracks scannedIn against capacity itself, not the largest room
    const f = node.lastChild.querySelector(".demo-fill");
    if (f && cp) f.style.width = Math.min(100, (si / cp) * 100).toFixed(1) + "%";
  }
  return { sum: `${st.slot}: ${fmt(scanned)} scanned in${fulls ? `, ${fulls} full` : ""}`, node };
}

function viewRegs(d, st) {
  const r = d.registrations && typeof d.registrations === "object" ? d.registrations : null;
  const live = st.live || 0;
  const node = section("Registrations");
  let total = null, sum = "";
  if (r) {
    total = num(r.total);
    const ret = num(r.returning);
    const via = countList(r.byVia || r.byMethod || r.bySignIn || r.byMethods, ["via", "method", "key", "id", "label"]).sort((a, b) => b.count - a.count);
    const stats = [];
    if (total != null) stats.push(bigStat("Registered", fmt(total)));
    if (ret != null && total) stats.push(bigStat("Returning", Math.round((ret / total) * 100) + "%", `${fmt(ret)} of ${fmt(total)}`));
    if (stats.length) node.append(h("div", { class: "demo-pair" }, ...stats));
    if (via.length) {
      const vmax = Math.max(...via.map((v) => v.count), 1);
      node.append(h("p", { class: "demo-sec__t", text: "Sign-in method" }));
      for (const v of via) node.append(barRow(VIA_LABELS[String(v.key).toLowerCase()] || cap(pretty(v.key)), v.count, vmax));
    }
    sum = total != null ? `${fmt(total)} registered` : "";
  }
  node.append(h("div", { class: "demo-live" + (live ? " is-on" : "") },
    h("span", { class: "demo-live__v", text: "+" + fmt(live) }),
    h("span", { class: "demo-live__l", text: "registered live in this session" })));
  sum = (sum ? sum + ", " : "") + `+${fmt(live)} live`;
  return { sum, node };
}

function viewOverview(d) {
  const n = num(d.attendeeCount);
  const topics = countList(d.topicCounts).filter((t) => t.key !== "other").sort((a, b) => b.count - a.count).slice(0, 5);
  if (n == null && !topics.length) return null;
  const node = section("Attendees");
  if (n != null) node.append(bigStat("Attendees", fmt(n)));
  if (topics.length) {
    const max = Math.max(...topics.map((t) => t.count), 1);
    node.append(h("p", { class: "demo-sec__t", text: "Top topics" }));
    for (const t of topics) node.append(barRow(t.key, t.count, max));
  }
  return { sum: `${n != null ? fmt(n) + " attendees" : "Attendees"}${topics.length ? ", top: " + topics[0].key : ""}`, node };
}

function viewFor(shot, d, st) {
  const data = d || {};
  if (shot === "clusters") return viewClusters(data, st);
  if (shot === "scan") return viewScan(data);
  if (shot === "schedule" || shot === "stage") return viewRooms(data, st);
  if (shot === "arrive" || shot === "host") return viewRegs(data, st);
  return viewOverview(data);
}

// ------------------------------------------------------------------ the instance
function enable() {
  if (reg.demo) return;
  const cleanups = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };
  const st = { guide: null, slot: null, live: 0, current: 0, pin: null, data: null, dataDone: false, stream: false, agg: null, aggVer: 0 };
  const recent = new Map();
  let toastTimer = 0, settleTimer = 0, raf = 0, es = null, bc = null, esErrors = 0, mo = null, aggTimer = 0, aggBusy = false;

  const page = /register\.html$/.test(location.pathname) ? "register" : /conference\.html$/.test(location.pathname) ? "conference" : "index";
  const dockTop = page === "register";

  // sections that carry a shot, in page order
  const sections = [...document.querySelectorAll("[data-venue-shot]")].filter((el) => el.isConnected);
  const shotOf = (el) => (el.getAttribute("data-venue-shot") || "overview").trim();
  const labelFor = (el) => {
    let t = "";
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    if (ids.length) t = ids.map((i) => (document.getElementById(i) || {}).textContent || "").join(" ");
    if (!t.trim()) { const hd = el.querySelector("h1, h2, h3"); t = hd ? hd.textContent : ""; }
    if (!t.trim()) t = el.getAttribute("aria-label") || "";
    t = t.replace(/\s+/g, " ").trim();
    if (!t) return cap(shotOf(el));
    if (t.length <= 18) return t;
    const cut = t.slice(0, 17);
    const sp = cut.lastIndexOf(" ");
    return (sp >= 9 ? cut.slice(0, sp) : cut).replace(/[\s.,:;-]+$/, "") + "…";
  };

  // ---- DOM
  const slug = safe(() => new URLSearchParams(location.search).get("c"), null)
    || safe(() => (document.querySelector("[data-chat][data-conference]") || {}).dataset.conference, null);
  const linkFor = (file) => file + "?demo=1" + (slug ? "&c=" + encodeURIComponent(slug) : "");

  const lamp = h("span", { class: "demo-lamp", "aria-hidden": "true" });
  const modeTxt = h("span", { class: "demo-mode", text: "Local" });
  const counter = h("span", { class: "demo-count", text: "" });
  const seen = new Set();
  const shotBtns = sections.map((el, i) => {
    let full = labelFor(el);
    if (seen.has(full.toLowerCase())) full = cap(shotOf(el)); // same heading twice: use the shot name
    seen.add(full.toLowerCase());
    const b = h("button", { type: "button", class: "demo-btn demo-btn--shot", "data-i": String(i), title: `${full} (${shotOf(el)})${i < 10 ? " – key " + ((i + 1) % 10) : ""}` },
      h("span", { class: "demo-btn__k", text: i < 10 ? String((i + 1) % 10) : "" }),
      h("span", { text: full }));
    return b;
  });
  const pauseBtn = h("button", { type: "button", class: "demo-btn", "data-act": "pause", text: "Pause" });
  const walkBtn = h("button", { type: "button", class: "demo-btn", "data-act": "walk", title: "Send a pixel person in (W)", text: "Walk-in" });
  const navBtn = h("button", { type: "button", class: "demo-btn", "data-act": "nav", hidden: true, "aria-expanded": "false", "aria-controls": "demo-nav", title: "Guide a person to a room (N)", text: "Navigate" });
  const keysBtn = h("button", { type: "button", class: "demo-btn", "data-act": "keys", "aria-expanded": "false", "aria-controls": "demo-legend", title: "Keyboard shortcuts (?)", text: "Keys" });
  const offBtn = h("button", { type: "button", class: "demo-btn", "data-act": "off", title: "Turn demo mode off (D)", text: "Off" });
  const mkLink = (file, text) => h("a", { class: "demo-btn demo-btn--link", href: linkFor(file), "aria-current": page === file.replace(/\.html$/, "") || (file === "index.html" && page === "index") ? "page" : null, text });
  const links = [mkLink("index.html", "Home"), mkLink("conference.html", "Conference"), mkLink("register.html", "Sign-up")];

  const bar = h("div", { class: "demo-bar", role: "toolbar", "aria-label": "Demo presenter controls" },
    sections.length ? h("div", { class: "demo-grp demo-grp--shots" }, ...shotBtns) : null,
    h("div", { class: "demo-grp demo-grp--id" }, lamp, h("span", { class: "demo-id", text: "DEMO" }), modeTxt, counter),
    h("div", { class: "demo-grp" }, pauseBtn, walkBtn, navBtn, keysBtn),
    h("div", { class: "demo-grp" }, ...links, offBtn));

  const legendRows = [
    ["1 – 9, 0", "Jump to shot 1 – 10"], ["←  →", "Previous / next shot (also PgUp / PgDn)"],
    ["P", "Pause / play the venue"], ["W", "Walk-in"], ["N", "Navigate: guide a person to a room"], ["[  ]", "Previous / next time slot"],
    ["?", "This list"], ["D", "Demo mode off"],
  ];
  const legend = h("div", { class: "demo-legend", id: "demo-legend", hidden: true, role: "group", "aria-label": "Keyboard shortcuts" },
    ...legendRows.map(([k, t]) => h("p", null, h("kbd", { text: k }), h("span", { text: t }))));
  const navList = h("div", { class: "demo-nav", id: "demo-nav", hidden: true, role: "group", "aria-label": "Guide a person to a room" },
    h("p", { class: "demo-sec__t", text: "Navigate to" }),
    h("div", { class: "demo-nav__rows" }, ...NAV_ROOMS.map(([to, name]) => h("button", { type: "button", class: "demo-btn demo-nav__b", "data-nav-to": to, text: name }))));
  const toast = h("div", { class: "demo-toast", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  const dock = h("div", { class: "demo-dock" }, toast, navList, legend, bar);

  const hudMode = h("span", { class: "demo-hud__mode", text: "Organiser view" });
  const hudSum = h("p", { class: "demo-hud__sum" });
  const hudBody = h("div", { class: "demo-hud__body" });
  const guideCard = h("div", { class: "demo-guide", hidden: true });
  const hudTag = h("span", { class: "demo-tag", text: TAG_SYNTH });
  const hud = h("aside", { class: "demo-hud", "aria-label": `Organiser overlay (${TAG_SYNTH.toLowerCase()})`, hidden: true },
    h("div", { class: "demo-hud__head" }, h("span", { class: "demo-lamp", "aria-hidden": "true" }), hudMode, hudTag),
    hudSum, guideCard, hudBody);

  const rootEl = h("div", { class: "demo" + (dockTop ? " demo--top" : "") + (document.querySelector(".hud-rail") ? " demo--rail" : ""), "data-demo-ui": "" }, hud, dock);
  document.body.append(rootEl);
  root.setAttribute("data-demo", "on");
  cleanups.push(() => { rootEl.remove(); root.removeAttribute("data-demo"); });

  // ---- shot tracking (scroll position is the truth; the scene follows the same scroll)
  function computeCurrent() {
    if (!sections.length) return 0;
    const mid = innerHeight / 2;
    let best = 0, bd = Infinity;
    sections.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }
  function currentIndex() { return st.pin ? st.pin.i : st.current; }
  function refresh() {
    raf = 0;
    st.current = computeCurrent();
    const i = currentIndex();
    shotBtns.forEach((b, k) => { if (k === i) b.setAttribute("aria-current", "true"); else b.removeAttribute("aria-current"); });
    counter.textContent = sections.length ? `${pad2(i + 1)} / ${pad2(sections.length)}` : "";
    syncNav();
    renderHud();
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(refresh); };
  function onScroll() {
    if (st.pin && st.pin.settled && Math.abs(scrollY - st.pin.y) > 40) st.pin = null;
    schedule();
  }
  on(window, "scroll", onScroll, { passive: true });
  on(window, "resize", schedule, { passive: true });
  on(document, "venue:shot", schedule);
  cleanups.push(() => { if (raf) cancelAnimationFrame(raf); clearTimeout(settleTimer); clearTimeout(toastTimer); });

  function go(i) {
    if (!sections.length) return;
    i = Math.max(0, Math.min(sections.length - 1, i));
    st.pin = { i, settled: false, y: 0 };
    const pin = st.pin;
    const settle = () => { if (st.pin === pin) { pin.settled = true; pin.y = scrollY; } };
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, reduceMotion() ? 120 : 1100);
    sections[i].scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "start" });
    schedule();
  }
  const step = (d) => go(currentIndex() + d);

  // ---- HUD
  let lastKey = "";
  function renderHud() {
    const i = currentIndex();
    const shot = sections.length ? shotOf(sections[i]) : "overview";
    const key = [shot, st.slot, st.live, st.dataDone ? 1 : 0, st.aggVer].join("|");
    if (key === lastKey) return;
    lastKey = key;
    let v = null;
    if (st.dataDone || st.agg || shot === "arrive" || shot === "host") v = safe(() => viewFor(shot, st.data, st), null);
    const tag = v && v.live ? TAG_LIVE : TAG_SYNTH;
    hudTag.textContent = tag;
    hud.setAttribute("aria-label", `Organiser overlay (${tag.toLowerCase()})`);
    hudMode.textContent = "Organiser view";
    renderGuide();
    const g = st.guide;
    if (!v) { hudBody.replaceChildren(); hudSum.textContent = g ? guideSummary() : ""; hud.hidden = !g; return; }
    hudBody.replaceChildren(v.node);
    hudSum.textContent = g ? guideSummary() : v.sum;
    hud.hidden = false;
  }
  // ---- navigate: scene guide(), the "Find my room" card
  const roomName = (to) => (NAV_ROOMS.find((r) => r[0] === to) || [])[1] || cap(pretty(to));
  const guideSummary = () => (st.guide.arrived ? `Arrived at ${st.guide.room}` : `Find my room: ${st.guide.room}`) + " (simulated signals)";
  function renderGuide() {
    const g = st.guide;
    if (!g) { guideCard.hidden = true; guideCard.replaceChildren(); return; }
    const to = g.to;
    const open = h("a", { class: "demo-btn demo-btn--link", href: "/navigate?to=" + encodeURIComponent(to), "data-app-link": "/navigate?to=" + encodeURIComponent(to), target: "_blank", rel: "noopener", text: "Open Find my room" });
    guideCard.replaceChildren(
      h("p", { class: "demo-sec__t", text: "Find my room" }),
      h("p", { class: "demo-guide__to" }, h("b", { text: g.room }), h("span", { text: g.arrived ? "Arrived" : "Walking there" })),
      h("p", { class: "demo-guide__src" }, h("span", { text: "Position from the venue's Bluetooth receivers" }), h("span", { class: "demo-tag", text: "Simulated signals" })),
      h("div", { class: "demo-guide__act" }, open, h("button", { type: "button", class: "demo-btn", "data-guide-clear": "", text: "Clear route" })));
    guideCard.hidden = false;
    safe(() => applyAppLinks(guideCard).catch(() => {}));
  }
  function setGuide(to, arrived) {
    if (typeof to !== "string" || !/^[\w-]{1,32}$/.test(to)) return;
    st.guide = { to, room: roomName(to), arrived: !!arrived };
    lastKey = ""; renderHud();
  }
  function clearGuideState() { if (st.guide) { st.guide = null; lastKey = ""; renderHud(); } }
  on(document, "venue:guide", (e) => { const d = e && e.detail; if (d) { setGuide(d.to, false); setNav(false); } });
  on(document, "venue:arrived", (e) => {
    const d = e && e.detail;
    if (!d || typeof d.to !== "string") return;
    setGuide(d.to, true);
    showToast(`Arrived at ${st.guide ? st.guide.room : roomName(d.to)}`);
  });
  on(guideCard, "click", (e) => {
    if (!e.target.closest("[data-guide-clear]")) return;
    safe(() => { const v = venueApi(); v && typeof v.clearGuide === "function" && v.clearGuide(); });
    clearGuideState();
  });
  cleanups.push(() => { if (st.guide) safe(() => { const v = venueApi(); v && typeof v.clearGuide === "function" && v.clearGuide(); }); });
  const canGuide = () => { const v = venueApi(); return !!v && typeof v.guide === "function"; };
  function syncNav() {
    const ok = canGuide();
    navBtn.hidden = !ok;
    if (!ok) setNav(false);
    if (!st.readyHooked) { const v = venueApi(); if (v && v.ready && typeof v.ready.then === "function") { st.readyHooked = true; v.ready.then(() => { if (reg.demo) syncNav(); }, () => {}); } }
  }
  function setNav(open) {
    if (open && !canGuide()) open = false;
    navList.hidden = !open;
    navBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  async function guideTo(to) {
    const v = venueApi();
    let ok = false;
    try { ok = !!(v && typeof v.guide === "function" && await v.guide({ to, label: "You" })); } catch { ok = false; }
    if (!reg.demo) return;
    if (!ok) { showToast(`${roomName(to)} is not in the scene`); return; }
    setNav(false);
    if (!st.guide || st.guide.to !== to || st.guide.arrived) setGuide(to, false); // venue:guide normally did this already
  }
  on(navList, "click", (e) => { const b = e.target.closest("[data-nav-to]"); if (b) guideTo(b.getAttribute("data-nav-to")); });

  on(hud, "click", (e) => {
    const b = e.target.closest("[data-slot-step]");
    if (!b) return;
    stepSlot(Number(b.getAttribute("data-slot-step")), true);
  });
  function stepSlot(dir, refocus) {
    if (!st.data) return;
    const { slots } = slotsOf(st.data);
    if (!slots.length) return;
    const i = Math.max(0, slots.indexOf(st.slot));
    st.slot = slots[(i + dir + slots.length) % slots.length];
    lastKey = "";
    renderHud();
    if (refocus) { const f = hud.querySelector("[data-slot-step='" + dir + "']"); if (f) f.focus(); }
  }
  loadData().then((d) => { st.data = d; st.dataDone = true; lastKey = ""; if (reg.demo) renderHud(); });

  // ---- real aggregates: on start and every 15 s; null (API down, not on the site, too few opted in) means synthetic
  const sameAgg = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function pollAggregates() {
    if (aggBusy) return;
    aggBusy = true;
    let next = null;
    try { next = await getLiveAggregates(); } catch { next = null; }
    aggBusy = false;
    if (!reg.demo || reg.demo.pollGen !== gen) return; // demo mode was turned off (or restarted) meanwhile
    if (!sameAgg(next, st.agg)) { st.agg = next; st.aggVer += 1; lastKey = ""; renderHud(); }
  }
  const gen = {};
  aggTimer = setInterval(pollAggregates, LIVE_POLL_MS);
  cleanups.push(() => clearInterval(aggTimer));

  // ---- scene controls
  const venueApi = () => { const host = document.querySelector("[data-venue]"); return host && host.venue ? host.venue : null; };
  function paused() { const s = root.getAttribute("data-venue-state"); return s ? s === "paused" : !!st.localPaused; }
  function syncPause() { pauseBtn.textContent = paused() ? "Play" : "Pause"; }
  function togglePause() {
    const v = venueApi();
    const was = paused();
    safe(() => (was ? v && v.play && v.play() : v && v.pause && v.pause()));
    if (!root.getAttribute("data-venue-state")) st.localPaused = !was;
    syncPause();
  }
  syncPause();
  if ("MutationObserver" in window) {
    mo = new MutationObserver(syncPause);
    mo.observe(root, { attributes: true, attributeFilter: ["data-venue-state"] });
    cleanups.push(() => mo.disconnect());
  }
  const spawn = (label) => document.dispatchEvent(new CustomEvent("venue:spawn", { detail: { label } }));
  const walkIn = () => spawn(WALKIN_NAMES[Math.floor(Math.random() * WALKIN_NAMES.length)]);

  // ---- legend
  function setLegend(open) {
    legend.hidden = !open;
    keysBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  // ---- toast + registration handling
  function showToast(text) {
    clearTimeout(toastTimer);
    toast.textContent = "";
    toast.classList.remove("is-on");
    // set text next frame so assistive tech sees a change in the live region
    requestAnimationFrame(() => {
      if (!reg.demo) return;
      toast.replaceChildren(h("span", { class: "demo-lamp", "aria-hidden": "true" }), h("span", { text }));
      toast.classList.add("is-on");
    });
    toastTimer = setTimeout(() => { toast.classList.remove("is-on"); toast.textContent = ""; }, TOAST_MS);
  }
  function registered(label, returning) {
    if (label != null && typeof label !== "string" && typeof label !== "number") return;
    label = cleanLabel(label) || "Guest";
    const k = label.toLowerCase();
    const now = Date.now();
    for (const [key, t] of recent) if (now - t > DEDUPE_MS) recent.delete(key);
    if (recent.has(k)) return;
    recent.set(k, now);
    st.live += 1;
    spawn(label);
    showToast(returning ? `${label} is back` : `${label} just registered`);
    lastKey = "";
    renderHud();
  }
  reg.demo = { registered, stepSlot, pollGen: gen };
  pollAggregates();

  // ---- live sources
  function openStream() {
    if (typeof EventSource !== "function") return;
    try {
      es = new EventSource(EVENTS_URL);
    } catch { es = null; return; }
    es.onopen = () => { esErrors = 0; st.stream = true; setMode(); };
    es.addEventListener("registered", (e) => {
      esErrors = 0;
      const j = safe(() => JSON.parse(e.data), null);
      if (j && typeof j === "object") registered(j.label, !!j.returning);
    });
    es.onerror = () => {
      esErrors += 1;
      st.stream = false; setMode();
      if (esErrors >= 3 || (es && es.readyState === 2)) { es.close(); es = null; }
    };
    cleanups.push(() => { if (es) { es.onopen = es.onerror = null; es.close(); es = null; } });
  }
  function setMode() {
    modeTxt.textContent = st.stream ? "Live" : "Local";
    lamp.classList.toggle("is-live", st.stream);
  }
  function openChannel() {
    if (typeof BroadcastChannel !== "function") return;
    try { bc = new BroadcastChannel(CHANNEL); } catch { bc = null; return; }
    bc.onmessage = (e) => {
      const m = e && e.data;
      if (m && typeof m === "object" && m.type === "registered") registered(m.label, !!m.returning);
    };
    cleanups.push(() => { if (bc) { bc.onmessage = null; bc.close(); bc = null; } });
  }
  openStream();
  openChannel();

  // ---- local registration (this tab finished the chat)
  const chat = document.querySelector("[data-chat]");
  if (chat) on(chat, "chat:done", (e) => { const n = firstName(e && e.detail && e.detail.profile && e.detail.profile.name); if (n) registered(n, false); });

  // ---- buttons
  on(bar, "click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.classList.contains("demo-btn--shot")) return go(Number(b.getAttribute("data-i")));
    const act = b.getAttribute("data-act");
    if (act === "pause") togglePause();
    else if (act === "walk") walkIn();
    else if (act === "nav") setNav(navList.hidden);
    else if (act === "keys") setLegend(legend.hidden);
    else if (act === "off") setDemo(false);
  });

  // ---- keyboard
  on(document, "keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    if (isTyping(e.target) || isTyping(document.activeElement)) return;
    const k = e.key;
    if (/^[0-9]$/.test(k)) {
      const i = k === "0" ? 9 : Number(k) - 1;
      if (i < sections.length) { e.preventDefault(); go(i); }
      return;
    }
    if (k === "ArrowRight" || k === "PageDown") { if (sections.length) { e.preventDefault(); step(1); } return; }
    if (k === "ArrowLeft" || k === "PageUp") { if (sections.length) { e.preventDefault(); step(-1); } return; }
    if (k === "p" || k === "P") { togglePause(); return; }
    if (k === "w" || k === "W") { walkIn(); return; }
    if (k === "[") { stepSlot(-1); return; }
    if (k === "]") { stepSlot(1); return; }
    if (k === "n" || k === "N") { syncNav(); setNav(navList.hidden); return; }
    if (k === "?") { setLegend(legend.hidden); return; }
    if (k === "Escape") { if (!legend.hidden) setLegend(false); if (!navList.hidden) setNav(false); }
  });

  setMode();
  refresh();

  reg.demo.destroy = () => { cleanups.splice(0).reverse().forEach((fn) => safe(fn)); reg.demo = null; };
}

function disable() { if (reg.demo) reg.demo.destroy(); }
function setDemo(on) { writeFlag(on); if (on) enable(); else disable(); }

// ------------------------------------------------------------------ always-on, invisible: the D key, and the sign-up broadcast
function onGlobalKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (isTyping(e.target) || isTyping(document.activeElement)) return;
  if (e.key === "d" || e.key === "D") setDemo(!reg.demo);
}
document.addEventListener("keydown", onGlobalKey);

// register.html: tell any other tab showing the venue that somebody finished the chat (first name only)
const chatSection = document.querySelector("[data-chat]");
if (chatSection) {
  chatSection.addEventListener("chat:done", (e) => {
    const name = firstName(e && e.detail && e.detail.profile && e.detail.profile.name);
    if (!name || typeof BroadcastChannel !== "function") return;
    safe(() => {
      const ch = new BroadcastChannel(CHANNEL);
      ch.postMessage({ type: "registered", label: name, returning: false });
      setTimeout(() => safe(() => ch.close()), 1000);
    });
  });
}

if (readFlag()) enable();
