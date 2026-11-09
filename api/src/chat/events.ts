import type { ServerResponse } from "node:http";

/**
 * Live demo stream (GET /api/events): one `registered` event per successful registration.
 *
 * The only attendee-derived data that ever goes on the stream is a first name (letters and digits,
 * at most 12 characters), the conference slug, a flag and a count of interests. Never the full name,
 * role, tags, attendee ID or token.
 */

export const MAX_EVENT_LISTENERS = 20;
export const HEARTBEAT_MS = 20_000;
export const MAX_LABEL_LENGTH = 12;

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
): RegisteredEvent {
  return {
    label: sanitizeLabel(profile?.name),
    conference,
    returning: returning === true,
    interests: Array.isArray(profile?.interests) ? profile.interests.length : 0,
  };
}

/** The set of connected listeners. Holds no attendee data. */
export class EventHub {
  private clients = new Set<{ res: ServerResponse; timer: NodeJS.Timeout }>();
  constructor(private readonly heartbeatMs: number = HEARTBEAT_MS, private readonly max: number = MAX_EVENT_LISTENERS) {}

  get size(): number {
    return this.clients.size;
  }

  get full(): boolean {
    return this.clients.size >= this.max;
  }

  /** Starts streaming to `res` (already hijacked from Fastify). Returns a function that removes the listener. */
  add(res: ServerResponse): () => void {
    res.write("retry: 5000\n: connected\n\n");
    const client = { res, timer: undefined as unknown as NodeJS.Timeout };
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
