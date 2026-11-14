import { Link } from "react-router-dom";
import "./site-shell.css";

/** One slim line: product name, privacy, the organizer area and service status. */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__bar">
        <span className="site-footer__name">Conference Companion</span>
        <a className="site-footer__link" href="/site/#privacy">Privacy</a>
        <Link className="site-footer__link" to="/organizer">Organizers</Link>
        <Link className="site-footer__link" to="/status">Status</Link>
      </div>
    </footer>
  );
}
