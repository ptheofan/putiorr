import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { sleep } from '../src/download/manager.js';

test('sleep does not accumulate abort listeners on a long-lived signal', async () => {
  const controller = new AbortController();
  const { signal } = controller;

  for (let i = 0; i < 50; i += 1) {
    await sleep(0, signal);
  }

  // The controller signal outlives every individual sleep() and does not abort
  // during normal operation. Before this was fixed each idle tick left its
  // listener attached, so this count grew without bound and addEventListener's
  // list walk made the caller quadratic in uptime.
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('sleep resolves early when the signal aborts, and cleans up', async () => {
  const controller = new AbortController();
  const started = Date.now();

  const pending = sleep(10_000, controller.signal);
  controller.abort();
  await pending;

  assert.ok(Date.now() - started < 1_000, 'aborting should resolve sleep immediately');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('sleep on an already-aborted signal resolves at once without listening', async () => {
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();

  // 'abort' has already fired and will not fire again, so a listener added now
  // would never be called and the sleep would run its full duration. That is
  // what stop() would wait on.
  await sleep(10_000, controller.signal);

  assert.ok(Date.now() - started < 1_000, 'an aborted signal should not be waited on');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('sleep without a signal still resolves', async () => {
  await sleep(0);
});
