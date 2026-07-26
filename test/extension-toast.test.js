import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  FAILURE_LIFETIME_MS,
  SUCCESS_LIFETIME_MS,
  createFeedbackSurface,
  feedbackFor,
  pendingFeedback,
} from '../extension/lib/toast.js';

// lib/toast.js is the whole in-page feedback: the words each state uses, how
// long it stays, and the shadow-root surface it is drawn on. It takes the
// document as an argument rather than reaching for a global, which is what lets
// these tests drive the real module — copy, timers and DOM shape alike —
// against the stand-in below instead of only checking strings.

const TOAST_URL = new URL('../extension/lib/toast.js', import.meta.url);
const MANIFEST_URL = new URL('../extension/manifest.json', import.meta.url);
const HOST_ID = 'putiorr-grab-feedback';

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.id = '';
    this.children = [];
    this.parent = null;
    this.attributes = {};
    this.listeners = {};
    this.classes = new Set();
    this.isConnected = false;
    // A closed shadow root is unreachable from the element in a browser; the
    // stand-in keeps it here so the tests can see what the page cannot.
    this.shadow = null;
    this.text = '';
  }

  get classList() {
    return {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
  }

  set textContent(value) {
    this.text = String(value);
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join('') : this.text;
  }

  connect(state) {
    this.isConnected = state;
    for (const child of this.children) child.connect(state);
    this.shadow?.connect(state);
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    child.connect(this.isConnected);
    return child;
  }

  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
    this.connect(false);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  attachShadow({ mode }) {
    this.shadow = new FakeElement('#shadow-root');
    this.shadow.mode = mode;
    this.shadow.connect(this.isConnected);
    return this.shadow;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }

  click() {
    for (const fn of this.listeners.click ?? []) fn({ type: 'click' });
  }
}

function createDocument() {
  const documentElement = new FakeElement('html');
  documentElement.isConnected = true;
  return { documentElement, createElement: (tag) => new FakeElement(tag) };
}

function byClass(node, name) {
  if (node.classes.has(name)) return node;
  for (const child of node.children) {
    const hit = byClass(child, name);
    if (hit) return hit;
  }
  return null;
}

function surfaceOf(doc) {
  const hosts = doc.documentElement.children.filter((node) => node.id === HOST_ID);
  const root = hosts.at(-1)?.shadow ?? null;
  return {
    hosts,
    host: hosts.at(-1) ?? null,
    root,
    style: root?.children.find((node) => node.tagName === 'STYLE') ?? null,
    stack: root ? byClass(root, 'stack') : null,
  };
}

function readToasts(doc) {
  const { stack } = surfaceOf(doc);
  return (stack?.children ?? []).map((toast) => ({
    tone: [...toast.classes].find((name) => name !== 'toast'),
    title: byClass(toast, 'title').textContent,
    detail: byClass(toast, 'detail').textContent,
    text: toast.textContent,
  }));
}

test('the pending state acknowledges the click without claiming an outcome', () => {
  const state = pendingFeedback();

  assert.equal(state.tone, 'pending');
  assert.equal(state.title, 'Sending to putiorr…');
  assert.equal(state.detail, '');
  // It is replaced in place by the answer, so nothing may take it away first.
  assert.equal(state.lifetimeMs, 0);
});

test('a success names the profile that took the grab and the release beneath it', () => {
  const state = feedbackFor({ ok: true, profileName: 'Movies', transferName: 'Example.Release.2024.1080p' });

  assert.equal(state.tone, 'success');
  assert.equal(state.title, 'Downloading with Movies profile');
  assert.equal(state.detail, 'Example.Release.2024.1080p');
  assert.equal(state.lifetimeMs, SUCCESS_LIFETIME_MS);
});

test('a putiorr too old to name the profile still reads as a success', () => {
  // Naming a local guess here would be worse than naming nothing: the profile
  // was resolved on the server, from sites this extension does not hold.
  const state = feedbackFor({ ok: true, profileName: '', transferName: '' });

  assert.equal(state.tone, 'success');
  assert.equal(state.title, 'Downloading with putiorr');
  assert.equal(state.detail, '');
});

test("a failure shows putiorr's own message verbatim and outlives a success", () => {
  // The message is the entire remediation path — a disabled profile, a site no
  // profile claims, rejected credentials — and it is already carefully worded.
  const refusal = 'No Putiorr Grab profile claims tracker.x.example and none is set to take'
    + ' everything else; tick "Take grabs from any site no other profile claims" on a profile in putiorr';
  const state = feedbackFor({ ok: false, error: refusal });

  assert.equal(state.tone, 'failure');
  assert.equal(state.title, `Failed — ${refusal}`);
  assert.ok(
    state.lifetimeMs > SUCCESS_LIFETIME_MS,
    `a failure must linger noticeably longer than a success: ${state.lifetimeMs} vs ${SUCCESS_LIFETIME_MS}`,
  );
  assert.equal(state.lifetimeMs, FAILURE_LIFETIME_MS);
});

test('an answer with no message at all still says something actionable', () => {
  for (const result of [undefined, null, {}, { ok: false }, { ok: false, error: '   ' }]) {
    const state = feedbackFor(result);
    assert.equal(state.tone, 'failure');
    assert.equal(state.title, 'Failed — putiorr did not answer');
  }
});

test('the surface is one closed shadow root pinned out of the page flow', () => {
  const doc = createDocument();
  createFeedbackSurface(doc).show(pendingFeedback());

  const { hosts, host, root, style, stack } = surfaceOf(doc);
  assert.equal(hosts.length, 1);
  assert.equal(host.tagName, 'DIV');
  assert.equal(root.mode, 'closed', 'the page must not be able to reach into the feedback');
  assert.equal(stack.attributes.role, 'status');
  assert.equal(stack.attributes['aria-live'], 'polite');

  const css = style.textContent;
  // Inherited page styles stop at the host, and nothing the page defines may
  // reach the tokens the toast is drawn with.
  assert.match(css, /all:\s*initial/);
  assert.match(css, /position:\s*fixed/);
  assert.match(css, /z-index:\s*2147483647/);
  assert.match(css, /top:/);
  assert.match(css, /right:/);
  // The page keeps its own clicks everywhere the toast is not.
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /prefers-color-scheme:\s*dark/);
});

test('every token the toast draws with is defined on the host, not inherited', () => {
  // `all: initial` does not reset custom properties, so a page that happens to
  // define --text or --panel would otherwise repaint the toast with it.
  const source = readFileSync(TOAST_URL, 'utf8');
  const used = new Set([...source.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
  const defined = new Set([...source.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((match) => match[1]));

  assert.ok(used.size > 0, 'the stylesheet should be built from tokens');
  for (const token of used) {
    assert.ok(defined.has(token), `${token} is used but never defined, so the page's value would win`);
  }
});

test('the pending toast resolves in place rather than stacking a second one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = createDocument();
  const handle = createFeedbackSurface(doc).show(pendingFeedback());
  const before = surfaceOf(doc).stack.children[0];

  handle.update(feedbackFor({ ok: true, profileName: 'TV', transferName: 'Example.S01E01' }));

  const after = surfaceOf(doc).stack.children;
  assert.equal(after.length, 1);
  assert.equal(after[0], before, 'the answer replaces the acknowledgement, it does not follow it');
  assert.deepEqual(readToasts(doc), [{
    tone: 'success',
    title: 'Downloading with TV profile',
    detail: 'Example.S01E01',
    text: 'Downloading with TV profileExample.S01E01×',
  }]);
});

test('grabs in quick succession stack instead of overwriting each other', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = createDocument();
  const surface = createFeedbackSurface(doc);

  const first = surface.show(pendingFeedback());
  const second = surface.show(pendingFeedback());
  first.update(feedbackFor({ ok: true, profileName: 'Movies', transferName: 'One' }));
  second.update(feedbackFor({ ok: false, error: 'putiorr is unreachable at http://nas:9091' }));

  assert.deepEqual(readToasts(doc).map(({ tone, title }) => ({ tone, title })), [
    { tone: 'success', title: 'Downloading with Movies profile' },
    { tone: 'failure', title: 'Failed — putiorr is unreachable at http://nas:9091' },
  ]);
  assert.equal(surfaceOf(doc).hosts.length, 1, 'one surface holds them all');
});

test('either state can be dismissed by hand', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = createDocument();
  const surface = createFeedbackSurface(doc);
  surface.show(feedbackFor({ ok: true, profileName: 'Movies', transferName: 'One' }));
  surface.show(feedbackFor({ ok: false, error: 'nope' }));

  for (const toast of [...surfaceOf(doc).stack.children]) {
    const close = byClass(toast, 'close');
    assert.equal(close.attributes['aria-label'], 'Dismiss');
    assert.equal(close.attributes.type, 'button', 'a bare button inside a form would submit it');
    close.click();
  }

  assert.deepEqual(readToasts(doc), []);
});

test('a success clears itself while a failure and a pending state stay', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = createDocument();
  const surface = createFeedbackSurface(doc);

  surface.show(feedbackFor({ ok: true, profileName: 'Movies', transferName: 'One' }));
  surface.show(feedbackFor({ ok: false, error: 'nope' }));
  surface.show(pendingFeedback());

  t.mock.timers.tick(SUCCESS_LIFETIME_MS + 1);
  assert.deepEqual(readToasts(doc).map((toast) => toast.tone), ['failure', 'pending']);

  t.mock.timers.tick(FAILURE_LIFETIME_MS);
  assert.deepEqual(readToasts(doc).map((toast) => toast.tone), ['pending']);

  // Nothing but the answer takes the acknowledgement away.
  t.mock.timers.tick(FAILURE_LIFETIME_MS * 10);
  assert.deepEqual(readToasts(doc).map((toast) => toast.tone), ['pending']);
});

test('a pending toast that resolves takes the success lifetime, not none', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = createDocument();
  const handle = createFeedbackSurface(doc).show(pendingFeedback());

  handle.update(feedbackFor({ ok: true, profileName: 'Movies', transferName: 'One' }));
  t.mock.timers.tick(SUCCESS_LIFETIME_MS + 1);

  assert.deepEqual(readToasts(doc), []);
});

test('a toast dismissed by hand does not come back when its timer fires', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = createDocument();
  const handle = createFeedbackSurface(doc).show(feedbackFor({ ok: false, error: 'nope' }));

  handle.dismiss();
  t.mock.timers.tick(FAILURE_LIFETIME_MS * 2);

  assert.deepEqual(readToasts(doc), []);
  assert.equal(surfaceOf(doc).stack.children.length, 0);
});

test('a page that tears the host out gets a new one on the next grab', (t) => {
  // Single-page apps replace whole subtrees; without this the second grab of a
  // session would draw into a detached node and show nothing.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const doc = createDocument();
  const surface = createFeedbackSurface(doc);
  surface.show(pendingFeedback());
  surfaceOf(doc).host.remove();

  surface.show(feedbackFor({ ok: true, profileName: 'Movies', transferName: 'One' }));

  assert.equal(surfaceOf(doc).hosts.length, 1);
  assert.deepEqual(readToasts(doc).map((toast) => toast.tone), ['success']);
});

test('every dynamic string reaches the page as text, never as markup', () => {
  // The toast repeats a release name and an error message that came off the
  // network onto a page running on <all_urls>.
  const source = readFileSync(TOAST_URL, 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  // No inline handlers either: a page's CSP would block them, and this surface
  // has to work on every site.
  assert.doesNotMatch(source, /\son[a-z]+\s*=/);
});

test('the content script can actually import this module', () => {
  // A content script may only import web-accessible resources; without the
  // entry the import throws on every page and the feedback silently never
  // appears.
  const manifest = JSON.parse(readFileSync(MANIFEST_URL, 'utf8'));
  const exposed = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.ok(exposed.includes('lib/toast.js'), `lib/toast.js is not web-accessible: ${exposed}`);
});
