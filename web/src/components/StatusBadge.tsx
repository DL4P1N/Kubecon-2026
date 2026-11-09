import { Link } from "react-router-dom";
import { describeStatus, useStatus } from "./status.js";
import "./status.css";

/**
 * Small header badge linking to /status. The wrapper is an aria-live region (not
 * role="status", which would replace the link role and clash with page-level status text).
 */
export function StatusBadge() {
  const { status, loaded } = useStatus();
  if (!loaded) return <span className="status-badge-wrap" aria-live="polite"><span className="status-badge">Checking status…</span></span>;
  const view = describeStatus(status);
  return (
    <span aria-live="polite" className="status-badge-wrap">
      <Link to="/status" className={`status-badge status-${view.tone}`}>
        <span aria-hidden="true">{view.symbol}</span> {view.label}
      </Link>
    </span>
  );
}
