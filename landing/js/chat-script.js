// Shared by the browser (js/chat.js) and the Node server (server.mjs).
// Plain ESM, no dependencies, no DOM access.
//
// Contents:
//  - profile validation / text cleaning (used to vet anything that claims to be a profile)
//  - the deterministic scripted registration flow (used when the Claude CLI is
//    unavailable, and in the browser when /api/chat cannot be reached)
//
// Privacy rules (design doc section 6): the flow never asks about health,
// politics, religion, ethnicity, sexuality, age or exact location, and
// anything of that kind that is volunteered is dropped, not stored.

export const LIMITS = Object.freeze({
  name: 80, // same cap as the real API (api/src/routes/register.ts MAX_NAME_LENGTH)
  role: 80,
  goal: 60,
  formats: 120,
  tag: 32, // short lowercase tag; the real API allows 64
  minTags: 1, // the real API requires at least one interest
  maxTags: 6,
});

export const VIA_VALUES = Object.freeze(["github", "google", "linkedin", "qr"]);

const VIA_LABELS = { github: "GitHub", google: "Google", linkedin: "LinkedIn", qr: "the QR code" };

// Zero-width, bidi-control and C0/C1 control characters.
const INVISIBLE_RE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

// Things we never store. Deliberately blunt: a false positive only drops one
// tag, a false negative would store something we promised not to.
const SENSITIVE_RE = new RegExp(
  [
    String.raw`health(?!\s*-?\s*(?:check|probe|endpoint))`,
    String.raw`medical`, String.raw`medicat`, String.raw`illness`, String.raw`disease`, String.raw`disorder`,
    String.raw`therap(?:y|ist)`, String.raw`diagnos`, String.raw`disabilit`, String.raw`pregnan`, String.raw`\bhiv\b`,
    String.raw`cancer`, String.raw`diabet`, String.raw`asthma`, String.raw`epilep`, String.raw`autis`, String.raw`\badhd\b`, String.raw`chronic`, String.raw`surgery`, String.raw`allerg`, String.raw`depress`, String.raw`anxiety`, String.raw`mental`,
    String.raw`politic`, String.raw`democrat`, String.raw`republican`, String.raw`conservative`,
    String.raw`(?<!leader )election`, String.raw`\bvoted?\b`,
    String.raw`religio`, String.raw`\bchurch`, String.raw`mosque`, String.raw`synagogue`, String.raw`christian`,
    String.raw`muslim`, String.raw`jewish`, String.raw`\bhindu`, String.raw`buddhis`, String.raw`atheis`,
    String.raw`ethnic`, String.raw`\bracial`, String.raw`\brace\b(?!\s*condition)`, String.raw`\bblack (?:man|woman|people)`,
    String.raw`sexual`, String.raw`\bgay\b`, String.raw`lesbian`, String.raw`bisexual`, String.raw`transgender`,
    String.raw`\blgbt`, String.raw`gender`, String.raw`immigra`, String.raw`citizenship`,
    String.raw`\bage\b`, String.raw`\baged\b`, String.raw`\d+\s*(?:years?[ -]old|y\/o|yo\b)`,
    String.raw`home address`, String.raw`\bstreet\b`, String.raw`\bssn\b`, String.raw`social security`,
    String.raw`password`, String.raw`confidential`, String.raw`trade secret`,
  ].join("|"),
  "i",
);

/** True when the text mentions something we promised never to store. */
export function isSensitive(text) {
  return typeof text === "string" && SENSITIVE_RE.test(text.normalize("NFKC"));
}

/** Strips control/invisible characters, collapses whitespace, trims. Non-strings become "". */
export function cleanText(value, max = Infinity) {
  if (typeof value !== "string") return "";
  const out = value.replace(INVISIBLE_RE, " ").replace(/\s+/g, " ").trim();
  return out.length > max ? out.slice(0, max).trim() : out;
}

/** Free text or list -> short lowercase tags (deduplicated, sensitive ones dropped). */
export function normaliseTags(input, max = Infinity) {
  const parts = Array.isArray(input)
    ? input
    : String(input ?? "").split(/[,;\n]+|\s+(?:and|&)\s+|\s+\/\s+/i);
  const out = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    let tag = cleanText(part.normalize("NFKC").toLowerCase())
      .replace(/^(?:i(?:'m| am)? (?:interested in|into)|i like|i want|about|some|the|my)\s+/, "")
      .replace(/[^\p{L}\p{N}+#. -]/gu, " ")
      .replace(/\s+/g, " ")
      .replace(/^[-. ]+|[-. ]+$/g, "");
    if (tag.length < 2 || tag.length > LIMITS.tag) continue;
    if (isSensitive(tag)) continue;
    if (!out.includes(tag)) out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Strict profile validation. Accepts only a plain object; copies out exactly
 * the known keys (everything else, including `__proto__`, is ignored) and
 * rejects wrong types or out-of-range lengths. Sensitive tags/text are dropped.
 * Returns `{ ok: true, profile }` or `{ ok: false, error }`.
 * @param {unknown} raw
 * @returns {{ok: boolean, error?: string, profile?: {name: string, role: string, interests: string[], goal: string, formats: string}}}
 */
export function validateProfile(raw) {
  const fail = (error) => ({ ok: false, error });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("not_an_object");
  const own = (k) => (Object.prototype.hasOwnProperty.call(raw, k) ? raw[k] : undefined);

  const str = (k, max, { required }) => {
    const v = own(k);
    if (v === undefined && !required) return "";
    if (typeof v !== "string") return null;
    const cleaned = cleanText(v);
    if (cleaned.length > max || (required && cleaned.length === 0)) return null;
    return cleaned;
  };

  const name = str("name", LIMITS.name, { required: true });
  if (name === null) return fail("name");
  let role = str("role", LIMITS.role, { required: true });
  if (role === null) return fail("role");
  let goal = str("goal", LIMITS.goal, { required: false });
  if (goal === null) return fail("goal");
  let formats = str("formats", LIMITS.formats, { required: false });
  if (formats === null) return fail("formats");

  if (isSensitive(role)) role = "attendee";
  if (isSensitive(goal)) goal = "";
  if (isSensitive(formats)) formats = "";

  const interestsRaw = own("interests");
  if (!Array.isArray(interestsRaw) || interestsRaw.length > 24) return fail("interests");
  if (!interestsRaw.every((t) => typeof t === "string" && t.length <= 200)) return fail("interests");
  const interests = normaliseTags(interestsRaw);
  if (interests.length < LIMITS.minTags || interests.length > LIMITS.maxTags) return fail("interests");

  return {
    ok: true,
    profile: {
      name,
      role,
      interests,
      goal: goal.toLowerCase(),
      formats,
    },
  };
}

/**
 * A "kept profile" remembered in this browser (localStorage) and sent back as `known`. Validated exactly like a profile
 * (same keys, types and caps). Registering always keeps the profile, so there is no separate flag.
 * @param {unknown} raw
 * @returns {{ok: boolean, error?: string, profile?: {name: string, role: string, interests: string[], goal: string, formats: string}}}
 */
export function validateKnown(raw) {
  return validateProfile(raw);
}

// ------------------------------------------------------------ quick replies ("ask")

/** Closed-question kinds a reply can carry. The chat page renders them as chips. */
export const ASK_KINDS = Object.freeze(["topics", "goal", "confirm"]);
export const GOAL_OPTIONS = Object.freeze(["learn", "hire", "meet", "build"]);
/** Returning visitor with a kept profile. */
export const CONFIRM_OPTIONS = Object.freeze(["Yes, register me", "Change my topics", "Start over"]);
/** First-time visitor reading back the summary. */
export const CONFIRM_FIRST_OPTIONS = Object.freeze(["Yes, register me", "Change something"]);
export const MAX_TOPIC_OPTIONS = 14;
/** Common tech-conference tags offered after the conference's own topics. */
export const COMMON_TOPICS = Object.freeze([
  "kubernetes", "observability", "security", "ai", "platform engineering", "devops", "data", "open source",
  "testing", "cloud", "networking", "performance",
]);

/** Options for an ask kind. Topics: the conference's own topics first, then common tags, lowercase, deduplicated, max 14. */
export function askOptions(kind, conferenceTopics = [], { returning = true } = {}) {
  if (kind === "goal") return [...GOAL_OPTIONS];
  if (kind === "confirm") return [...(returning ? CONFIRM_OPTIONS : CONFIRM_FIRST_OPTIONS)];
  if (kind !== "topics") return [];
  const out = [];
  for (const t of [...(Array.isArray(conferenceTopics) ? conferenceTopics : []), ...COMMON_TOPICS]) {
    if (typeof t !== "string") continue;
    const tag = t.trim().toLowerCase();
    if (tag && tag.length <= LIMITS.tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TOPIC_OPTIONS) break;
  }
  return out;
}

/**
 * Selection state behind the chips of a multi-select ask (topics, goal). Pure logic, no DOM: chat.js renders it.
 * Topics are capped at LIMITS.maxTags; custom entries go through the same tag normaliser as everything else.
 */
export function createSelection({ kind, options = [], selected = [] }) {
  const max = kind === "topics" ? LIMITS.maxTags : Infinity;
  const items = options.map((text) => ({ text, custom: false, pressed: false }));
  const pressedCount = () => items.filter((i) => i.pressed).length;
  const sel = {
    kind,
    max,
    items,
    pressed: () => items.filter((i) => i.pressed).map((i) => i.text),
    atCap: () => pressedCount() >= max,
    /** Presses the item (adding it as a custom item when it is not an option). false = refused at the cap. */
    press(text) {
      const found = items.find((i) => i.text === text);
      if (found?.pressed) return true;
      if (pressedCount() >= max) return false;
      if (found) found.pressed = true;
      else items.push({ text, custom: true, pressed: true });
      return true;
    },
    /** Toggles a chip. Pressing at the cap is refused (returns false). */
    toggle(text) {
      const found = items.find((i) => i.text === text);
      if (!found) return false;
      if (found.pressed) { found.pressed = false; return true; }
      return sel.press(text);
    },
    /** Adds the tags found in free text as pressed custom chips. Duplicates only press the existing chip. */
    addCustom(raw) {
      const tags = normaliseTags(typeof raw === "string" ? raw : "", LIMITS.maxTags);
      if (!tags.length) return { added: [], error: raw && String(raw).trim() ? "invalid" : null };
      const added = [];
      let error = null;
      for (const t of tags) {
        const existed = items.some((i) => i.text === t);
        if (!sel.press(t)) { error = "cap"; break; }
        if (!existed) added.push(t);
      }
      return { added, error };
    },
    /** The answer sent to the host: the pressed chips, then any typed text, comma-separated. */
    message(typed = "") {
      return [...sel.pressed(), cleanText(typed)].filter(Boolean).join(", ");
    },
  };
  for (const t of selected) if (typeof t === "string") sel.press(t);
  return sel;
}

/**
 * Fields a reply carries for an ask kind: `{ ask, options, selected? }`, or `{ ask: null }`.
 * @param {string|null|undefined} kind
 * @param {{conferenceTopics?: string[], selected?: string[], returning?: boolean}} [opts]
 * @returns {{ask: string|null, options?: string[], selected?: string[]}}
 */
export function askFields(kind, { conferenceTopics = [], selected, returning = true } = {}) {
  if (!ASK_KINDS.includes(kind)) return { ask: null };
  /** @type {{ask: string, options: string[], selected?: string[]}} */
  const out = { ask: kind, options: askOptions(kind, conferenceTopics, { returning }) };
  if (kind === "topics" && Array.isArray(selected) && selected.length) out.selected = selected.slice(0, LIMITS.maxTags);
  return out;
}

export function viaLabel(via) {
  return Object.prototype.hasOwnProperty.call(VIA_LABELS, via) ? VIA_LABELS[via] : null;
}

// ------------------------------------------------------------ scripted flow

const YES_RE = /^\s*(?:y|yes|yeah|yep|yup|sure|ok|okay|please|of course|absolutely|definitely|go ahead|i do|that'?s right|correct|right|looks good|sounds good|confirm(?:ed)?)\b/i;
const NO_RE = /^\s*(?:n|no|nope|nah|not|don'?t|do not|never|negative|wrong|incorrect)\b/i;

/** "yes"/"no" free text -> true/false, or null when unclear. */
export function parseYesNo(text) {
  if (typeof text !== "string") return null;
  if (NO_RE.test(text)) return false;
  if (YES_RE.test(text)) return true;
  return null;
}

function parseGoal(text) {
  const found = ["learn", "hire", "meet", "build"].filter((w) => new RegExp(`\\b${w}`, "i").test(text));
  if (found.length) return found.join(", ");
  return cleanText(text.toLowerCase(), LIMITS.goal);
}

function parseName(text) {
  const t = cleanText(text)
    .replace(/^(?:hi|hello|hey)[,!.\s]+/i, "")
    .replace(/^(?:my name is|my name's|i am|i'm|im|it is|it's|its|call me|you can call me|this is)\s+/i, "")
    .replace(/[.!]+$/, "");
  return cleanText(t, LIMITS.name);
}

function parseRole(text) {
  const t = cleanText(text)
    .replace(/^(?:i am|i'm|im|i work as|i work in|i do|i'm working as|currently)\s+/i, "")
    .replace(/^(?:an?|the)\s+/i, "")
    .replace(/[.!]+$/, "");
  const role = cleanText(t, LIMITS.role);
  return isSensitive(role) ? "attendee" : role;
}

function parseFormats(text) {
  if (/^\s*(?:none|no|nope|nothing|n\/a|no preference|nah|skip|any)\b/i.test(text)) return "";
  const f = cleanText(text, LIMITS.formats);
  return isSensitive(f) ? "" : f;
}

const FIRST_TIME_STEPS = ["name", "role", "interests", "goal", "formats", "confirm"];

/** What the host says up front, in three short lines: what registering does (QR ticket, kept profile until deleted, aggregate-only map). */
export const REGISTER_NOTICE =
  "Registering gives you a QR ticket for room doors.\n" +
  "Your name, role, interests, goal and format preferences are kept for your next conference, until you delete them from your profile.\n" +
  "Your interests are counted in the organisers' interest map in aggregate only, and groups under 5 are folded into \"other\".";

function summary(d) {
  return (
    `Here is what I have:\nName: ${d.name}\nRole: ${d.role}\nTopics: ${d.interests.join(", ")}\n` +
    `Goal: ${d.goal || "explore"}\nFormats: ${d.formats || "no preference"}\nRegister you with these?`
  );
}

/** Returning-visitor reply -> "yes" | "topics" | "startover" | null. Accepts the chip labels and plain words. */
export function parseConfirmChoice(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().toLowerCase();
  if (/start (?:over|again)|new profile|forget|^over$|reset/.test(t)) return "startover";
  if (/topic|change|edit|update/.test(t)) return "topics";
  if (/register/.test(t) || parseYesNo(t) === true) return "yes";
  return null;
}

/** First-time summary reply -> "yes" | "change" | null. */
function parseFirstConfirm(text) {
  const c = parseConfirmChoice(text);
  if (c === "yes") return "yes";
  if (c === "topics" || c === "startover") return "change";
  const v = parseYesNo(text);
  if (v === false) return "change";
  return null;
}

const CHANGE_FIELDS = [
  [/name|call/i, "name"], [/role|job|work/i, "role"], [/topic|interest/i, "interests"], [/goal|day/i, "goal"], [/format|talk/i, "formats"],
];

/**
 * Replays the user turns of a transcript through the flow. Stateless: the step is derived from the user messages only,
 * so the same function works on the server and in the browser, and can take over a transcript mid-way.
 *
 * First-time visitors: name, role, topics, goal, formats, read-back and confirm. A returning visitor (`known`, the kept
 * profile) gets one step: confirm the remembered profile ("yes"), change only the topics, or start over (which discards
 * `known` and runs the full flow).
 */
function replay(messages, known) {
  let queue = known ? ["returning"] : [...FIRST_TIME_STEPS];
  let data = {};
  let notice = null;
  let result = null; // set when a returning visitor finished
  let returning = Boolean(known);
  for (const m of messages) {
    if (!m || m.role !== "user" || typeof m.content !== "string") continue;
    if (!queue.length) break; // finished; ignore further input
    const text = cleanText(m.content, 1000);
    notice = null;
    const done = () => { queue.shift(); if (queue[0] === "changed") queue.shift(); };
    switch (queue[0]) {
      case "returning": {
        const choice = parseConfirmChoice(text);
        if (choice === "yes") { result = { ...known }; queue = []; }
        else if (choice === "topics") { queue = ["interests"]; }
        else if (choice === "startover") { returning = false; queue = [...FIRST_TIME_STEPS]; data = {}; }
        else notice = "Please pick one of the options.";
        break;
      }
      case "name": {
        const name = parseName(text);
        if (!name) { notice = "I did not catch that."; break; }
        data.name = name; done(); break;
      }
      case "role": {
        const role = parseRole(text);
        if (!role) { notice = "Sorry, I missed that."; break; }
        data.role = role; done(); break;
      }
      case "interests": {
        const interests = normaliseTags(text, LIMITS.maxTags);
        if (interests.length === 0) {
          notice = "I could not pick out any topics, try tech subjects like observability, search or kubernetes.";
          break;
        }
        data.interests = interests; done();
        if (returning) { result = { ...known, interests }; queue = []; }
        break;
      }
      case "goal": { data.goal = parseGoal(text); done(); break; }
      case "formats": { data.formats = parseFormats(text); done(); break; }
      case "confirm": {
        const v = parseFirstConfirm(text);
        if (v === null) { notice = "Please pick one of the options."; break; }
        if (v === "yes") { queue.shift(); break; }
        queue = ["change", "confirm"]; break;
      }
      case "change": {
        const hit = CHANGE_FIELDS.find(([re]) => re.test(text));
        if (!hit) { notice = "Sorry, I did not catch which part."; break; }
        queue = [hit[1], "changed", "confirm"]; break;
      }
      default: break;
    }
  }
  return { step: queue[0] ?? null, data, notice, result, returning };
}

const QUESTIONS = {
  role: (d) => `Nice to meet you, ${d.name}. What do you do?`,
  interests: () => "Which 3 to 6 topics do you want from the talks? Pick some below or type them.",
  goal: () => "What do you want out of the day?",
  formats: () => "Any talk formats you prefer or want to avoid, like deep dives or workshops? Say none if not.",
  confirm: (d) => summary(d),
  change: () => "What would you like to change: your name, role, topics, goal or formats?",
};

const ASK_FOR_STEP = { interests: "topics", goal: "goal", confirm: "confirm", returning: "confirm" };

/**
 * Next assistant turn of the scripted flow.
 * @param {{conference?: {name?: string, topics?: string[]}, via?: string|null, known?: object|null, messages?: {role: string, content: string}[]}} ctx
 * @returns {{reply: string, done: boolean, profile?: object, ask: string|null, options?: string[], selected?: string[]}}
 */
export function scriptedTurn(ctx = {}) {
  const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
  const confName = cleanText(ctx.conference?.name, 100) || "the conference";
  const topics = ctx.conference?.topics ?? [];
  const known = ctx.known ? validateKnown(ctx.known).profile ?? null : null;
  const { step, data, notice, result, returning } = replay(messages, known);
  const lead = notice ? `${notice} ` : "";
  const ask = (kind, extra) => askFields(kind, { conferenceTopics: topics, returning, ...extra });
  const label = viaLabel(ctx.via);
  const first = messages.every((m) => m?.role !== "user");
  const ack = first && label ? (ctx.via === "qr" ? "You scanned the registration QR code. " : `You're signed in with ${label}. `) : "";

  if (result) {
    const checked = validateKnown(result);
    if (checked.ok) {
      return { reply: `You're registered for ${confName}, ${checked.profile.name}. Your ticket is ready below.`, done: true, profile: checked.profile, ask: null };
    }
  }

  if (step === "returning") {
    const k = known;
    const body = `Welcome back, ${k.name}. I have you as ${k.role}, interested in ${k.interests.join(", ")}, aiming to ${k.goal || "explore"}. Register you for ${confName} with these?`;
    return { reply: `${first ? ack : lead}${body}`, done: false, ...ask("confirm") };
  }
  if (step === "interests" && returning) {
    return { reply: `${lead}Which topics do you want at ${confName}? Pick some below or type them.`, done: false, ...ask("topics", { selected: known.interests }) };
  }
  if (step === "name") {
    const text = first ? `${ack}${REGISTER_NOTICE}\nWhat should I call you?` : `${lead}What should I call you?`;
    return { reply: text, done: false, ask: null };
  }
  if (step) {
    const selected = step === "interests" && data.interests ? data.interests : undefined;
    return { reply: `${lead}${QUESTIONS[step](data)}`, done: false, ...ask(ASK_FOR_STEP[step] ?? null, { selected }) };
  }

  const checked = validateProfile({ name: data.name, role: data.role, interests: data.interests, goal: data.goal, formats: data.formats });
  if (!checked.ok) return { reply: "Something did not look right, so let's go again. What should I call you?", done: false, ask: null };
  return { reply: `You're registered for ${confName}, ${checked.profile.name}. Your ticket is ready below.`, done: true, profile: checked.profile, ask: null };
}
