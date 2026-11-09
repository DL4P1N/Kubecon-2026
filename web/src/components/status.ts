import { useEffect, useState } from "react";
import type { StatusResponse } from "@cc/shared";
import { api } from "../api.js";

/** How the badge describes the service. Text always carries the meaning; the symbol and colour only reinforce it. */
export interface StatusView {
  tone: "ok" | "degraded" | "down" | "unknown";
  symbol: string;
  label: string;
}

export function describeStatus(status: StatusResponse | null): StatusView {
  if (!status) return { tone: "unknown", symbol: "?", label: "Status unavailable" };
  if (status.status === "down") return { tone: "down", symbol: "✕", label: "Search is unavailable, retrying" };
  if (status.status === "degraded") {
    return status.search.hybrid.state === "warming_up"
      ? { tone: "degraded", symbol: "!", label: "Search is warming up, try keyword" }
      : { tone: "degraded", symbol: "!", label: "Some requests are failing, we are looking into it" };
  }
  return { tone: "ok", symbol: "✓", label: "All systems normal" };
}

export const STATUS_POLL_MS = 30_000;

/** Polls GET /api/status; `null` while loading or when the status endpoint cannot be reached. */
export function useStatus(pollMs = STATUS_POLL_MS): { status: StatusResponse | null; loaded: boolean } {
  const [state, setState] = useState<{ status: StatusResponse | null; loaded: boolean }>({ status: null, loaded: false });
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.status().then(
        (status) => !cancelled && setState({ status, loaded: true }),
        () => !cancelled && setState({ status: null, loaded: true }),
      );
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pollMs]);
  return state;
}
