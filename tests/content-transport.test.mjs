import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendContentAction } from '../extension/src/background/content-transport.mjs';

function fixture(dispatch) {
  const listeners = new Set();
  let calls = 0;
  const browser = {
    runtime: {},
    tabs: {
      onUpdated: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      sendMessage(id, message, callback) { calls++; dispatch({ browser, callback, update: (status, tab = id) => { for (const fn of listeners) fn(tab, { status }); } }); },
    },
  };
  return { browser, listeners, calls: () => calls };
}
const options = { graceMs: 5, timeoutMs: 30 };
const closed = 'A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received';

test('reload channel loss succeeds only after observed complete and readiness, without replay', async () => {
  let ready = 0;
  const f = fixture(({ browser, callback, update }) => {
    update('loading');
    browser.runtime.lastError = { message: closed };
    callback();
    delete browser.runtime.lastError;
    setTimeout(() => update('complete'), 10);
  });
  const result = await sendContentAction(f.browser, 1, 'element_click', {}, async () => { ready++; }, options);
  assert.equal(result.navigation, true);
  assert.equal(ready, 1);
  assert.equal(f.calls(), 1);
  assert.equal(f.listeners.size, 0);
});

test('zero-wait click waits for navigation that starts after its response', async () => {
  let loaded = false;
  const f = fixture(({ callback, update }) => {
    callback({ success: true, data: { success: true } });
    setTimeout(() => update('loading'), 0);
    setTimeout(() => { loaded = true; update('complete'); }, 10);
  });
  await sendContentAction(f.browser, 1, 'element_click', { wait_after: 0 }, async () => assert.equal(loaded, true), options);
  assert.equal(loaded, true);
});

test('channel loss without navigation remains an error', async () => {
  const f = fixture(({ browser, callback, update }) => {
    update('loading', 99); // A different tab is not evidence.
    browser.runtime.lastError = { message: closed };
    callback();
  });
  await assert.rejects(sendContentAction(f.browser, 1, 'element_click', {}, async () => {}, options), /channel closed/);
  assert.equal(f.calls(), 1);
  assert.equal(f.listeners.size, 0);
});

test('unrelated errors and explicit page errors cannot be hidden by navigation', async () => {
  for (const explicit of [true, false]) {
    const f = fixture(({ browser, callback, update }) => {
      update('loading'); update('complete');
      if (!explicit) browser.runtime.lastError = { message: 'Permission denied' };
      callback(explicit ? { success: false, error: 'Click failed' } : undefined);
    });
    await assert.rejects(sendContentAction(f.browser, 1, 'element_click', {}, async () => {}, options), explicit ? /Click failed/ : /Permission denied/);
    assert.equal(f.listeners.size, 0);
  }
});

test('unfinished navigation fails instead of reporting success', async () => {
  const f = fixture(({ callback, update }) => { update('loading'); callback({ success: true, data: {} }); });
  await assert.rejects(sendContentAction(f.browser, 1, 'element_click', {}, async () => {}, options), /navigation did not finish/);
  assert.equal(f.listeners.size, 0);
});
