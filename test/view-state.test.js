import test from 'node:test';
import assert from 'node:assert/strict';
import { lastUpdateLabel, renderWhenUnfocused, setLocationSort, snapshotNotice } from '../public/js/view-state.js';

test('polling preserves focus in server cards and the expanded hidden section', () => {
  const cardButton = {}; const restoreButton = {}; const hiddenSummary = {}; const outside = {};
  const regions = [{ contains: node => node === cardButton },
    { contains: node => node === restoreButton || node === hiddenSummary }];
  let rebuilds = 0;
  const render = () => { rebuilds++; };
  for (const active of [cardButton, restoreButton, hiddenSummary]) renderWhenUnfocused(active, regions, render);
  assert.equal(rebuilds, 0);
  renderWhenUnfocused(outside, regions, render);
  assert.equal(rebuilds, 1);
});

test('successful location uses proximity sort and clearing restores recommended sort', () => {
  const select = { value: 'players' };
  setLocationSort(select, true);
  assert.equal(select.value, 'proximity');
  setLocationSort(select, false);
  assert.equal(select.value, 'recommended');
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
