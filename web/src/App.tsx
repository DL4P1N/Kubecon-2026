import { Link, Navigate, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { ClusterMap } from "./pages/ClusterMap.js";
import { InterestMap } from "./pages/InterestMap.js";
import { Kiosk } from "./pages/Kiosk.js";
import { Onboarding } from "./pages/Onboarding.js";
import { Register } from "./pages/Register.js";
import { Schedule } from "./pages/Schedule.js";
import { Search } from "./pages/Search.js";
import { lazy, Suspense, useEffect, useRef } from "react";
import { Status } from "./pages/Status.js";
import { StatusBadge } from "./components/StatusBadge.js";

const NavDemo = lazy(() => import("./pages/NavDemo.js"));

export function App({ navEnabled = import.meta.env.NAV_ESTIMATOR === "on" }: { navEnabled?: boolean } = {}) {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  const previousPath = useRef(pathname);
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      const rootRedirect = previousPath.current === "/" && pathname === "/register" && navigationType === "REPLACE";
      if (!rootRedirect) main.current?.focus();
      previousPath.current = pathname;
    }
  }, [pathname, navigationType]);
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header>
        <nav aria-label="Main" style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <Link to="/register">Register</Link>
          <Link to="/onboarding">Onboarding</Link>
          <Link to="/schedule">Schedule</Link>
          <Link to="/search">Search</Link>
          <Link to="/kiosk">Kiosk</Link>
          <Link to="/map">Interest map</Link>
          <Link to="/clusters">Clusters</Link>
          <StatusBadge />
        </nav>
      </header>
      <main ref={main} id="main-content" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Navigate to="/register" replace />} />
          <Route path="/register" element={<Register />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/search" element={<Search />} />
          <Route path="/kiosk" element={<Kiosk />} />
          <Route path="/map" element={<InterestMap />} />
          <Route path="/clusters" element={<ClusterMap />} />
          <Route path="/status" element={<Status />} />
          {navEnabled && <Route path="/nav-demo" element={<Suspense fallback={<p role="status">Loading replay…</p>}><NavDemo /></Suspense>} />}
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}
