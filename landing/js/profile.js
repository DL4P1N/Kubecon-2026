// profile.html: your kept profile and the conferences you registered for in THIS browser.
// Nothing here is server history: the API keeps one event and deletes attendee records after 24 hours.
// The first half of the file is pure (tested in test/profile-page.test.mjs); the DOM part runs only in a page.

export const KEPT_PROFILE_KEY = "cc.kept-profile.v1";
export const REGISTRATIONS_KEY = "cc.registrations.v1";
export const SHARES_KEY = "cc.invite-shares.v1";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ------------------------------------------------------------------ pure

/** Local calendar day as YYYY-MM-DD. */
export function isoToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Keeps well-formed `{slug, registeredAt}` rows, one per slug (first wins). */
export function parseRegistrations(raw) {
  const list = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return []; } })() : raw;
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== "object" || typeof r.slug !== "string" || !r.slug || seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push(r);
  }
  return out;
}

/** Appends a registration unless the slug is already there. Returns a new list. */
export function addRegistration(list, slug, registeredAt = new Date().toISOString()) {
  const rows = parseRegistrations(list);
  if (!slug || rows.some((r) => r.slug === slug)) return rows;
  return [...rows, { slug, registeredAt }];
}

const datesOf = (reg, c) => ({
  startDate: reg.startDate || c.startDate,
  endDate: reg.endDate || reg.startDate || c.endDate || c.startDate,
});

/**
 * Joins registrations with the catalogue and splits by day. A conference is upcoming until its last day is over
 * (so one running today is upcoming). Unknown slugs are dropped. Upcoming: soonest first. Past: latest first.
 */
export function splitRegistrations(regs, conferences, today) {
  const upcoming = [];
  const past = [];
  for (const reg of parseRegistrations(regs)) {
    const c = conferences.find((x) => x.slug === reg.slug);
    if (!c) continue;
    const d = datesOf(reg, c);
    const row = { conference: { ...c, ...d }, registeredAt: reg.registeredAt, sample: reg.sample === true };
    (d.endDate >= today ? upcoming : past).push(row);
  }
  upcoming.sort((a, b) => a.conference.startDate.localeCompare(b.conference.startDate));
  past.sort((a, b) => b.conference.startDate.localeCompare(a.conference.startDate));
  return { upcoming, past };
}

const shiftYear = (iso, years) => `${String(Number(iso.slice(0, 4)) + years).padStart(4, "0")}${iso.slice(4)}`;

/**
 * Sample rows: one upcoming and two past, all flagged `sample`. The catalogue starts today, so when it has no
 * ended conference the past rows reuse two other entries with their dates moved back whole years.
 */
export function sampleRegistrations(conferences, today, now = new Date().toISOString()) {
  const upcoming = conferences.find((c) => (c.endDate || c.startDate) >= today);
  const others = conferences.filter((c) => c !== upcoming);
  const rows = [];
  if (upcoming) rows.push({ slug: upcoming.slug, registeredAt: now, sample: true });
  let n = 0;
  for (const c of others) {
    if (n >= 2) break;
    let start = c.startDate;
    let end = c.endDate || c.startDate;
    let back = 0;
    while (end >= today && back < 10) { start = shiftYear(start, -1); end = shiftYear(end, -1); back++; }
    rows.push(back ? { slug: c.slug, registeredAt: now, sample: true, startDate: start, endDate: end } : { slug: c.slug, registeredAt: now, sample: true });
    n++;
  }
  return rows;
}

/** Adds sample rows without touching real ones or repeating a slug. */
export function mergeSamples(list, samples) {
  const rows = parseRegistrations(list);
  for (const s of samples) if (!rows.some((r) => r.slug === s.slug)) rows.push(s);
  return rows;
}

export const withoutSamples = (list) => parseRegistrations(list).filter((r) => r.sample !== true);

/** Absolute registration link for a conference, relative to the page it is built on. */
export function inviteUrl(base, slug) {
  const u = new URL("conference.html", String(base));
  u.search = "";
  u.hash = "";
  u.searchParams.set("c", slug);
  return u.href;
}

export function formatRange(startDate, endDate) {
  const part = (iso) => { const [y, m, d] = String(iso).split("-").map(Number); return { y, m: (m || 1) - 1, d: d || 1 }; };
  const a = part(startDate), b = part(endDate || startDate);
  if (a.y === b.y && a.m === b.m && a.d === b.d) return `${a.d} ${MONTHS[a.m]} ${a.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[a.m]} ${a.y}`;
  const from = a.y === b.y ? `${a.d} ${MONTHS[a.m]}` : `${a.d} ${MONTHS[a.m]} ${a.y}`;
  return `${from} – ${b.d} ${MONTHS[b.m]} ${b.y}`;
}

/** mailto: with subject and body filled and no recipient. Nothing is sent by this site. */
export function inviteMailto(conference, url) {
  const subject = `Join me at ${conference.name}`;
  const body = `${conference.name}, ${conference.city}, ${formatRange(conference.startDate, conference.endDate)}.\n\nRegister here: ${url}\n`;
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function bumpShare(counts, slug) {
  const base = counts && typeof counts === "object" && !Array.isArray(counts) ? counts : {};
  return { ...base, [slug]: (Number.isInteger(base[slug]) && base[slug] > 0 ? base[slug] : 0) + 1 };
}

/**
 * Deep link into the native iPhone app: confcompanion://ticket?c=<slug>&name=..&role=..&interests=a,b
 * Every value is percent-encoded; name and role are capped at 80 characters, interests at 12; empty values are left out.
 * The comma between interests is the one literal comma, each interest is encoded on its own.
 */
export function appTicketUrl({ slug, name, role, interests } = {}) {
  const cap = (v) => String(v ?? "").trim().slice(0, 80);
  const parts = [];
  const add = (k, v) => { if (v) parts.push(`${k}=${v}`); };
  add("c", encodeURIComponent(String(slug ?? "").trim()));
  add("name", encodeURIComponent(cap(name)));
  add("role", encodeURIComponent(cap(role)));
  const list = (Array.isArray(interests) ? interests : []).map((t) => String(t ?? "").trim()).filter(Boolean).slice(0, 12);
  add("interests", list.map(encodeURIComponent).join(","));
  return `confcompanion://ticket${parts.length ? `?${parts.join("&")}` : ""}`;
}

export const shareLabel = (n) => (n === 1 ? "Shared 1 time" : `Shared ${n} times`);

// ------------------------------------------------------------------ the page

if (typeof document !== "undefined" && document.querySelector("[data-pf]")) {
  start();
}

async function start() {
  const [{ loadConferences }, { drawQr }, { applyAppLinks }, wifi] = await Promise.all([
    import("./conferences.js"), import("./qr.js"), import("./companion-api.js"), import("./wifi.js"),
  ]);
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const store = {
    get(key, fallback) { try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } },
  };
  const here = $("a.nav__link[href='profile.html']");
  if (here) here.setAttribute("aria-current", "page");

  let conferences = [];
  try { conferences = await loadConferences(); } catch { conferences = []; }
  let uid = 0;

  // ---- header block
  function renderProfile() {
    const box = $("[data-pf-profile]");
    const p = store.get(KEPT_PROFILE_KEY, null);
    if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.name.trim()) {
      const msg = el("p", "pf-lead", "No profile yet. Register for a conference and answer a few questions; your profile is kept in this browser for the next one.");
      const row = el("div", "btn-row");
      const a = el("a", "btn btn--primary", "Register for a conference");
      a.href = "index.html#conferences";
      row.append(a);
      box.replaceChildren(msg, row);
      return;
    }
    const dl = el("dl", "pf-facts");
    const add = (term, node) => { const g = el("div"); g.append(el("dt", "", term), Object.assign(el("dd"), {})); g.lastChild.append(node); dl.append(g); };
    add("Name", el("span", "pf-name", p.name));
    if (p.role) add("Role", document.createTextNode(p.role));
    if (Array.isArray(p.interests) && p.interests.length) {
      const ul = el("ul", "pf-chips");
      for (const t of p.interests) ul.append(el("li", "pf-chip", String(t)));
      add("Interests", ul);
    }
    if (p.goal) add("Goal", document.createTextNode(p.goal));
    box.replaceChildren(dl);
  }

  // ---- lists
  function actionLink(label, appPath, cls = "btn btn--secondary") {
    const a = el("a", cls, label);
    a.setAttribute("data-app-link", appPath);
    a.href = appPath;
    return a;
  }

  function togglePanel(row, panel, btn, build) {
    const open = btn.getAttribute("aria-expanded") === "true";
    for (const b of row.querySelectorAll("[data-pf-toggle]")) b.setAttribute("aria-expanded", "false");
    if (open) { panel.hidden = true; panel.replaceChildren(); return; }
    panel.hidden = false;
    panel.id = panel.id || `pf-panel-${++uid}`;
    btn.setAttribute("aria-controls", panel.id);
    btn.setAttribute("aria-expanded", "true");
    build(panel);
  }

  function buildInvite(panel, c) {
    const url = inviteUrl(location.href, c.slug);
    const id = `pf-link-${++uid}`;
    const label = el("label", "t-label", "Registration link");
    label.htmlFor = id;
    const input = el("input", "pf-input");
    input.id = id; input.readOnly = true; input.value = url;
    input.addEventListener("focus", () => input.select());
    const status = el("p", "pf-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const shares = el("p", "pf-shares");
    const showShares = () => { const n = (store.get(SHARES_KEY, {}) || {})[c.slug]; shares.textContent = n > 0 ? shareLabel(n) : ""; };
    const count = () => { store.set(SHARES_KEY, bumpShare(store.get(SHARES_KEY, {}), c.slug)); showShares(); };
    const say = (t) => { status.textContent = ""; setTimeout(() => { status.textContent = t; }, 30); };

    const copy = el("button", "btn btn--primary", "Copy link");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      const ok = await wifi.copyText(url);
      if (ok) { count(); say("Link copied"); } else { input.focus(); say("Copy failed. The link is selected: copy it by hand."); }
    });
    const mail = el("a", "btn btn--secondary", "Email the link");
    mail.href = inviteMailto(c, url);
    const actions = el("div", "pf-actions");
    actions.append(copy, mail);
    if (typeof navigator.share === "function") {
      const share = el("button", "btn btn--secondary", "Share link");
      share.type = "button";
      share.addEventListener("click", async () => {
        try { await navigator.share({ title: c.name, text: `Join me at ${c.name}`, url }); count(); say("Link shared"); } catch { /* cancelled */ }
      });
      actions.append(share);
    }
    const frame = el("span", "pxframe pf-qr");
    const inner = el("span", "pxframe__in");
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-qr", "");
    inner.append(canvas); frame.append(inner);
    try { drawQr(canvas, url, { scale: 4, label: `QR code that opens the registration page for ${c.name}.` }); } catch { /* blank */ }
    showShares();
    const text = el("div", "pf-panel__text");
    text.append(label, input, actions, status, shares);
    panel.replaceChildren(text, frame);
    panel.dataset.kind = "invite";
  }

  function buildWifi(panel, c) {
    const box = el("div", "wifi");
    wifi.renderWifi(box, c.wifi, { scale: 4 });
    panel.replaceChildren(box);
    panel.dataset.kind = "wifi";
  }

  function rowFor(r, isUpcoming) {
    const c = r.conference;
    const li = el("li", "pf-row");
    const head = el("div", "pf-row__head");
    const title = el("p", "pf-row__name");
    title.append(document.createTextNode(c.name));
    if (r.sample) title.append(el("span", "pf-tag", "Sample"));
    head.append(title, el("p", "pf-row__meta", `${c.city} · ${formatRange(c.startDate, c.endDate)}`));
    const actions = el("div", "pf-actions");
    const panel = el("div", "pf-panel");
    panel.hidden = true;
    const toggle = (label, build) => {
      const b = el("button", "btn btn--secondary", label);
      b.type = "button";
      b.setAttribute("data-pf-toggle", "");
      b.setAttribute("aria-expanded", "false");
      b.addEventListener("click", () => togglePanel(li, panel, b, (p) => build(p, c)));
      return b;
    };
    if (isUpcoming) {
      const reg = el("a", "btn btn--secondary", "Show ticket");
      reg.href = `register.html?c=${encodeURIComponent(c.slug)}`;
      actions.append(actionLink("Open schedule", "/schedule", "btn btn--primary"), actionLink("Find my room", "/navigate"), reg);
      if (wifi.hasWifi(c)) actions.append(toggle("Join venue Wi-Fi", buildWifi));
      actions.append(toggle("Invite", buildInvite));
      const app = el("a", "btn btn--secondary", "Open in the app");
      const kept = store.get(KEPT_PROFILE_KEY, null) || {};
      app.href = appTicketUrl({ slug: c.slug, name: kept.name, role: kept.role, interests: kept.interests });
      actions.append(app);
    } else {
      const a = el("a", "btn btn--secondary", "Conference page");
      a.href = `conference.html?c=${encodeURIComponent(c.slug)}`;
      actions.append(a);
    }
    li.append(head, actions, panel);
    return li;
  }

  function renderLists() {
    const regs = parseRegistrations(store.get(REGISTRATIONS_KEY, []));
    const { upcoming, past } = splitRegistrations(regs, conferences, isoToday());
    const fill = (sel, rows, isUp, empty) => {
      const ul = $(sel);
      ul.replaceChildren(...(rows.length ? rows.map((r) => rowFor(r, isUp)) : [Object.assign(el("li", "pf-empty"), { textContent: empty })]));
    };
    fill("[data-pf-upcoming]", upcoming, true, "No upcoming conferences.");
    fill("[data-pf-past]", past, false, "No past conferences.");
    $("[data-pf-clear]").hidden = !regs.some((r) => r.sample === true);
    applyAppLinks($("[data-pf]")).catch(() => {});
  }

  $("[data-pf-sample]").addEventListener("click", () => {
    store.set(REGISTRATIONS_KEY, mergeSamples(store.get(REGISTRATIONS_KEY, []), sampleRegistrations(conferences, isoToday())));
    renderLists();
  });
  $("[data-pf-clear]").addEventListener("click", () => {
    store.set(REGISTRATIONS_KEY, withoutSamples(store.get(REGISTRATIONS_KEY, [])));
    renderLists();
  });

  renderProfile();
  renderLists();
}
