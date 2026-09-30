import test from 'node:test';
import assert from 'node:assert/strict';
import { applyInitialCountry, snapshotNotice } from '../public/js/view-state.js';

test('first successful snapshot selects visitor country only when available', () => {
  const choices = [['DE', 'Germany'], ['PL', 'Poland']];
  const select = { value: '' };
  assert.equal(applyInitialCountry(select, 'PL', choices, false), true);
  assert.equal(select.value, 'PL');
  select.value = '';
  applyInitialCountry(select, 'DE', choices, true);
  assert.equal(select.value, '');
  select.value = 'DE';
  applyInitialCountry(select, 'PL', choices, true);
  assert.equal(select.value, 'DE');
  for (const code of [null, 'FR']) {
    const unavailable = { value: '' };
    applyInitialCountry(unavailable, code, choices, false);
    assert.equal(unavailable.value, '');
  }
});

test('degraded snapshot alone does not show a warning', () => {
  assert.equal(snapshotNotice({ degraded: true, stale: false }, true), '');
  assert.equal(snapshotNotice({ degraded: true, stale: true }, true), 'The snapshot is stale. Waiting for fresh server data.');
  assert.match(snapshotNotice({ degraded: true, discoveryDisabled: true }, false), /Discovery is not configured/);
});
