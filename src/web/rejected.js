// Issue #111. The rejection log's own screen.
//
// A blocklist is permanent, invisible, and made without asking. This is the only
// place a wrong one can be noticed after the fact, which is why it gets a page
// rather than a strip under the downloads list, and why unread rows raise a
// badge in the sidebar: the whole point is that someone looks.
//
// Read-only by design. There is nothing here to undo — the release is gone from
// put.io and the *arr has already been told — only something to notice.
import { state, el } from './state.js';
import { api } from './api.js';
import { setText, setHidden, setDisabled, formatDateTime, rejectedReleasesSummary } from './util.js';

const PAGE_SIZE = 25;
// Long enough that typing a release name is one request, short enough that the
// list does not feel stale under the cursor.
const SEARCH_DEBOUNCE_MS = 250;

let searchTimer;
// Responses can land out of order — a slow "R" arriving after a fast "Radarr"
// would repaint the page with the wrong result set and no way to tell.
let requestSeq = 0;

export function rejectedQuery({ page = 1, search = '', outcome = '' } = {}) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (search) params.set('search', search);
  if (outcome) params.set('outcome', outcome);
  return `/api/rejected-releases?${params}`;
}

// What the pager says when there is nothing to page. Kept here rather than in
// the template so the empty state can say why it is empty: an unfiltered empty
// log is good news, a filtered one is a search that matched nothing.
export function rejectedEmptyMessage({ total = 0, search = '', outcome = '', error = '' } = {}) {
  // A load that failed is not an empty log, and saying "nothing rejected" when
  // the request died would be the most misleading thing this screen could say.
  if (error) return error;
  if (total > 0) return '';
  if (search || outcome) return 'No rejected release matches this filter.';
  return 'Nothing has been rejected. Releases putiorr turns away will be listed here.';
}

export function rejectedPageLabel({ page = 1, pages = 1, total = 0 } = {}) {
  if (total === 0) return '';
  return `Page ${page} of ${pages} · ${total} release${total === 1 ? '' : 's'}`;
}

export async function loadRejectedReleases({ page, search, outcome } = {}) {
  const current = state.rejectedPage;
  const next = {
    page: page ?? current.page,
    search: search ?? current.search,
    outcome: outcome ?? current.outcome,
  };
  const token = ++requestSeq;
  const payload = await api(rejectedQuery(next));
  // A newer request has already been issued; this answer is stale.
  if (token !== requestSeq) return;
  state.rejectedPage = { ...state.rejectedPage, ...next, ...payload, error: '' };
  // The API answers with the live unread count, so the badge stays honest even
  // when this page is the only thing being looked at.
  state.rejectedReleases = { ...state.rejectedReleases, ...payload.counts, unread: payload.unread };
  renderRejectedReleases();
  renderRejectedBadge();
}

export function renderRejectedBadge() {
  const unread = Number(state.rejectedReleases?.unread ?? 0);
  setHidden(el.rejectedNavBadge, unread === 0);
  // Past a point the exact number stops being the useful part.
  setText(el.rejectedNavBadge, unread > 99 ? '99+' : String(unread));
}

export function renderRejectedReleases() {
  const view = state.rejectedPage ?? {};
  const rows = Array.isArray(view.rows) ? view.rows : [];

  setText(el.rejectedReleasesSummary, rejectedReleasesSummary(state.rejectedReleases));
  setText(el.rejectedEmpty, rejectedEmptyMessage(view));
  setHidden(el.rejectedEmpty, rows.length > 0);
  setHidden(el.rejectedPager, view.total === 0 || Boolean(view.error));
  setText(el.rejectedPageLabel, rejectedPageLabel(view));
  setDisabled(el.rejectedPrev, view.page <= 1);
  setDisabled(el.rejectedNext, view.page >= view.pages);
  setDisabled(el.rejectedReadAllButton, Number(state.rejectedReleases?.unread ?? 0) === 0);

  el.rejectedReleasesList.replaceChildren();
  for (const row of rows) {
    const undelivered = row.outcome !== 'blocklisted';
    const card = document.createElement('article');
    card.className = [
      'download-card rejected-release',
      undelivered ? 'rejected-release-undelivered' : '',
      row.read_at ? '' : 'rejected-release-unread',
    ].filter(Boolean).join(' ');
    card.setAttribute('data-testid', 'rejected-release');
    card.dataset.outcome = row.outcome || '';
    card.innerHTML = `
      <div class="download-head">
        <span class="download-name" data-role="name"></span>
        <span class="download-status" data-role="outcome"></span>
      </div>
      <div class="download-facts">
        <span data-role="reason"></span>
        <span data-role="origin"></span>
      </div>
    `;
    setText(card.querySelector('[data-role="name"]'), row.name || '(unnamed)');
    setText(
      card.querySelector('[data-role="outcome"]'),
      undelivered ? 'Downloaded anyway' : 'Blocklisted',
    );
    setText(card.querySelector('[data-role="reason"]'), row.reason || 'No reason recorded');
    setText(
      card.querySelector('[data-role="origin"]'),
      `${row.profile_name || 'Unknown profile'} · ${formatDateTime(row.rejected_at)}`,
    );
    el.rejectedReleasesList.appendChild(card);
  }
}

export async function markAllRejectedRead() {
  setDisabled(el.rejectedReadAllButton, true);
  try {
    await api('/api/rejected-releases/read-all', { method: 'POST', body: '{}' });
  } finally {
    // Reloaded either way: on success to drop the unread styling, and on failure
    // so the button's state matches what the server actually holds.
    reload({});
  }
}

// A failed load says so on the screen rather than leaving the last result set
// sitting there looking current.
function reload(change) {
  loadRejectedReleases(change).catch((error) => {
    state.rejectedPage = { ...state.rejectedPage, ...change, rows: [], total: 0, error: error.message };
    renderRejectedReleases();
  });
}

export function initRejectedReleases() {
  el.rejectedReadAllButton.addEventListener('click', () => {
    markAllRejectedRead().catch(() => {});
  });
  // Any filter change goes back to page one: staying on page 4 of a result set
  // that now has two pages shows an empty screen with no way back.
  el.rejectedSearch.addEventListener('input', (event) => {
    const term = String(event.target?.value ?? '');
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => reload({ page: 1, search: term }), SEARCH_DEBOUNCE_MS);
  });
  el.rejectedOutcome.addEventListener('change', (event) => {
    reload({ page: 1, outcome: String(event.target?.value ?? '') });
  });
  el.rejectedPrev.addEventListener('click', () => {
    reload({ page: Math.max(1, state.rejectedPage.page - 1) });
  });
  el.rejectedNext.addEventListener('click', () => {
    reload({ page: Math.min(state.rejectedPage.pages, state.rejectedPage.page + 1) });
  });
}
