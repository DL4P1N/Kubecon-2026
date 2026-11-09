const KEY = "cc.offline-session";

/** Random tab/session namespace, never derived from an attendee ID or token. */
export function offlineSession(): string | null {
  try {
    let id = sessionStorage.getItem(KEY);
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(KEY, id); }
    return id;
  } catch { return null; }
}

/** Post to the controlling worker, or fall back to the registration's active/waiting/installing worker. */
function postToWorker(message: unknown): void {
  const container = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
  if (!container) return;
  if (container.controller) { container.controller.postMessage(message); return; }
  void Promise.resolve(container.getRegistration?.())
    .then((registration) => (registration?.active ?? registration?.waiting ?? registration?.installing)?.postMessage(message))
    .catch(() => { /* Offline caching is optional. */ });
}

export function resetOfflineSession(): void {
  try {
    const previous = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (previous) postToWorker({ type: "forget-schedule", session: previous });
  } catch { /* Storage and offline caching are optional. */ }
}

export function offlineExpiry(token: string): number {
  const maximum = Date.now() + 24 * 60 * 60 * 1000;
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    return Number.isFinite(payload.exp) ? Math.min(maximum, payload.exp * 1000) : maximum;
  } catch { return maximum; }
}
