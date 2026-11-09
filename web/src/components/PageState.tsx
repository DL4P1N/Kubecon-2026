import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api.js";
import "./page-state.css";

/**
 * Shared loading, empty and error states for attendee pages.
 * Loading and empty states are polite live regions (role="status");
 * errors are announced immediately (role="alert"). Callers pass their own
 * friendly copy: raw API error text is never rendered.
 */
export function LoadingState({ children = "Loading…" }: { children?: ReactNode }) {
  return <p role="status" className="page-state page-state-loading">{children}</p>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div role="status" className="page-state page-state-empty">{children}</div>;
}

export function ErrorState({ children, onRetry, retryLabel = "Try again" }: {
  children: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return <div className="page-state page-state-error">
    <p role="alert">{children}</p>
    {onRetry && <button type="button" onClick={onRetry}>{retryLabel}</button>}
  </div>;
}

export function SessionExpiredState() {
  return <div className="page-state page-state-error">
    <p role="alert">Your session has expired. <Link to="/register">Register again</Link> to continue.</p>
  </div>;
}

/** True when the error is an API 401, i.e. a missing or expired session. */
export function isSessionExpired(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}
