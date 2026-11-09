import type { ServerResponse } from "node:http";

/**
 * Live demo stream (GET /api/events): one `registered` event per successful registration.
 *
 * The stream is unauthenticated, so by default it carries NO name: the label is "Guest". Only when the API is
 * started with EVENTS_SHOW_NAMES=on (a demo-only switch) is the sanitised first name sent (letters and digits,
 * at most 12 characters). Besides the label: the conference slug, a flag and a count of interests. Never the
 * full name, role, tags, attendee ID or token.
 */

export const MAX_EVENT_LISTENERS = 20;
export const HEARTBEAT_MS = 20_000;
export const MAX_LABEL_LENGTH = 12;
/** Concurrent streams per client IP, inside the global cap. */
export const MAX_EVENT_LISTENERS_PER_IP = 3;
/** The label every registrant gets unless the API runs with EVENTS_SHOW_NAMES=on. */
export const DEFAULT_LABEL = "Guest";

export interface RegisteredEvent {
  label: string;
  conference: string;
  returning: boolean;
  interests: number;
}

/** First whitespace token of the name, A-Z a-z 0-9 only, at most 12 characters; "Guest" when nothing is left. */
export function sanitizeLabel(name: unknown): string {
  const first = (typeof name === "string" ? name : "").trim().split(/\s+/)[0] ?? "";
  return first.replace(/[^A-Za-z0-9]/g, "").slice(0, MAX_LABEL_LENGTH) || "Guest";
}

export function buildRegisteredEvent(
  profile: { name?: unknown; interests?: unknown } | null | undefined,
  conference: string,
  returning: unknown,
  showNames = false,
): RegisteredEvent {
  return {
    label: showNames ? sanitizeLabel(profile?.name) : DEFAULT_LABEL,
    conference,
    returning: returning === true,
    interests: Array.isArray(profile?.interests) ? profile.interests.length : 0,
  };
}

/** The set of connected listeners. Holds no attendee data. */
export class EventHub {
  private clients = new Set<{ res: ServerResponse; timer: NodeJS.Timeout; ip: string }>();
  constructor(
    private readonly heartbeatMs: number = HEARTBEAT_MS,
    private readonly max: number = MAX_EVENT_LISTENERS,
    private readonly maxPerIp: number = MAX_EVENT_LISTENERS_PER_IP,
  ) {}

  get size(): number {
    return this.clients.size;
  }

  get full(): boolean {
    return this.clients.size >= this.max;
  }

  /** Whether `ip` already has its share of streams open. */
  ipFull(ip: string): boolean {
    let n = 0;
    for (const c of this.clients) if (c.ip === ip) n++;
    return n >= this.maxPerIp;
  }

  /** Starts streaming to `res` (already hijacked from Fastify). Returns a function that removes the listener. */
  add(res: ServerResponse, ip = "unknown"): () => void {
    res.write("retry: 5000\n: connected\n\n");
    const client = { res, ip, timer: undefined as unknown as NodeJS.Timeout };
    const remove = () => {
      clearInterval(client.timer);
      this.clients.delete(client);
    };
    client.timer = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { remove(); }
    }, this.heartbeatMs);
    client.timer.unref?.();
    this.clients.add(client);
    res.on("close", remove);
    res.on("error", remove);
    return remove;
  }

  broadcast(event: string, data: RegisteredEvent): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      try { c.res.write(frame); } catch { clearInterval(c.timer); this.clients.delete(c); }
    }
  }

  close(): void {
    for (const c of this.clients) {
      clearInterval(c.timer);
      try { c.res.end(); } catch { /* gone */ }
    }
    this.clients.clear();
  }
}
