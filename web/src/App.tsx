import { Link, Navigate, Route, Routes } from "react-router-dom";
import { Kiosk } from "./pages/Kiosk.js";
import { Onboarding } from "./pages/Onboarding.js";
import { Register } from "./pages/Register.js";
import { Schedule } from "./pages/Schedule.js";
import { Search } from "./pages/Search.js";

export function App() {
  return (
    <>
      <header>
        <nav aria-label="Main" style={{ display: "flex", gap: "1rem" }}>
          <Link to="/register">Register</Link>
          <Link to="/onboarding">Onboarding</Link>
          <Link to="/schedule">Schedule</Link>
          <Link to="/search">Search</Link>
          <Link to="/kiosk">Kiosk</Link>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Navigate to="/register" replace />} />
          <Route path="/register" element={<Register />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/schedule" element={<Schedule />} />
          <Route path="/search" element={<Search />} />
          <Route path="/kiosk" element={<Kiosk />} />
          <Route path="*" element={<p>Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}
