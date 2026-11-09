import type { Talk } from "@cc/shared";

/** Placeholder catalog for the stub routes. Replaced by Elasticsearch later. */
export const MOCK_TALKS: Talk[] = [
  {
    id: "talk-1",
    title: "Scaling Elasticsearch on Kubernetes",
    speaker: "A. Speaker",
    abstract: "Operating Elasticsearch clusters with security enabled from day one.",
    track: "Data",
    room: "room-a",
    start: "2026-11-09T16:00:00.000Z",
    end: "2026-11-09T16:45:00.000Z",
    tags: ["elasticsearch", "kubernetes"],
  },
  {
    id: "talk-2",
    title: "Tracing Without Leaking: OpenTelemetry Scrubbing",
    speaker: "B. Speaker",
    abstract: "Allowlist-based attribute scrubbing in the OTel collector.",
    track: "Observability",
    room: "room-b",
    start: "2026-11-09T17:00:00.000Z",
    end: "2026-11-09T17:45:00.000Z",
    tags: ["opentelemetry", "privacy"],
  },
  {
    id: "talk-3",
    title: "AI SRE in Practice",
    speaker: "C. Speaker",
    abstract: "Using AI-assisted investigation to debug crashloops and memory limits.",
    track: "Operations",
    room: "room-a",
    start: "2026-11-09T18:00:00.000Z",
    end: "2026-11-09T18:45:00.000Z",
    tags: ["sre", "ai"],
  },
];
