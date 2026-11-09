// Production-asset test server with synthetic API fixtures, never a live-data claim.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve("dist");
const talk = { id: "offline-demo", title: "Synthetic offline schedule", speaker: "Demo", abstract: "Public talk detail",
  track: "Security", room: "Demo room", start: "2026-11-09T20:00:00Z", end: "2026-11-09T20:30:00Z", tags: ["security"] };
createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/schedule") {
      if (!req.headers.authorization || req.headers.authorization === "Bearer expired") {
        res.writeHead(401); return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      return res.end(JSON.stringify({ items: [{ talk, reason: "Private recommendation omitted from offline storage" }], updatedAt: new Date().toISOString() }));
    }
    if (url.pathname === "/api/talks/offline-demo") return res.end(JSON.stringify({ talk }));
    if (url.pathname === "/api/access/token") return res.end(JSON.stringify({ token: "synthetic-qr-secret", expiresAt: new Date(Date.now() + 60000).toISOString() }));
    if (url.pathname === "/api/register") return res.end(JSON.stringify({ token: "synthetic-registration-secret" }));
    if (url.pathname === "/api/catalog/topics") return res.end(JSON.stringify({ topics: ["security"] }));
    return res.end("{}");
  }
  if (url.pathname.startsWith("/otlp/")) { res.setHeader("content-type", "application/json"); return res.end("{}"); }
  try {
    const file = resolve(root, `.${url.pathname}`);
    if (!file.startsWith(`${root}/`) && !file.startsWith(`${root}\\`)) throw new Error("Bad path");
    const staticFile = extname(file) ? file : resolve(root, "index.html");
    const type = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".webmanifest": "application/manifest+json" }[extname(staticFile)] || "application/octet-stream";
    res.setHeader("content-type", type);
    res.end(await readFile(staticFile));
  } catch { res.writeHead(404); res.end(); }
}).listen(4174, "127.0.0.1");
