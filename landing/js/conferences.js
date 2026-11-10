// Conference catalogue for the landing pages. Plain ES module, no dependencies.
// The first entry is the one real event; everything with `assumed: true` is invented demo data.

export const DEFAULT_SLUG = "cloud-native-hackathon-slc-2026";

/** Inlined copy of data/conferences.json, used when the file cannot be fetched. Kept identical by a test. */
export const FALLBACK_CONFERENCES = [
  {
    slug: "cloud-native-hackathon-slc-2026",
    name: "Cloud Native Hackathon",
    startDate: "2026-11-09",
    endDate: "2026-11-09",
    city: "Salt Lake City",
    district: "Downtown",
    venue: "The Shop Workspace",
    topics: ["search", "observability", "kubernetes", "ai sre", "code review"],
    summary: "One-day hackathon with talks and builds on search, observability, Kubernetes, AI SRE and code review.",
    capacity: 200,
    assumed: false,
    wifi: { ssid: "CloudNativeHack-Guest", security: "WPA", password: "shipit-slc-2026", assumed: true },
  },
  {
    slug: "harborline-platform-days-2026",
    name: "Harborline Platform Days",
    startDate: "2026-12-02",
    endDate: "2026-12-03",
    city: "Rotterdam",
    district: "Kop van Zuid",
    venue: "The Rope Works Hall",
    topics: ["platform engineering", "developer experience", "kubernetes", "gitops"],
    summary: "Two days on internal platforms, paved roads and keeping developers productive at scale.",
    capacity: 900,
    assumed: true,
    wifi: { ssid: "Harborline-Guest", security: "WPA", password: "paved-roads-26", assumed: true },
  },
  {
    slug: "ember-ml-systems-2027",
    name: "Ember ML Systems Forum",
    startDate: "2027-02-16",
    endDate: "2027-02-17",
    city: "Toronto",
    district: "Liberty Village",
    venue: "Foundry Atrium",
    topics: ["machine learning", "inference", "data pipelines", "mlops"],
    summary: "Practitioner talks on serving models, feeding them clean data and running them reliably.",
    capacity: 1200,
    assumed: true,
    wifi: { ssid: "EmberML-Guest", security: "WPA", password: "warm-models-27", assumed: true },
  },
  {
    slug: "quillstack-web-2027",
    name: "Quillstack Web Conf",
    startDate: "2027-03-23",
    endDate: "2027-03-24",
    city: "Austin",
    district: "East Side",
    venue: "Pecan Yard Theatre",
    topics: ["web performance", "accessibility", "typescript", "design systems"],
    summary: "Fast, accessible, well-typed web interfaces, from component libraries to the last millisecond.",
    capacity: 1500,
    assumed: true,
    wifi: { ssid: "Quillstack-Guest", security: "WPA", password: "fast-pages-27", assumed: true },
  },
  {
    slug: "lowtide-security-congress-2027",
    name: "Lowtide Security Congress",
    startDate: "2027-05-11",
    endDate: "2027-05-13",
    city: "Lisbon",
    district: "Alcantara",
    venue: "Riverside Dockhouse",
    topics: ["security", "supply chain", "zero trust", "incident response"],
    summary: "Three days on defending software supply chains and responding well when something breaks.",
    capacity: 1100,
    assumed: true,
    wifi: { ssid: "Lowtide-Guest", security: "WPA", password: "low-tide-sec-27", assumed: true },
  },
  {
    slug: "sparrowfield-data-days-2027",
    name: "Sparrowfield Data Days",
    startDate: "2027-06-08",
    endDate: "2027-06-09",
    city: "Chicago",
    district: "West Loop",
    venue: "Grain Exchange Hall",
    topics: ["data engineering", "streaming", "search", "databases"],
    summary: "Pipelines, streams, indexes and the databases underneath them, told by the people who run them.",
    capacity: 700,
    assumed: true,
    wifi: { ssid: "Sparrowfield-Guest", security: "WPA", password: "stream-me-27", assumed: true },
  },
  {
    slug: "tidepool-edge-summit-2027",
    name: "Tidepool Edge Summit",
    startDate: "2027-08-17",
    endDate: "2027-08-18",
    city: "Singapore",
    district: "Jurong Lake",
    venue: "Lakeside Pavilion",
    topics: ["edge computing", "iot", "embedded", "observability"],
    summary: "Running and observing software on small, far-away devices with unreliable connections.",
    capacity: 800,
    assumed: true,
    wifi: { ssid: "Tidepool-Guest", security: "WPA", password: "edge-of-lake-27", assumed: true },
  },
  {
    slug: "brightwater-open-source-weekend-2027",
    name: "Brightwater Open Source Weekend",
    startDate: "2027-10-02",
    endDate: "2027-10-03",
    city: "Nairobi",
    district: "Westlands",
    venue: "Acacia Commons",
    topics: ["open source", "community", "licensing", "maintainers"],
    summary: "A weekend for maintainers and contributors: sustainable projects, healthy communities, shared tools.",
    capacity: 600,
    assumed: true,
    wifi: { ssid: "Brightwater-Guest", security: "WPA", password: "share-alike-27", assumed: true },
  },
];

let cache = null;

const isConference = (c) =>
  c && typeof c === "object" && typeof c.slug === "string" && typeof c.name === "string" &&
  typeof c.startDate === "string" && Array.isArray(c.topics);

/** Fetches data/conferences.json (relative to this module); falls back to the inlined copy. */
export async function loadConferences() {
  if (cache) return cache;
  try {
    const r = await fetch(new URL("../data/conferences.json", import.meta.url), { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error("conferences");
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0 || !list.every(isConference)) throw new Error("conferences");
    cache = list;
  } catch {
    cache = FALLBACK_CONFERENCES;
  }
  return cache;
}

/** Test hook. */
export function resetConferencesCache() {
  cache = null;
}

/**
 * Case-insensitive filter.
 *  q      every whitespace-separated word must appear in name, city, topics or summary
 *  topic  exact topic tag (case-insensitive); "" or "all" = any
 *  month  "YYYY-MM" (conference runs in that month) or "1".."12"/"01".."12" (that month in any year); "" or "all" = any
 */
export function filterConferences(list, { q = "", topic = "", month = "" } = {}) {
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const t = String(topic ?? "").trim().toLowerCase();
  const m = String(month ?? "").trim();
  return list.filter((c) => {
    if (words.length) {
      const hay = [c.name, c.city, ...(c.topics ?? []), c.summary].join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    if (t && t !== "all" && !(c.topics ?? []).some((x) => String(x).toLowerCase() === t)) return false;
    if (m && m.toLowerCase() !== "all" && !inMonth(c, m)) return false;
    return true;
  });
}

function inMonth(c, month) {
  const start = String(c.startDate).slice(0, 7);
  const end = String(c.endDate ?? c.startDate).slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(month)) return start <= month && month <= end;
  if (/^\d{1,2}$/.test(month)) {
    const mm = month.padStart(2, "0");
    return start.slice(5) === mm || end.slice(5) === mm;
  }
  return false;
}

/** Looks a conference up by slug in the loaded list (or the inlined copy before it has loaded). */
export function getConference(slug) {
  return (cache ?? FALLBACK_CONFERENCES).find((c) => c.slug === slug);
}
