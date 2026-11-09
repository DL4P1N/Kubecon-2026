import type { Talk } from "@cc/shared";
import { EsError, esErrorType, type EsClient } from "../src/es/client.js";

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export type FakeHandler = (call: RecordedCall) => { status?: number; body: unknown } | undefined;

/** EsClient fake: records every request and answers through `handler`. */
export function fakeEs(handler: FakeHandler): EsClient & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async request<T>(method: string, path: string, body?: unknown, allow: number[] = []) {
      const call = { method, path, body };
      calls.push(call);
      const res = handler(call) ?? { status: 404, body: { found: false } };
      const status = res.status ?? 200;
      if (status >= 400 && !allow.includes(status)) throw new EsError(status, `fake ES ${status} ${JSON.stringify(res.body)}`, esErrorType(res.body));
      return { status, body: res.body as T };
    },
    async bulk() {
      return { errors: false, items: [] };
    },
  };
}

export function talk(id: string, startHour: number, endHour: number, extra: Partial<Talk> = {}): Talk {
  const iso = (h: number) => new Date(Date.UTC(2026, 10, 10, 0, 0) + h * 3600_000).toISOString();
  return {
    id,
    title: `Talk ${id}`,
    speaker: "Someone",
    abstract: "About things.",
    track: "Security",
    room: "Hall A",
    start: iso(startHour),
    end: iso(endHour),
    tags: ["x"],
    ...extra,
  };
}

export function esHit(t: Talk, score: number, matched?: string[]) {
  const { speaker, ...rest } = t;
  return {
    _id: t.id,
    _score: score,
    _source: { ...rest, speakers: [speaker] },
    ...(matched ? { matched_queries: matched } : {}),
  };
}
