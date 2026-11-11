// Glue for register.html. js/chat.js owns the conversation; this file only reads what it exposes
// (section[data-state], section[data-mode], the chat:done event) and dresses the page around it:
// the honest mode line, a "host is typing" line, the ticket's structure, the venue shot, the phone keyboard.
// It never writes into the log and never touches chat.js. Everything here is text via textContent.

import { drawQr } from "./qr.js";
import { addRegistration, appTicketUrl, REGISTRATIONS_KEY, KEPT_PROFILE_KEY } from "./profile.js";
import { loadConferences, getConference } from "./conferences.js";
import { renderWifi, hasWifi } from "./wifi.js";
import { readAvatar } from "./avatar.js";
import { readLinked, providerName } from "./accounts.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const root = document.documentElement;
const section = $("[data-chat]");

if (section) {
  const params = new URLSearchParams(location.search);
  const slug = params.get("c") || section.dataset.conference || "cloud-native-hackathon-slc-2026";
  const log = $("[data-chat-log]", section);
  const input = $("[data-chat-input]", section);
  const modeEl = $("[data-chat-mode]", section);
  const waitEl = $("[data-chat-wait]", section);
  const ticketEl = $("[data-chat-ticket]", section);
  const verb = $("[data-reg-verb]");

  // ---------------------------------------------------------------- the mode line: says what is answering, nothing more
  const MODE_TEXT = { claude: "Answers by Claude Haiku", scripted: "Scripted questions" };
  const STATE_TEXT = { loading: "Starting the chat" };
  function syncStatus() {
    const mode = section.dataset.mode;
    const state = section.dataset.state;
    if (modeEl) modeEl.textContent = MODE_TEXT[mode] ?? STATE_TEXT[state] ?? "Starting the chat";
    if (waitEl) {
      let text = "";
      if (state === "waiting") text = $("[data-pending]", log) ? "The host is typing" : "Registering you";
      waitEl.textContent = text;
    }
  }

  // ---------------------------------------------------------------- the ticket: structure, chips, QR size, venue shot, focus
  const FIELD_KEYS = { Name: "name", Role: "role", Goal: "goal", Interests: "interests", Ticket: "ticket", Expires: "expires" };
  const FIELD_ORDER = ["name", "role", "goal", "interests", "ticket", "expires"];
  let lastDetail = null;

  function enhanceTicket(detail) {
    const dl = $("[data-ticket-fields]", ticketEl);
    if (!dl || dl.dataset.enhanced === "true") return;
    const dts = $$(":scope > dt", dl);
    if (!dts.length) return;
    const groups = new Map();
    for (const dt of dts) {
      const dd = dt.nextElementSibling;
      if (!dd || dd.tagName !== "DD") continue;
      const key = FIELD_KEYS[dt.textContent.trim()] ?? dt.textContent.trim().toLowerCase().replace(/\W+/g, "-");
      const g = document.createElement("div");
      g.dataset.field = key;
      g.append(dt, dd);
      groups.set(key, g);
    }
    // interests as chips, from the profile chat.js reports (the dd keeps the same words for assistive tech)
    const interests = detail?.profile?.interests;
    const interestsDd = $("dd", groups.get("interests") ?? document.createElement("div"));
    if (interestsDd && Array.isArray(interests) && interests.length) {
      const ul = document.createElement("ul");
      ul.className = "tk-chips";
      for (const tag of interests) {
        const li = document.createElement("li");
        li.className = "tk-chip";
        li.textContent = String(tag);
        ul.append(li);
      }
      interestsDd.replaceChildren(ul);
    }
    const ticketGroup = groups.get("ticket");
    if (ticketGroup && detail?.ticket) ticketGroup.dataset.source = detail.ticket.source === "api" ? "api" : "local";
    const ordered = [...FIELD_ORDER.filter((k) => groups.has(k)), ...[...groups.keys()].filter((k) => !FIELD_ORDER.includes(k))];
    dl.replaceChildren(...ordered.map((k) => groups.get(k)));
    dl.dataset.enhanced = "true";
  }

  // re-draw the QR at a whole-number scale that fits the frame (a long real token makes a bigger code than the demo token)
  function fitQr(detail) {
    const canvas = $("canvas[data-qr]", ticketEl);
    const token = detail?.ticket?.token;
    if (!canvas || typeof token !== "string") return;
    const target = matchMedia("(max-width: 759px)").matches ? 150 : window.innerHeight < 820 ? 175 : window.innerWidth >= 1280 ? 252 : 224;
    const current = Math.max(1, parseInt(canvas.dataset.qrScale, 10) || 5);
    const total = Math.round(parseFloat(canvas.style.width) / current);
    if (!total) return;
    const scale = Math.max(2, Math.floor(target / total));
    try {
      canvas.dataset.qrScale = String(scale);
      drawQr(canvas, token, { scale, label: "Your ticket QR code. Scanning it reads your ticket code." });
    } catch { /* keep the first drawing */ }
  }

  // ---------------------------------------------------------------- the venue Wi-Fi: replaces the door QR in place, and back (a ticket exists, so the visitor is registered)
  async function addWifi() {
    const next = $(".reg__next", ticketEl);
    if (!next || $("[data-wifi-open]", ticketEl)) return;
    try { await loadConferences(); } catch { /* the inlined catalogue answers */ }
    const c = getConference(slug);
    if (!hasWifi(c)) return;
    const open = document.createElement("button");
    open.type = "button"; open.className = "btn btn--secondary"; open.textContent = "Join venue Wi-Fi";
    open.setAttribute("data-wifi-open", ""); open.setAttribute("aria-expanded", "false");
    const panel = document.createElement("div");
    panel.className = "reg__wifi"; panel.hidden = true;
    const box = document.createElement("div");
    box.className = "wifi";
    renderWifi(box, c.wifi, { scale: 4 });
    const back = document.createElement("button");
    back.type = "button"; back.className = "btn btn--secondary"; back.textContent = "Show door ticket";
    $(".wifi__row", box)?.append(back);
    panel.append(box);
    ticketEl.insertBefore(panel, next);
    const show = (on) => {
      panel.hidden = !on;
      ticketEl.classList.toggle("is-wifi", on);
      open.setAttribute("aria-expanded", String(on));
      (on ? back : open).focus({ preventScroll: true });
    };
    open.addEventListener("click", () => show(true));
    back.addEventListener("click", () => show(false));
    next.prepend(open);
  }

  // "Open in the app": a plain link to the iPhone app (confcompanion://), built from the kept profile; nothing happens where the app is missing
  function addAppLink() {
    const next = $(".reg__next", ticketEl);
    if (!next || $("[data-app-open]", ticketEl)) return;
    let kept = null;
    try { kept = JSON.parse(localStorage.getItem(KEPT_PROFILE_KEY) || "null"); } catch { /* storage unavailable */ }
    const p = kept && typeof kept === "object" ? kept : lastDetail?.profile ?? {};
    const a = document.createElement("a");
    a.className = "link";
    a.textContent = "Open in the app";
    a.setAttribute("data-app-open", "");
    a.href = appTicketUrl({ slug, name: p.name, role: p.role, interests: p.interests, avatar: readAvatar() });
    next.insertBefore(a, $(".reg__again", next));
  }

  function onDone(detail) {
    lastDetail = detail ?? lastDetail;
    enhanceTicket(lastDetail);
    fitQr(lastDetail);
    addWifi();
    addAppLink();
    if (verb) verb.textContent = "Your ticket for";
    // the camera leaves the host desk for the schedule (scene/venue.js reads the attribute; goTo is the explicit call)
    section.setAttribute("data-venue-shot", "schedule");
    try { $("[data-venue]")?.venue?.goTo?.("schedule"); } catch { /* the scene is not ready */ }
    // the disabled input dropped the focus: put it on the ticket so a screen reader hears "Your ticket" and a keyboard stays inside the panel
    if (ticketEl && (document.activeElement === document.body || document.activeElement === null)) {
      try { ticketEl.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
  }
  section.addEventListener("chat:done", (e) => {
    // remember this registration in this browser (profile.html lists it); one row per conference
    try {
      const rows = JSON.parse(localStorage.getItem(REGISTRATIONS_KEY) || "[]");
      const kept = Array.isArray(rows) ? rows.filter((r) => !(r && r.slug === slug && r.sample === true)) : [];
      localStorage.setItem(REGISTRATIONS_KEY, JSON.stringify(addRegistration(kept, slug)));
    } catch { /* storage unavailable */ }
    onDone(e.detail);
  });

  // ---------------------------------------------------------------- one observer for state and mode
  let focused = false;
  const watch = new MutationObserver(() => {
    syncStatus();
    const state = section.dataset.state;
    if (state === "done" && ticketEl && !ticketEl.hidden && !$("dl[data-enhanced]", ticketEl)) onDone(lastDetail);
    // first reply on a desktop: the input is the one control on the screen, so it takes the focus once (never on a phone: it would raise the keyboard)
    if (state === "ready" && !focused && input && matchMedia("(hover: hover) and (pointer: fine)").matches
        && (document.activeElement === document.body || document.activeElement === null)) {
      focused = true;
      input.focus({ preventScroll: true });
    }
  });
  watch.observe(section, { attributes: true, attributeFilter: ["data-state", "data-mode"] });
  // the static "typing" bubble stands in until chat.js adds its own first message
  if (log) new MutationObserver(() => { const boot = $("[data-boot]", log); if (boot && log.children.length > 1) boot.remove(); }).observe(log, { childList: true });
  if (log) new MutationObserver(syncStatus).observe(log, { childList: true, attributes: true, subtree: true, attributeFilter: ["data-pending"] });
  syncStatus();

  // ---------------------------------------------------------------- start again: forget this tab's transcript, then reload
  for (const btn of $$("[data-chat-restart]")) {
    btn.addEventListener("click", () => {
      try { sessionStorage.removeItem("cc.chat.v1." + slug); } catch { /* storage unavailable */ }
      location.reload();
    });
  }

  // ---------------------------------------------------------------- OAuth identity: display provider-supplied name; the server verifies the link.
  const VIA = { github: "GitHub", google: "Google", linkedin: "LinkedIn" };
  const viaEl = $("[data-reg-via]");
  const via = params.get("via");
  const linkedVia = via && VIA[via] ? readLinked()[via] : null;
  if (viaEl && linkedVia) {
    viaEl.textContent = `Signed in as ${linkedVia.displayName} via ${providerName(via)}. We will start with this name; tell the host if you want to change it.`;
    viaEl.setAttribute("data-signed", "");
    viaEl.hidden = false;
  } else if (viaEl && via && (VIA[via] || via === "qr")) {
    viaEl.textContent = via === "qr"
      ? "You opened this page from a QR code."
      : `You came from the ${VIA[via]} sign-in button, but no verified account was found.`;
    viaEl.hidden = false;
  }

  // ---------------------------------------------------------------- phone keyboard: size the screen to the visible viewport so the form stays on it
  const vv = window.visualViewport;
  if (vv) {
    const narrow = matchMedia("(max-width: 759px)");
    const fit = () => {
      const kbd = narrow.matches && window.innerHeight - vv.height > 120;
      if (kbd) {
        root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
        root.setAttribute("data-kbd", "");
        window.scrollTo(0, 0);
      } else {
        root.style.removeProperty("--vvh");
        root.removeAttribute("data-kbd");
      }
    };
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", () => { if (root.hasAttribute("data-kbd")) window.scrollTo(0, 0); });
    fit();
  }
}
