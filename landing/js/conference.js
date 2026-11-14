/* Conference page: fills the page from ?c=<slug>, points the QR and the register links at it, and shows a
   not-found state for a slug that is not in the catalogue. Plain ES module; js/qr.js draws the QR on its own and
   reads ?c= itself, so this file only keeps the canvas's fallback slug and every register link in step.
   Without script, or while it loads, the static HTML is the default event (the one real one). */
import { loadConferences, getConference, DEFAULT_SLUG, VENUE_TBA } from './conferences.js';

const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const day = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(Date.UTC(y, (m || 1) - 1, d || 1)); };

function formatDates(c) {
  if (!c || !c.startDate) return '';
  const a = day(c.startDate), b = day(c.endDate || c.startDate);
  const wd = `${WEEKDAYS[a.getUTCDay()]} `;
  if (a.getTime() === b.getTime()) return `${wd}${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`;
  const sameMonth = a.getUTCMonth() === b.getUTCMonth() && a.getUTCFullYear() === b.getUTCFullYear();
  return sameMonth
    ? `${wd}${a.getUTCDate()}–${b.getUTCDate()} ${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`
    : `${wd}${a.getUTCDate()} ${MONTHS[a.getUTCMonth()]} – ${b.getUTCDate()} ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

const slug = new URLSearchParams(location.search).get('c') || DEFAULT_SLUG;

/* before anything is awaited, so js/qr.js (which awaits the config first) and the links agree with the address */
$$('canvas[data-qr="self"]').forEach((cv) => cv.setAttribute('data-qr-conference', slug));
function pointLinks(s) {
  $$('a[data-c-link]').forEach((a) => {
    const via = a.getAttribute('data-via');
    a.href = `${a.getAttribute('data-c-link')}?c=${encodeURIComponent(s)}${via ? `&via=${encodeURIComponent(via)}` : ''}`;
  });
}
pointLinks(slug);

function setMeta(sel, attr, value) { const el = document.querySelector(sel); if (el && value) el.setAttribute(attr, value); }

function showMissing() {
  const root = document.documentElement;
  root.setAttribute('data-conference-missing', slug);
  const h1 = document.querySelector('#hero-h');
  if (h1) h1.textContent = 'Conference not found';
  const lead = document.querySelector('.cc-hero .hero__lead');
  if (lead) lead.hidden = true;
  const note = document.querySelector('[data-missing]');
  if (note) note.hidden = false;
  document.title = 'Conference not found: Conference Companion';
}

function fill(c) {
  const root = document.documentElement;
  root.setAttribute('data-conference', c.slug);
  const val = {
    name: c.name, city: c.city, venue: c.venue, summary: c.summary,
    date: formatDates(c), capacity: c.capacity ? String(c.capacity) : '',
  };
  $$('[data-c]').forEach((el) => { const k = el.getAttribute('data-c'); if (val[k]) el.textContent = val[k]; });
  /* facts the organisers have not published are left out, not guessed */
  $$('[data-c-row="capacity"]').forEach((el) => { el.hidden = !c.capacity; });
  $$('[data-c-row="site"]').forEach((el) => { el.hidden = !c.url; });
  $$('a[data-c-site]').forEach((a) => { if (c.url) a.href = c.url; });
  $$('[data-c-topics]').forEach((el) => {
    el.replaceChildren(...(c.topics || []).map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
  });
  /* invented demo events say so, on the elements that show their facts */
  $$('[data-c-facts]').forEach((el) => { if (c.assumed) el.setAttribute('data-assumed', ''); else el.removeAttribute('data-assumed'); });
  const demo = document.querySelector('[data-demo-note]');
  if (demo) demo.hidden = !c.assumed;
  if (c.assumed) root.setAttribute('data-assumed', ''); else root.removeAttribute('data-assumed');
  const suffix = document.body.getAttribute('data-conference-title') || 'register by QR code or sign-in';
  document.title = `${c.name}: ${suffix}`;
  const when = c.venue === VENUE_TBA ? `${formatDates(c)}, ${c.city}` : `${formatDates(c)}, ${c.venue}, ${c.city}`;
  setMeta('meta[name="description"]', 'content', `${c.name}, ${when}. Scan the QR code to register from your phone, or continue with GitHub.`);
  setMeta('meta[property="og:title"]', 'content', document.title);
  setMeta('meta[property="og:description"]', 'content', `${when}. Register from your phone.`);
}

async function init() {
  let c = null;
  try { await loadConferences(); } catch (e) { /* the inlined catalogue answers */ }
  try { c = getConference(slug); } catch (e) { c = null; }
  if (!c) { if (slug !== DEFAULT_SLUG) showMissing(); return; }
  fill(c);
  pointLinks(c.slug);
}
init();

/* The word-highlight moment (assets/moments, read-only) names its host with aria-label, which a plain <p> may not carry
   (axe aria-prohibited-attr), and hides every word span. Keep the real words readable instead: drop the label and
   the aria-hidden after the moment mounts, and again if it re-splits. */
function keepWordsReadable() {
  const host = document.querySelector('.mo-wh__text');
  if (!host) return;
  const tidy = () => {
    if (host.hasAttribute('aria-label')) host.removeAttribute('aria-label');
    host.querySelectorAll('[aria-hidden="true"]').forEach(n => n.removeAttribute('aria-hidden'));
  };
  tidy();
  new MutationObserver(tidy).observe(host, { attributes: true, attributeFilter: ['aria-label', 'aria-hidden'], childList: true, subtree: true });
}
keepWordsReadable();
