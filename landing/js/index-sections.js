/* index.html, the five lower sections. js/pages.js renders the conference finder (filter, count, cards,
   the no-results line); this file only adds to it: a "See all conferences" button in the no-results state,
   which clears the search and the topic and lets pages.js render the full list again. It never renders
   cards itself, so the two cannot double-render. */

const results = document.querySelector('[data-conference-results]');
const form = document.querySelector('[data-find-form]');

if (results && form) {
  const q = form.querySelector('[data-find-q]');
  const topic = form.querySelector('[data-find-topic]');

  const addReset = () => {
    const empty = results.querySelector('.find__empty');
    if (!empty || empty.querySelector('button')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'See all conferences';
    b.addEventListener('click', () => {
      if (q) { q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); }
      if (topic) { topic.value = ''; topic.dispatchEvent(new Event('change', { bubbles: true })); }
      if (q) q.focus();
    });
    empty.append(b);
  };

  new MutationObserver(addReset).observe(results, { childList: true });
  addReset();
}
