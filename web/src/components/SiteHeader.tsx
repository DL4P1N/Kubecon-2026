import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { StatusBadge } from "./StatusBadge.js";
import "./site-shell.css";

const LINKS = [
  { to: "/schedule", label: "Schedule" },
  { to: "/search", label: "Search" },
  { to: "/navigate", label: "Navigate" },
  { to: "/onboarding", label: "Onboarding" },
  { to: "/kiosk", label: "Kiosk" },
  { to: "/map", label: "Interest map" },
  { to: "/clusters", label: "Clusters" },
  { to: "/organizer", label: "Organizer" },
];

/** App header: same structure as the landing nav; links collapse behind a menu button on narrow screens. */
export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const toggle = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      if (header.current?.contains(document.activeElement)) toggle.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="site-header" ref={header}>
      <div className="site-header__bar">
        <a className="site-logo" href="/site/">
          <span className="site-mark" aria-hidden="true" />
          Conference Companion
        </a>
        <StatusBadge />
        <button
          ref={toggle}
          type="button"
          className="site-toggle"
          aria-expanded={open}
          aria-controls="site-menu"
          onClick={() => setOpen((value) => !value)}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
            {open ? <path d="M3 3l12 12M15 3L3 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              : <path d="M2 5h14M2 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
          </svg>
          <span>Menu</span>
        </button>
        <div id="site-menu" className={open ? "site-menu is-open" : "site-menu"}>
          <nav aria-label="Main" className="site-nav">
            {LINKS.map((link) => <NavLink key={link.to} to={link.to} className="site-link">{link.label}</NavLink>)}
            <a className="site-link" href="/site/profile.html">Profile</a>
          </nav>
          <a className="site-btn" href="/site/register.html">Register</a>
        </div>
      </div>
    </header>
  );
}
