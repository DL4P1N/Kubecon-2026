/* Page glue for index.html, conference.html and register.html. Mounts nothing of its own:
   the scene (scene/venue.js), the QR (js/qr.js), the chat (js/chat.js), app links and the status badge
   (js/companion-api.js) auto-run. This file renders the finder, fills a conference page from ?c=,
   and drives the journey section's words, rail and scene control. */

const DEFAULT_SLUG = 'cloud-native-hackathon-slc-2026';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseDay(iso) { const [y, m, d] = String(iso).split('-').map(Number); return new Date(Date.UTC(y, (m || 1) - 1, d || 1)); }
export function formatDates(c, weekday = false) {
  if (!c || !c.startDate) return '';
  const a = parseDay(c.startDate), b = parseDay(c.endDate || c.startDate);
  const wd = weekday ? WEEKDAYS[a.getUTCDay()] + ' ' : '';
  const same = a.getTime() === b.getTime();
  if (same) return `${wd}${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  const sameMonth = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
  return sameMonth
    ? `${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`
    : `${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

let confModule = null;
async function conferences() {
  if (confModule) return confModule;
  try { confModule = await import('./conferences.js'); } catch (e) { confModule = {}; }
  return confModule;
}
async function listAll() {
  const m = await conferences();
  if (typeof m.loadConferences !== 'function') return null;
  try { const l = await m.loadConferences(); return Array.isArray(l) && l.length ? l : null; } catch (e) { return null; }
}

/* ---------------------------------------------------------------- finder (index) */
async function initFinder() {
  const form = $('[data-find-form]');
  const out = $('[data-conference-results]');
  if (!form || !out) return;
  const q = $('[data-find-q]', form), topicSel = $('[data-find-topic]', form), count = $('[data-find-count]', form);
  form.addEventListener('submit', (e) => e.preventDefault());
  const list = await listAll();
  if (!list) return;                                    // the first-paint list stays
  const m = await conferences();
  const topics = [...new Set(list.flatMap((c) => c.topics || []))].sort((a, b) => a.localeCompare(b));
  topicSel.innerHTML = '<option value="">All topics</option>' + topics.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  const card = (c) => `<li${c.assumed ? ' data-assumed' : ''}><a class="card find-card"${c.assumed ? ' data-assumed' : ''}${c.assumed ? '' : ' data-real'} href="conference.html?c=${encodeURIComponent(c.slug)}"><span class="find-card__name">${esc(c.name)}</span><span class="find-card__meta">${esc(c.city)} · ${esc(c.venue)}</span><span class="find-card__date">${esc(formatDates(c))}</span></a></li>`;
  const render = () => {
    const opts = { q: q.value.trim(), topic: topicSel.value };
    const hits = typeof m.filterConferences === 'function' ? m.filterConferences(list, opts) : list;
    out.innerHTML = hits.length ? hits.map(card).join('') : '<li class="find__empty"><strong>No conference matches.</strong> Clear the search or pick another topic.</li>';
    count.textContent = hits.length === 1 ? '1 conference' : `${hits.length} conferences`;
  };
  q.addEventListener('input', render);
  topicSel.addEventListener('change', render);
  render();
}

/* ---------------------------------------------------------------- next event (index hero): the soonest real event that has not ended */
async function initNextEvent() {
  const box = $('[data-next-event]');
  if (!box) return;
  const list = await listAll();
  const m = await conferences();
  const c = list && typeof m.nextEvent === 'function' ? m.nextEvent(list) : null;
  if (!c) return;                                       // the first-paint event stays
  const place = c.venue && c.venue !== m.VENUE_TBA ? `${c.venue}, ${c.city}` : c.city;
  $('[data-next-name]', box).textContent = c.name;
  $('[data-next-meta]', box).textContent = `${formatDates(c, true)}, ${place}`;
  const qr = $('canvas[data-qr]', box);
  if (qr) {
    qr.setAttribute('data-qr-conference', c.slug);
    qr.setAttribute('aria-label', `QR code that opens registration for ${c.name} on your phone`);
    import('./qr.js').then((q) => q.renderAll(box)).catch(() => {});
  }
  const cta = $('[data-next-register]');
  if (cta) cta.href = `register.html?c=${encodeURIComponent(c.slug)}`;
}

/* ---------------------------------------------------------------- conference page and register page: facts from ?c= */
async function initConference() {
  const marks = $$('[data-c]');
  if (!marks.length) return;
  const slug = new URLSearchParams(location.search).get('c') || DEFAULT_SLUG;
  const m = await conferences();
  let c = null;
  try { c = typeof m.getConference === 'function' ? await m.getConference(slug) : null; } catch (e) { c = null; }
  const root = document.documentElement;
  if (!c) {
    if (slug !== DEFAULT_SLUG && typeof m.getConference === 'function') root.setAttribute('data-conference-missing', slug);
    return;                                            // first-paint facts stay (the default event)
  }
  root.setAttribute('data-conference', c.slug);
  if (c.assumed) root.setAttribute('data-assumed', '');
  const val = {
    name: c.name, city: c.city, venue: c.venue, summary: c.summary,
    date: formatDates(c, true), 'date-long': formatDates(c, true),
    place: c.venue === m.VENUE_TBA ? c.city : `${c.venue}, ${c.city}`, capacity: c.capacity ? String(c.capacity) : '',
    topics: (c.topics || []).join(', '),
  };
  marks.forEach((el) => { const k = el.getAttribute('data-c'); if (k in val && val[k]) el.textContent = val[k]; });
  $$('[data-c-topics]').forEach((el) => { el.innerHTML = (c.topics || []).map((t) => `<li class="ic-chip">${esc(t)}</li>`).join(''); });
  $$('a[data-c-link]').forEach((a) => {
    const base = a.getAttribute('data-c-link');
    const via = a.getAttribute('data-via');
    a.href = `${base}?c=${encodeURIComponent(c.slug)}${via ? `&via=${via}` : ''}`;
  });
  const base = document.title.split(':')[0];
  if (document.body.hasAttribute('data-conference-title')) document.title = `${c.name}: ${document.body.getAttribute('data-conference-title')}`;
  else if (base) document.title = `${c.name}, ${base}`;
}

/* ---------------------------------------------------------------- sign-in links carry ?c= and &via= even before data loads */
function initLinks() {
  const slug = new URLSearchParams(location.search).get('c') || DEFAULT_SLUG;
  $$('a[data-c-link]').forEach((a) => {
    const via = a.getAttribute('data-via');
    a.href = `${a.getAttribute('data-c-link')}?c=${encodeURIComponent(slug)}${via ? `&via=${via}` : ''}`;
  });
}

/* ---------------------------------------------------------------- journey HUD: the rail and counter follow whichever journey section is on screen.
   The scene (scene/venue.js) wires its own control buttons; this only drives the rail. */
function initJourney() {
  const secs = $$('.scene-sec');
  const rail = $('[data-hud-rail]');
  if (!secs.length || !rail) return;
  const ticks = $$('.rail__tick', rail), fill = $('.rail__fill', rail), count = $('.rail__count', rail);
  const pad = (n) => String(n).padStart(2, '0');
  let raf = 0;
  const update = () => {
    raf = 0;
    const mid = innerHeight / 2;
    const first = secs[0].getBoundingClientRect(), last = secs[secs.length - 1].getBoundingClientRect();
    const inside = first.top < mid && last.bottom > mid;
    rail.classList.toggle('is-on', inside);
    if (!inside) return;
    let cur = 0;
    secs.forEach((s, i) => { if (s.getBoundingClientRect().top <= mid) cur = i; });
    ticks.forEach((tk, k) => tk.classList.toggle('is-on', k <= cur));
    if (count) count.textContent = pad(cur + 1) + ' / ' + pad(secs.length);
    const p = (mid - first.top) / Math.max(1, last.bottom - first.top);
    if (fill) fill.style.setProperty('--p', Math.max(0, Math.min(1, p)).toFixed(3));
  };
  const on = () => { if (!raf) raf = requestAnimationFrame(update); };
  addEventListener('scroll', on, { passive: true });
  addEventListener('resize', on);
  update();
}

initLinks();
initJourney();
initFinder();
initNextEvent();
initConference();
