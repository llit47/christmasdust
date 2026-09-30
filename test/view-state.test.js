import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInitialCountry, lastUpdateLabel, snapshotNotice } from '../public/js/view-state.js';

test('visitor country remains pending until it appears in a later snapshot', () => {
  const choices = [['DE', 'Germany'], ['PL', 'Poland']];
  const select = { value: '' };
  let done = applyInitialCountry(select, 'PL', choices.slice(0, 1), false);
  assert.equal(done, false);
  assert.equal(select.value, '');
  done = applyInitialCountry(select, 'PL', choices, done);
  assert.equal(done, true);
  assert.equal(select.value, 'PL');
  select.value = '';
  applyInitialCountry(select, 'DE', choices, done);
  assert.equal(select.value, '');
  for (const code of [null, 'FR']) {
    const unavailable = { value: '' };
    assert.equal(applyInitialCountry(unavailable, code, choices, false), false);
    assert.equal(unavailable.value, '');
  }
});

test('manual country selection before visitor country appears is preserved', () => {
  const select = { value: '' };
  assert.equal(applyInitialCountry(select, 'PL', [['DE', 'Germany']], false), false);
  select.value = 'DE';
  const done = true; // Country control interaction locks the automatic default.
  assert.equal(applyInitialCountry(select, 'PL', [['DE', 'Germany'], ['PL', 'Poland']], done), true);
  assert.equal(select.value, 'DE');
});

test('manually choosing All countries also prevents a later automatic default', () => {
  const select = { value: '' };
  assert.equal(applyInitialCountry(select, 'PL', [['DE', 'Germany']], false), false);
  const done = true; // Pointer or keyboard interaction can reselect the unchanged empty value.
  applyInitialCountry(select, 'PL', [['DE', 'Germany'], ['PL', 'Poland']], done);
  assert.equal(select.value, '');
});

test('last update label uses local hours and minutes with an unavailable fallback', () => {
  const stamp = Date.UTC(2026, 8, 30, 20, 7, 43);
  const expected = new Date(stamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  assert.equal(lastUpdateLabel(stamp), `Updated ${expected} · refreshes every 30s`);
  assert.equal(lastUpdateLabel(null), 'Updated — · refreshes every 30s');
  assert.equal(lastUpdateLabel(undefined), 'Updated — · refreshes every 30s');
});

test('degraded snapshot alone does not show a warning', () => {
  assert.equal(snapshotNotice({ degraded: true, stale: false }, true), '');
  assert.equal(snapshotNotice({ degraded: true, stale: true }, true), 'The snapshot is stale. Waiting for fresh server data.');
  assert.match(snapshotNotice({ degraded: true, discoveryDisabled: true }, false), /Discovery is not configured/);
});
