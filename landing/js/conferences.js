// Conference catalogue for the landing pages. Plain ES module, no dependencies.
// The first entry is the event this app was built for; the others are real events with their organisers' public details
// (`url` is the official site), except entries with `assumed: true`, which are invented demo data.

export const DEFAULT_SLUG = "cloud-native-hackathon-slc-2026";

/** The venue text for an event whose organisers have not named a venue yet. */
export const VENUE_TBA = "Venue to be announced";

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
    slug: "aws-reinvent-2026",
    name: "AWS re:Invent",
    startDate: "2026-11-30",
    endDate: "2026-12-04",
    city: "Las Vegas",
    venue: "Venue to be announced",
    topics: ["cloud", "aws", "serverless", "ai"],
    summary: "AWS's annual cloud conference: sessions, workshops and hands-on labs on infrastructure, data and AI.",
    assumed: false,
    url: "https://aws.amazon.com/reinvent",
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
    slug: "scale-24x-2027",
    name: "SCaLE 24x",
    startDate: "2027-04-01",
    endDate: "2027-04-04",
    city: "Pasadena",
    venue: "Pasadena Convention Center",
    topics: ["open source", "linux", "devops", "community"],
    summary: "North America's largest community-run open source conference, with talks on Linux and infrastructure.",
    assumed: false,
    url: "https://www.socallinuxexpo.org/scale/24x",
  },
  {
    slug: "srecon27-americas",
    name: "SREcon27 Americas",
    startDate: "2027-04-12",
    endDate: "2027-04-14",
    city: "Seattle",
    venue: "Sheraton Grand Seattle",
    topics: ["site reliability", "observability", "incident response", "distributed systems"],
    summary: "Engineers on site reliability, systems engineering and running complex distributed systems at scale.",
    assumed: false,
    url: "https://www.usenix.org/conference/srecon27americas",
  },
  {
    slug: "google-cloud-next-2027",
    name: "Google Cloud Next",
    startDate: "2027-04-13",
    endDate: "2027-04-15",
    city: "Las Vegas",
    venue: "Mandalay Bay Convention Center",
    topics: ["cloud", "ai", "kubernetes", "data"],
    summary: "Google Cloud's yearly event on cloud and AI, with sessions, demos and hands-on learning.",
    assumed: false,
    url: "https://www.googlecloudevents.com/next-vegas",
  },
  {
    slug: "confidential-computing-summit-2027",
    name: "Confidential Computing Summit",
    startDate: "2027-04-19",
    endDate: "2027-04-20",
    city: "San Francisco",
    venue: "Venue to be announced",
    topics: ["confidential computing", "security", "privacy", "ai"],
    summary: "Enterprise AI, data and security leaders on deploying AI securely with confidential computing.",
    assumed: false,
    url: "https://events.linuxfoundation.org/confidential-computing-summit/",
  },
  {
    slug: "agntcon-mcpcon-na-2027",
    name: "AGNTCon + MCPCon North America",
    startDate: "2027-04-28",
    endDate: "2027-04-29",
    city: "San Francisco",
    venue: "Moscone Center",
    topics: ["mcp", "ai agents", "agentic ai", "security"],
    summary: "Open agentic AI conference on MCP, agent engineering, evals, security and multi-agent systems.",
    assumed: false,
    url: "https://events.linuxfoundation.org/agntcon-mcpcon-north-america/",
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
    slug: "pytorch-conference-2027",
    name: "PyTorch Conference",
    startDate: "2027-10-06",
    endDate: "2027-10-07",
    city: "San Jose",
    venue: "Venue to be announced",
    topics: ["pytorch", "machine learning", "ai", "open source"],
    summary: "AI leaders and builders pushing open source AI forward, centred on the PyTorch ecosystem.",
    assumed: false,
    url: "https://events.linuxfoundation.org/pytorch-conference-2027/",
  },
  {
    slug: "agntsummit-nyc-2027",
    name: "AGNTSummit New York City",
    startDate: "2027-11-01",
    endDate: "2027-11-02",
    city: "New York",
    venue: "Venue to be announced",
    topics: ["mcp", "ai agents", "agentic ai", "open source"],
    summary: "Developer summit on building and deploying agentic AI systems, with MCP at its core.",
    assumed: false,
    url: "https://events.linuxfoundation.org/agntsummit-new-york-city/",
  },
  {
    slug: "kubecon-na-2027",
    name: "KubeCon + CloudNativeCon North America",
    startDate: "2027-11-08",
    endDate: "2027-11-11",
    city: "New Orleans",
    venue: "Venue to be announced",
    topics: ["kubernetes", "cloud native", "ai infrastructure", "open source"],
    summary: "CNCF's flagship conference: Kubernetes, cloud native projects and the infrastructure behind AI.",
    assumed: false,
    url: "https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america-2027/",
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

const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/**
 * The event the home page features: the soonest real (not `assumed`) event that has not ended by `today`
 * (YYYY-MM-DD, default the visitor's date); once every real event is over, the latest one.
 */
export function nextEvent(list, today = todayIso()) {
  const real = list.filter((c) => !c.assumed).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  return real.find((c) => String(c.endDate || c.startDate) >= today) || real[real.length - 1] || null;
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
