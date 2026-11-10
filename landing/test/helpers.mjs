import http from "node:http";
import { createApp } from "../server.mjs";

/** Starts the landing app on an ephemeral port. `opts` go to createApp(); `env` is merged over a quiet default. */
export async function startApp({ env = {}, ...opts } = {}) {
  const lines = [];
  const app = createApp({
    log: (l) => lines.push(l),
    env: { PATH: "", HOST: "127.0.0.1", API_BASE: "http://127.0.0.1:1", ...env }, // port 1: nothing listens
    claudeBin: null,
    ...opts,
  });
  const addr = await app.listen(0, "127.0.0.1");
  return { app, base: `http://127.0.0.1:${addr.port}`, port: addr.port, lines, close: () => app.close() };
}

/** Raw request (no URL normalisation), for traversal attempts. */
export function rawGet(port, rawPath, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

export const postJson = (base, path, body, init = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body), ...init });

/** A stand-in for the real API. `handler(req, bodyText) => [status, json]`. */
export async function fakeApi(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: text });
      const [status, json] = handler(req, text);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

export const validProfile = () => ({
  name: "Ada",
  role: "platform engineer",
  interests: ["kubernetes", "observability", "ai sre"],
  goal: "learn",
  formats: "deep dives",
});

