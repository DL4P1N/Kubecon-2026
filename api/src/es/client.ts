import type { Config } from "../config.js";

/**
 * Minimal Elasticsearch HTTP client over fetch. It avoids pinning an
 * @elastic/elasticsearch major version to whatever the cluster runs.
 * Credentials come from Config (ES_URL, ES_USERNAME, ES_PASSWORD): the
 * companion_svc service account, never the superuser.
 */
export class EsError extends Error {
  /**
   * Short, safe classification of the failure: the Elasticsearch `error.type`
   * (for example `inference_exception`) or `http_<status>` when the body has none.
   * Never contains query text, so it may go on spans and into logs.
   */
  readonly errorType: string;

  constructor(
    readonly status: number,
    message: string,
    esType?: string,
  ) {
    super(message);
    this.name = "EsError";
    this.errorType = esType ?? `http_${status}`;
  }
}

const SAFE_TYPE = /^[a-z][a-z0-9_.]{0,79}$/;

/**
 * Extracts the Elasticsearch error type from an error response body, preferring
 * the innermost `root_cause` (the real failure under `search_phase_execution_exception`).
 * Only the allowlisted-shape type string is returned, never `reason` text.
 */
export function esErrorType(body: unknown): string | undefined {
  const err = (body as { error?: unknown } | null | undefined)?.error as
    | { type?: unknown; root_cause?: { type?: unknown }[] }
    | undefined;
  if (!err || typeof err !== "object") return undefined;
  const candidates = [err.root_cause?.[0]?.type, err.type];
  return candidates.find((t): t is string => typeof t === "string" && SAFE_TYPE.test(t));
}

const OVERLOAD_TYPES = new Set([
  "inference_exception",
  "circuit_breaking_exception",
  "es_rejected_execution_exception",
  "rejected_execution_exception",
]);

/** True when ES is shedding load (429 or an inference/capacity rejection): clients should retry later. */
export function isEsOverload(err: EsError): boolean {
  return err.status === 429 || OVERLOAD_TYPES.has(err.errorType);
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
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok && !allow.includes(res.status)) {
      // Error bodies from ES do not contain our credentials; keep them short.
      throw new EsError(res.status, `${method} ${path} -> ${res.status} ${text.slice(0, 500)}`, esErrorType(parsed));
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
