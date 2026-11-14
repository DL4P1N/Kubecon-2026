import { Suspense } from "react";
import { NavLink, Outlet } from "react-router-dom";
import "./site-shell.css";

const LINKS = [
  { to: "/organizer", label: "Dashboard" },
  { to: "/map", label: "Interest map" },
  { to: "/clusters", label: "Clusters" },
  { to: "/kiosk", label: "Kiosk" },
  { to: "/status", label: "Status" },
];

/** The organizer area: one sub-nav over the organizer pages, which load on first visit. */
export function OrganizerLayout() {
  return (
    <>
      <nav aria-label="Organizer" className="org-nav">
        {LINKS.map((link) => <NavLink key={link.to} to={link.to} end className="org-link">{link.label}</NavLink>)}
      </nav>
      <Suspense fallback={<p role="status">Loading…</p>}>
        <Outlet />
      </Suspense>
    </>
  );
}
