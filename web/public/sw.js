/* No requests or responses containing credentials are stored. */
const SHELL = `cc-shell-${new URL(self.location.href).searchParams.get("build") || "v1"}`;
const SCHEDULES = "cc-schedules-v1";
const TALKS = "cc-talks-v1";
const validSession = (id) => /^[0-9a-f-]{36}$/.test(id || "");
const scheduleKey = (id) => new URL(`/__offline/schedule/${id}`, self.location.origin).href;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const response = await fetch("/index.html", { cache: "reload" });
    if (!response.ok) throw new Error("Shell unavailable");
    const html = await response.clone().text();
    // Vite's production assets are content-hashed. Precache CSS and entry JS.
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map((match) => match[1]);
    await cache.addAll(assets);
    await cache.put("/index.html", response);
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("cc-") && ![SHELL, SCHEDULES, TALKS].includes(name)) await caches.delete(name);
    }
    const cache = await caches.open(SCHEDULES);
    for (const key of await cache.keys()) {
      const saved = await cache.match(key);
      if (Number(saved?.headers.get("x-cc-offline-until")) <= Date.now()) await cache.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "forget-schedule" && validSession(event.data.session)) {
    event.waitUntil(caches.open(SCHEDULES).then((cache) => cache.delete(scheduleKey(event.data.session))));
  }
});

async function schedule(request) {
  const id = request.headers.get("x-cc-offline-session");
  if (!validSession(id) || !request.headers.has("authorization")) return fetch(request);
  let cache;
  try { cache = await caches.open(SCHEDULES); } catch { return fetch(request); }
  const key = scheduleKey(id);
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const saved = await cache.match(key);
    if (saved && Number(saved.headers.get("x-cc-offline-until")) > Date.now()) return saved;
    await cache.delete(key);
    throw error;
  }
  try {
    if (response.status === 401 || response.status === 403) await cache.delete(key);
    if (response.ok) {
      // Cache only schedule items, never response credentials or request headers.
      const data = await response.clone().json();
      const until = Math.min(Number(request.headers.get("x-cc-offline-until")), Date.now() + 86400000);
      if (Array.isArray(data.items) && until > Date.now()) {
        const items = data.items.map(({ talk }) => ({ talk: Object.fromEntries(
          ["id", "title", "speaker", "abstract", "track", "room", "start", "end", "tags", "level"].filter((field) => field in talk).map((field) => [field, talk[field]])
        ) }));
        await cache.put(key, new Response(JSON.stringify({ items, updatedAt: data.updatedAt }), {
          headers: { "content-type": "application/json", "x-cc-offline-saved-at": new Date().toISOString(), "x-cc-offline-until": String(until) },
        }));
      }
    }
  } catch { /* Cache quota or invalid data must not break a successful request. */ }
  return response;
}

async function talkDetail(request) {
  const cache = await caches.open(TALKS);
  // Never store an Authorization header in Cache Storage request keys.
  const key = new URL(request.url).href;
  let response;
  try { response = await fetch(request); } catch (error) {
    const saved = await cache.match(key);
    if (saved && Number(saved.headers.get("x-cc-offline-until")) > Date.now()) return saved;
    await cache.delete(key);
    throw error;
  }
  try {
    if (response.ok) {
      const { talk } = await response.clone().json();
      if (talk && typeof talk.title === "string") {
        const keys = await cache.keys();
        if (keys.length >= 100) await cache.delete(keys[0]);
        await cache.put(key, new Response(JSON.stringify({ talk: Object.fromEntries(
          ["id", "title", "speaker", "abstract", "track", "room", "start", "end", "tags", "level"].filter((field) => field in talk).map((field) => [field, talk[field]])
        ) }), { headers: { "content-type": "application/json", "x-cc-offline-until": String(Date.now() + 86400000) } }));
      }
    } else if (response.status === 404) await cache.delete(key);
  } catch { /* Offline storage is optional. */ }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== "GET") return;
  // OTLP, QR, registration, searches and all other APIs are network-only.
  if (url.pathname === "/api/schedule" && !url.search) {
    event.respondWith(schedule(request));
  } else if (/^\/api\/talks\/[A-Za-z0-9._:-]{1,100}$/.test(url.pathname) && !url.search) {
    event.respondWith(talkDetail(request));
  } else if (request.mode === "navigate" && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/otlp")) {
    event.respondWith(fetch(request).catch(() => caches.open(SHELL).then((cache) => cache.match("/index.html"))));
  } else if (url.pathname.startsWith("/assets/") && !url.search) {
    event.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const saved = await cache.match(url.href);
      if (saved) return saved;
      const response = await fetch(request);
      if (response.ok) await cache.put(url.href, response.clone());
      return response;
    })());
  }
});
