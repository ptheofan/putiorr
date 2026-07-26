// The in-page grab feedback: what each state says, how long it stays, and the
// surface it is drawn on.
//
// It exists because chrome.notifications is not a channel the extension can
// rely on. macOS suppresses notifications under any Focus mode, and again when
// Chrome is not enabled in System Settings › Notifications, without telling the
// sender — and since a captured click is preventDefault-ed, a swallowed
// notification is indistinguishable from a broken extension. The notification
// stays: it is the only channel when the tab is in the background.
//
// The document is passed in rather than reached for globally, which is what
// lets the node tests drive the whole surface instead of only the strings.
// Being a module, it also has to be listed in web_accessible_resources: a
// content script may only import from there.

// Long enough to read a release name at a glance, short enough that a page is
// not wearing a badge a minute later.
export const SUCCESS_LIFETIME_MS = 6000;
// A failure carries putiorr's own remediation sentence, which is a paragraph
// rather than a glance, and the user may well be reading it while fixing the
// thing it names.
export const FAILURE_LIFETIME_MS = 20000;

const HOST_ID = 'putiorr-grab-feedback';

// The tokens, panel and accent colours below are the putiorr set the options
// page already carries (extension/options.css), trimmed to what one toast uses.
//
// Two things about this stylesheet are load-bearing rather than taste:
//
// `all: initial` on the host stops every inherited page style at the boundary —
// this runs on <all_urls>, and a site's `font-size: 200%` or `text-transform`
// would otherwise come through. It does *not* reset custom properties, so every
// token the toast draws with is redefined here; inheriting a page's `--text`
// would repaint the toast with it.
//
// The `!important` on the host's own layout is the one case where it is
// correct: for the host element, a page's normal declarations outrank the
// shadow tree's `:host` rules, and only an important one wins them back. A page
// that sets `div { position: static }` must not be able to drop the toast into
// its own flow.
const STYLE = `
:host {
  all: initial !important;
  position: fixed !important;
  top: 16px !important;
  right: 16px !important;
  z-index: 2147483647 !important;
  display: block !important;
  width: min(23rem, calc(100vw - 32px)) !important;
  max-height: calc(100vh - 32px) !important;
  overflow: hidden !important;
  /* The page keeps its own clicks everywhere the toasts are not. */
  pointer-events: none !important;
  color-scheme: light;

  --panel: #ffffff;
  --panel-2: #f1f0fa;
  --text: #1a1a2e;
  --muted: #6b6b85;
  --line: #e4e2f0;
  --accent: #7c3aed;
  --danger: #b42318;
  --ok: #16803f;
  --shadow: 0 18px 50px rgba(23, 35, 38, 0.18);
}

@media (prefers-color-scheme: dark) {
  :host {
    color-scheme: dark;

    --panel: #14141f;
    --panel-2: #1e1e2e;
    --text: #f3f3f8;
    --muted: #9a9ab2;
    --line: #2b2b3d;
    --accent: #a78bfa;
    --danger: #f47373;
    --ok: #34d399;
    --shadow: 0 18px 50px rgba(0, 0, 0, 0.5);
  }
}

.stack {
  display: grid;
  gap: 8px;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  text-align: left;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  box-sizing: border-box;
  padding: 10px 10px 10px 12px;
  border: 1px solid var(--line);
  border-left: 4px solid var(--accent);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  box-shadow: var(--shadow);
}

.toast.success {
  border-left-color: var(--ok);
}

.toast.failure {
  border-left-color: var(--danger);
}

.text {
  flex: 1 1 auto;
  min-width: 0;
  display: grid;
  gap: 3px;
}

.title {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.toast.pending .title {
  color: var(--muted);
}

.detail {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.detail:empty {
  display: none;
}

.close {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.close:hover {
  background: var(--panel-2);
  color: var(--text);
}

.close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: no-preference) {
  .toast {
    animation: putiorr-toast-in 160ms ease-out;
  }
}

@keyframes putiorr-toast-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}
`;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// The click has already visibly done nothing — it was swallowed by
// preventDefault — so the acknowledgement has to be immediate and must not
// claim an outcome it does not have yet. Nothing but the answer replaces it.
//
// It names putiorr and the action, because "sending" said neither what would
// come of it nor what was doing it. The profile is named only when the caller
// was told one — a right-click pick, which is the single grab whose profile is
// known before putiorr answers. A captured click has no such name: routing is
// resolved server-side, from browser sites this extension deliberately does not
// cache, and a guess that the answer went on to contradict would read as a bug
// rather than as feedback. The trailing ellipsis is what separates this from
// the settled title of the same grab, which matters on a surface announced by a
// screen reader.
export function pendingFeedback(profileName) {
  const name = text(profileName);
  return {
    tone: 'pending',
    title: name ? `Downloading with putiorr using ${name} profile…` : 'Downloading with putiorr…',
    detail: '',
    lifetimeMs: 0,
  };
}

// Turns what the service worker answered into what the page shows.
export function feedbackFor(result) {
  if (result?.ok === true) {
    const profileName = text(result.profileName);
    return {
      tone: 'success',
      // No local guess when the response named no profile: which profile takes
      // a site is resolved on the server, from a list this side does not hold.
      title: profileName ? `Downloading with putiorr using ${profileName} profile` : 'Downloading with putiorr',
      detail: text(result.transferName),
      lifetimeMs: SUCCESS_LIFETIME_MS,
    };
  }
  // Verbatim, on purpose. putiorr's message is the entire remediation path — a
  // disabled profile, no profile claiming the site, rejected credentials — and
  // it is already worded for exactly that. A summary here would be a second
  // copy of it on a surface that ships on Chrome's schedule, free to drift.
  const error = text(result?.error) || 'putiorr did not answer';
  return { tone: 'failure', title: `Failed — ${error}`, detail: '', lifetimeMs: FAILURE_LIFETIME_MS };
}

// Builds the shadow-root surface lazily and hands back one `show(state)`. Every
// toast it returns can be updated in place or dismissed.
export function createFeedbackSurface(doc) {
  let host = null;
  let stack = null;

  function mount() {
    // Single-page apps replace whole subtrees; a host that went with one would
    // leave every later grab drawing into a detached node.
    if (host?.isConnected) return;
    host = doc.createElement('div');
    host.id = HOST_ID;
    // Closed: the page cannot reach in to read the toast or restyle it, and
    // nothing here needs the page to be able to.
    const root = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    stack = doc.createElement('div');
    stack.classList.add('stack');
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    root.appendChild(stack);
    // documentElement rather than body: a page is free not to have a body yet,
    // and the host is fixed-position so it takes part in no layout either way.
    (doc.documentElement ?? doc.body).appendChild(host);
  }

  function show(state) {
    mount();

    const toast = doc.createElement('div');
    toast.classList.add('toast');
    const block = doc.createElement('div');
    block.classList.add('text');
    const title = doc.createElement('p');
    title.classList.add('title');
    const detail = doc.createElement('p');
    detail.classList.add('detail');
    block.appendChild(title);
    block.appendChild(detail);
    const close = doc.createElement('button');
    close.classList.add('close');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    toast.appendChild(block);
    toast.appendChild(close);
    stack.appendChild(toast);

    let tone = '';
    let timer = null;

    function dismiss() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      toast.remove();
    }

    function update(next) {
      if (tone) toast.classList.remove(tone);
      tone = next.tone;
      toast.classList.add(tone);
      // textContent, never markup: a release name and an error message both
      // came off the network, and this runs on every site.
      title.textContent = next.title;
      detail.textContent = next.detail ?? '';
      if (timer !== null) clearTimeout(timer);
      timer = next.lifetimeMs > 0 ? setTimeout(dismiss, next.lifetimeMs) : null;
    }

    // addEventListener rather than an attribute: an inline handler is markup a
    // strict page CSP would refuse to run.
    close.addEventListener('click', dismiss);
    update(state);

    return { update, dismiss };
  }

  return { show };
}
