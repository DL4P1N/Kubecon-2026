import type { Config } from "../config.js";

/**
 * Minimal Elasticsearch HTTP client over fetch. It avoids pinning an
 * @elastic/elasticsearch major version to whatever the cluster runs.
 * Credentials come from Config (ES_URL, ES_USERNAME, ES_PASSWORD): the
 * companion_svc service account, never the superuser.
 */
export class EsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "EsError";
  }
}

export interface EsClient {
  /** Returns parsed JSON. Throws EsError on non-2xx unless status is in `allow`. */
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    allow?: number[],
  ): Promise<{ status: number; body: T }>;
  /** POST /_bulk with NDJSON built from alternating action and source lines. */
  bulk(lines: object[]): Promise<{ errors: boolean; items: Record<string, { status: number; error?: unknown }>[] }>;
}

type EsConfig = Pick<Config, "esUrl" | "esUsername" | "esPassword">;

export function createEsClient(cfg: EsConfig, fetchImpl: typeof fetch = fetch): EsClient {
  const base = cfg.esUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (cfg.esUsername) {
    headers.authorization =
      "Basic " + Buffer.from(`${cfg.esUsername}:${cfg.esPassword}`).toString("base64");
  }

  async function send(method: string, path: string, rawBody: string | undefined, contentType: string, allow: number[]) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { ...headers, ...(rawBody !== undefined ? { "content-type": contentType } : {}) },
      body: rawBody,
    });
    const text = method === "HEAD" ? "" : await res.text();
    if (!res.ok && !allow.includes(res.status)) {
      // Error bodies from ES do not contain our credentials; keep them short.
      throw new EsError(res.status, `${method} ${path} -> ${res.status} ${text.slice(0, 500)}`);
    }
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  }

  return {
    async request<T>(method: string, path: string, body?: unknown, allow: number[] = []) {
      const r = await send(method, path, body === undefined ? undefined : JSON.stringify(body), "application/json", allow);
      return r as { status: number; body: T };
    },
    async bulk(lines) {
      const nd = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
      const r = await send("POST", "/_bulk", nd, "application/x-ndjson", []);
      return r.body as Awaited<ReturnType<EsClient["bulk"]>>;
    },
  };
}
