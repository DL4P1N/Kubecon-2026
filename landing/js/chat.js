// Registration chat widget. Auto-binds to every [data-chat] on DOM ready. Plain ES module, no dependencies.
// Markup contract and events are documented in landing/README.md.
//
// Message text (the visitor's and the model's) only ever goes through textContent.

import { drawQr } from "./qr.js";
import { DEFAULT_SLUG, getConference, loadConferences } from "./conferences.js";
import { completeSignup, fetchAccessToken, onReady, sendChat, sessionToken } from "./companion-api.js";
import { LIMITS, VIA_VALUES, createSelection, parseConfirmChoice, scriptedTurn, validateKnown, validateProfile } from "./chat-script.js";

export const MAX_INPUT_CHARS = 1000;
const STORE_PREFIX = "cc.chat.v1.";
/** localStorage key of the "kept profile". Simulated cross-event memory: it lives only in this browser. */
export const KEPT_PROFILE_KEY = "cc.kept-profile.v1";

const GROUP_LABELS = {
  topics: "Choose 1 to 6 topics",
  goal: "What you want out of the day",
  confirm: "Registration options",
};

const humanise = (slug) => slug.replace(/-+/g, " ").replace(/\b\d{4}\b/g, "").replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());

function storageGet(key) {
  try { return JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch { return null; }
}
function storageSet(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: no resume */ }
}

function loadKept() {
  try {
    const raw = localStorage.getItem(KEPT_PROFILE_KEY);
    if (!raw) return null;
    const checked = validateKnown(JSON.parse(raw));
    return checked.ok ? checked.profile : null;
  } catch {
    return null;
  }
}

function saveKept(profile) {
  // Called on every completed registration.
  try { localStorage.setItem(KEPT_PROFILE_KEY, JSON.stringify(profile)); } catch { /* storage unavailable */ }
}

/** Forgets the kept profile in this browser (used by "Start over"). */
export function forgetKeptProfile() {
  try { localStorage.removeItem(KEPT_PROFILE_KEY); } catch { /* ignore */ }
}

function pair(dl, term, value) {
  const dt = document.createElement("dt");
  dt.textContent = term;
  const dd = document.createElement("dd");
  dd.textContent = value;
  dl.append(dt, dd);
}

function formatExpiry(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
}

export async function bindChat(section) {
  if (section.dataset.chatBound) return;
  section.dataset.chatBound = "true";

  const log = section.querySelector("[data-chat-log]");
  const form = section.querySelector("[data-chat-form]");
  const input = section.querySelector("[data-chat-input]");
  const submit = form?.querySelector('[type="submit"], button:not([type])') ?? null;
  const ticketEl = section.querySelector("[data-chat-ticket]");
  if (!log || !form || !input) return;

  const params = new URLSearchParams(location.search);
  const slug = params.get("c") || section.dataset.conference || DEFAULT_SLUG;
  const viaParam = params.get("via");
  const via = VIA_VALUES.includes(viaParam) ? viaParam : null;
  const storeKey = STORE_PREFIX + slug;

  const setState = (v) => { section.dataset.state = v; };
  setState("loading");
  if (!input.hasAttribute("maxlength")) input.setAttribute("maxlength", String(MAX_INPUT_CHARS));
  input.disabled = true;
  if (submit) submit.disabled = true;

  await loadConferences().catch(() => {});
  const confInfo = getConference(slug);
  const conference = { slug, name: confInfo?.name ?? humanise(slug) };
  const conferenceTopics = confInfo?.topics ?? [];

  // Quick-reply container: the page's [data-chat-choices], or one created just before the form.
  let choices = section.querySelector("[data-chat-choices]");
  if (!choices) {
    choices = document.createElement("div");
    choices.setAttribute("data-chat-choices", "");
    form.before(choices);
  }
  choices.hidden = true;

  const s = {
    messages: [], local: false, mode: null, done: false, profile: null, ticket: null, busy: false, interacted: false,
    known: null, // kept profile from this browser, while this conversation is a returning-visitor one
    ask: null, // { kind, options, selected, picked } while chips are showing
  };
  const persist = () =>
    storageSet(storeKey, {
      messages: s.messages, local: s.local, mode: s.mode, done: s.done, profile: s.profile, ticket: s.ticket,
      returning: Boolean(s.known), ask: s.ask,
    });

  function addMessage(role, text, pending = false) {
    const li = document.createElement("li");
    li.className = "chat-msg";
    li.dataset.role = role;
    if (pending) li.setAttribute("data-pending", "");
    const p = document.createElement("p");
    p.textContent = text;
    li.append(p);
    log.append(li);
    scroll(li);
    return li;
  }

  function scroll(li) {
    try { log.scrollTop = log.scrollHeight; } catch { /* ignore */ }
    try { li?.scrollIntoView?.({ block: "nearest" }); } catch { /* ignore */ }
  }

  function lock(on) {
    s.busy = on;
    input.disabled = on || s.done;
    if (submit) submit.disabled = on || s.done;
    log.setAttribute("aria-busy", on ? "true" : "false");
  }

  function setMode(mode) {
    s.mode = mode;
    section.dataset.mode = mode;
  }

  // ------------------------------------------------------------ quick replies

  let sel = null; // createSelection() for topics / goal asks
  const note = () => choices.querySelector("[data-chat-choices-note]");
  const say = (text) => { const n = note(); if (n && n.textContent !== text) n.textContent = text; };

  function makeChip(text, custom) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chat-chip";
    b.setAttribute("aria-pressed", "false");
    if (custom) b.setAttribute("data-custom", "");
    b.textContent = text;
    return b;
  }

  /** Brings the DOM in line with `sel`: creates chips for new custom items, sets aria-pressed / aria-disabled. */
  function syncChips() {
    if (!sel) return;
    const group = choices.querySelector('[role="group"]');
    const have = new Map([...group.querySelectorAll(".chat-chip")].map((c) => [c.textContent, c]));
    for (const item of sel.items) {
      let chip = have.get(item.text);
      if (!chip) { chip = makeChip(item.text, item.custom); group.append(chip); }
      chip.setAttribute("aria-pressed", item.pressed ? "true" : "false");
      if (sel.atCap() && !item.pressed) chip.setAttribute("aria-disabled", "true");
      else chip.removeAttribute("aria-disabled");
    }
    if (sel.kind === "topics") say(sel.atCap() ? `That is the maximum of ${sel.max} topics. Unselect one to add another.` : "");
    if (s.ask) { s.ask.picked = sel.pressed(); persist(); }
  }

  function addCustom() {
    const field = choices.querySelector("[data-chat-custom]");
    if (!field || !sel) return;
    const raw = field.value;
    field.value = "";
    const r = sel.addCustom(raw);
    syncChips();
    if (r.error === "invalid") say("I can't use that one. Try a short topic like observability.");
    else if (r.error === "cap") say(`That is the maximum of ${sel.max} topics. Unselect one to add another.`);
    field.focus();
  }

  function renderChoices() {
    const ask = s.ask;
    choices.replaceChildren();
    sel = null;
    if (!ask) { choices.hidden = true; delete section.dataset.ask; return; }
    const group = document.createElement("div");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", GROUP_LABELS[ask.kind] ?? "Quick replies");
    const n = document.createElement("p");
    n.className = "chat-choices-note";
    n.setAttribute("data-chat-choices-note", "");
    n.setAttribute("aria-live", "polite");
    choices.append(group, n);
    if (ask.kind === "topics" || ask.kind === "goal") {
      sel = createSelection({ kind: ask.kind, options: ask.options, selected: ask.picked ?? ask.selected ?? [] });
    } else {
      for (const opt of ask.options) group.append(makeChip(opt, false));
    }
    if (ask.kind === "topics") {
      const row = document.createElement("div");
      row.className = "chat-custom";
      const field = document.createElement("input");
      field.type = "text";
      field.setAttribute("data-chat-custom", "");
      field.setAttribute("aria-label", "Add your own topic");
      field.setAttribute("autocomplete", "off");
      field.setAttribute("maxlength", String(LIMITS.tag));
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); addCustom(); }
      });
      const add = document.createElement("button");
      add.type = "button";
      add.setAttribute("data-chat-custom-add", "");
      add.textContent = "Add";
      add.addEventListener("click", addCustom);
      row.append(field, add);
      choices.append(row);
    }
    choices.hidden = false;
    section.dataset.ask = ask.kind;
    syncChips();
  }

  function showAsk(res) {
    s.ask = res.ask && res.options?.length
      ? { kind: res.ask, options: res.options, selected: res.selected ?? [], picked: null }
      : null;
    renderChoices();
  }

  function clearChoices() {
    s.ask = null;
    renderChoices();
  }

  choices.addEventListener("click", (e) => {
    const chip = e.target.closest?.(".chat-chip");
    if (!chip || !s.ask || s.busy || s.done) return;
    if (chip.getAttribute("aria-disabled") === "true") return;
    if (!sel) { send(chip.textContent); return; } // confirm: one tap sends
    sel.toggle(chip.textContent);
    syncChips();
  });

  // ------------------------------------------------------------------ ticket

  /**
   * The check-in token the QR carries lasts about a minute (POST /api/access/token). While the ticket is on screen,
   * fetch a new one shortly before it expires and redraw. Stops quietly if the session is gone.
   */
  let qrTimer = null;
  function keepQrFresh(draw, canvas) {
    clearTimeout(qrTimer);
    const ticket = s.ticket;
    const schedule = () => {
      const left = Date.parse(ticket.qrExpiresAt) - Date.now();
      const wait = Number.isFinite(left) ? Math.max(1000, left - 10_000) : 0;
      qrTimer = setTimeout(refresh, wait);
    };
    const refresh = async () => {
      const attendeeToken = sessionToken();
      if (!attendeeToken || s.ticket !== ticket) return;
      try {
        const next = await fetchAccessToken(attendeeToken);
        ticket.token = next.token;
        ticket.qrExpiresAt = next.expiresAt;
        canvas.hidden = false;
        draw();
        persist();
        schedule();
      } catch {
        qrTimer = setTimeout(refresh, 15_000); // transient failure: try again
      }
    };
    const stale = !ticket.token || !(Date.parse(ticket.qrExpiresAt) > Date.now() + 10_000);
    if (stale) refresh();
    else schedule();
  }

  function showTicket() {
    const { profile, ticket } = s;
    if (ticketEl) {
      const dl = ticketEl.querySelector("[data-ticket-fields]");
      if (dl) {
        dl.replaceChildren();
        pair(dl, "Name", profile.name);
        pair(dl, "Role", profile.role);
        pair(dl, "Interests", profile.interests.join(", "));
        if (profile.goal) pair(dl, "Goal", profile.goal);
        pair(dl, "Ticket", ticket.source === "api" ? "Registered" : "Demo ticket");
        if (ticket.source === "api" && ticket.scheduleSaved) pair(dl, "Schedule", "Ready");
        const exp = formatExpiry(ticket.expiresAt);
        if (exp) pair(dl, "Expires", exp);
      }
      const canvas = ticketEl.querySelector("[data-qr]");
      if (canvas) {
        const draw = () => {
          try {
            drawQr(canvas, ticket.token, { label: "Your ticket QR code. Scanning it reads your ticket code." });
          } catch { /* leave the canvas blank */ }
        };
        if (typeof ticket.token === "string" && ticket.token) draw();
        else canvas.hidden = ticket.source === "api"; // registered but no check-in token yet: the refresh below fills it in
        if (ticket.source === "api") keepQrFresh(draw, canvas);
      }
      ticketEl.hidden = false;
    }
    clearChoices();
    lock(false);
    input.disabled = true;
    if (submit) submit.disabled = true;
    setState("done");
    section.dispatchEvent(new CustomEvent("chat:done", { bubbles: true, detail: { profile, ticket } }));
  }

  async function finish(profile) {
    s.done = true;
    s.profile = profile;
    clearChoices();
    // On the site this is the real sign-up (register, app session token, personal schedule, check-in token); on the
    // preview server its own endpoint. Never throws: when the API is unreachable it returns a local "Demo ticket".
    const ticket = await completeSignup(conference, profile, { returning: Boolean(s.known) });
    s.ticket = ticket;
    // Simulated "kept profile": registering always keeps it, in this browser only (no server-side store).
    saveKept(profile);
    persist();
    showTicket();
  }

  /** Asks for the next assistant message for the current transcript. */
  async function turn() {
    setState("waiting");
    lock(true);
    const li = addMessage("assistant", "…", true);
    let res;
    if (!s.local) {
      try {
        res = await sendChat({ conference, via, messages: s.messages, known: s.known });
      } catch {
        s.local = true; // server missing or broken: continue with the same script in the browser, no error shown
      }
    }
    if (s.local) {
      const t = scriptedTurn({ conference: { ...conference, topics: conferenceTopics }, via, messages: s.messages, known: s.known });
      res = { ...t, mode: "scripted" };
    }
    setMode(res.mode);
    li.removeAttribute("data-pending");
    li.querySelector("p").textContent = res.reply;
    scroll(li);
    s.messages.push({ role: "assistant", content: res.reply });
    if (res.done) {
      const checked = validateProfile(res.profile);
      if (checked.ok) return finish(checked.profile);
    }
    showAsk(res);
    persist();
    lock(false);
    setState("ready");
    if (s.interacted) input.focus({ preventScroll: true });
  }

  /** Sends `text` as the visitor's next message. Shared by the form, the chips and the quick-reply buttons. */
  function send(raw) {
    if (s.busy || s.done) return;
    const text = String(raw).replace(/\s+/g, " ").trim().slice(0, MAX_INPUT_CHARS);
    if (!text) return;
    s.interacted = true;
    input.value = "";
    const kind = s.ask?.kind;
    clearChoices();
    addMessage("user", text);
    if (s.known && kind === "confirm" && parseConfirmChoice(text) === "startover") {
      // Forget the kept profile and run the first-time flow from a fresh transcript.
      forgetKeptProfile();
      s.known = null;
      s.messages = [];
      persist();
      turn();
      return;
    }
    s.messages.push({ role: "user", content: text });
    persist();
    turn();
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (s.busy || s.done) return;
    const typed = input.value.replace(/\s+/g, " ").trim();
    const text = sel ? sel.message(typed) : typed;
    if (!text) {
      if (sel) say(s.ask.kind === "topics" ? "Pick at least one topic, or type your answer." : "Pick an option, or type your answer.");
      return;
    }
    send(text);
  });
  input.addEventListener("focus", () => { s.interacted = true; });

  // Resume after a reload, or start fresh.
  const saved = storageGet(storeKey);
  const valid =
    saved && Array.isArray(saved.messages) &&
    saved.messages.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string");
  if (valid && saved.messages.length) {
    s.messages = saved.messages;
    s.local = Boolean(saved.local);
    s.known = saved.returning ? loadKept() : null;
    for (const m of s.messages) addMessage(m.role, m.content);
    if (saved.mode === "claude" || saved.mode === "scripted") setMode(saved.mode);
    const checked = saved.done ? validateProfile(saved.profile) : null;
    if (checked?.ok && saved.ticket && (typeof saved.ticket.token === "string" || (saved.ticket.source === "api" && saved.ticket.token === null))) {
      s.done = true;
      s.profile = checked.profile;
      s.ticket = saved.ticket;
      showTicket();
      return;
    }
    if (s.messages[s.messages.length - 1].role === "user") return turn();
    const a = saved.ask;
    if (a && ["topics", "goal", "confirm"].includes(a.kind) && Array.isArray(a.options) && a.options.length) {
      s.ask = {
        kind: a.kind,
        options: a.options.filter((x) => typeof x === "string").slice(0, 14),
        selected: Array.isArray(a.selected) ? a.selected.filter((x) => typeof x === "string") : [],
        picked: Array.isArray(a.picked) ? a.picked.filter((x) => typeof x === "string") : null,
      };
      renderChoices();
    }
    lock(false);
    setState("ready");
    return;
  }
  s.known = loadKept();
  return turn();
}

onReady(() => {
  for (const section of document.querySelectorAll("[data-chat]")) bindChat(section);
});
