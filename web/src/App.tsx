import { Route, Routes, useLocation } from "react-router-dom";
import { ClusterMap } from "./pages/ClusterMap.js";
import { InterestMap } from "./pages/InterestMap.js";
import { Kiosk } from "./pages/Kiosk.js";
import { Onboarding } from "./pages/Onboarding.js";
import { Schedule } from "./pages/Schedule.js";
import { Search } from "./pages/Search.js";
import { lazy, Suspense, useEffect, useRef } from "react";
import { Status } from "./pages/Status.js";
import { TalkDetail } from "./pages/TalkDetail.js";
import { Organizer } from "./pages/Organizer.js";
import { SiteFooter } from "./components/SiteFooter.js";
import { SiteHeader } from "./components/SiteHeader.js";

const NavDemo = lazy(() => import("./pages/NavDemo.js"));

/** Full-page navigation to the static site under /site/ (a seam so tests can observe it without jsdom navigating). */
export const siteNavigation = { replace: (url: string) => window.location.replace(url) };

/** The product front door and sign-up are the static site, not React routes: send the browser there. */
function GoToSite({ to, keepQuery = false }: { to: string; keepQuery?: boolean }) {
  const { search, hash } = useLocation();
  const target = keepQuery ? `${to}${search}${hash}` : to;
  useEffect(() => { siteNavigation.replace(target); }, [target]);
  return <p role="status">Taking you to <a href={target}>{to === "/site/" ? "the Conference Companion home page" : "sign-up"}</a>…</p>;
}

export function App({ navEnabled = import.meta.env.NAV_ESTIMATOR === "on" }: { navEnabled?: boolean } = {}) {
  const { pathname } = useLocation();
  const previousPath = useRef(pathname);
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    if (previousPath.current !== pathname) {
      main.current?.focus();
      previousPath.current = pathname;
    }
  }, [pathname]);
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <SiteHeader />
      <main ref={main} id="main-content" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<GoToSite to="/site/" />} />
          <Route path="/register" element={<GoToSite to="/site/register.html" keepQuery />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/search" element={<Search />} />
          <Route path="/kiosk" element={<Kiosk />} />
          <Route path="/map" element={<InterestMap />} />
          <Route path="/clusters" element={<ClusterMap />} />
          <Route path="/talks/:id" element={<TalkDetail />} />
          <Route path="/status" element={<Status />} />
          <Route path="/organizer" element={<Organizer />} />
          {navEnabled && <Route path="/nav-demo" element={<Suspense fallback={<p role="status">Loading replay…</p>}><NavDemo /></Suspense>} />}
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
      <SiteFooter />
    </>
  );
}
