import test from 'node:test';
import assert from 'node:assert/strict';
import { readPreferences, writePreferences, availableChoice, restoredSort, preferencesKey } from '../public/js/preferences.js';
import { readHidden, writeHidden, hideServer, restoreServer, isHidden, hiddenEntries, hiddenKey } from '../public/js/hidden.js';
import { filterServers } from '../public/js/filters.js';
import { parseAddress } from '../src/utils/address.js';

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
};
const filters = { search: '', country: '', map: '', confidence: '', slots: false, hideEmpty: false, favorites: false };
const row = (id, duplicateEndpoints = []) => ({ id, duplicateEndpoints, name: 'Christmas Dust', map: 'de_xmas',
  players: 12, maxPlayers: 32, status: 'online', stale: false, classification: { confidence: 'high' } });

test('hidden storage rejects the same non-public IPv4 endpoints as the backend', () => {
  const store = storage();
  const rejected = ['0.1.2.3:27015', '10.1.1.1:27015', '127.0.0.1:27015', '169.254.1.1:27015',
    '172.16.0.1:27015', '172.31.255.255:27015', '192.168.1.1:27015', '100.64.0.1:27015',
    '100.127.255.255:27015', '192.0.0.1:27015', '192.0.2.1:27015', '192.88.99.1:27015',
    '198.18.0.1:27015', '198.19.0.1:27015', '198.51.100.1:27015', '203.0.113.1:27015',
    '224.0.0.1:27015', '240.0.0.1:27015', '255.255.255.255:27015', '8.8.8.8:0', '8.8.8.8:65536',
    '256.8.8.8:27015', '008.8.8.8:27015', 'localhost:27015'];
  for (const endpoint of rejected) {
    assert.throws(() => parseAddress(endpoint), endpoint);
    store.setItem(hiddenKey, JSON.stringify([endpoint]));
    assert.equal(readHidden(store).size, 0, endpoint);
    assert.equal(writeHidden(store, new Set([endpoint])), false, endpoint);
  }
  for (const endpoint of ['8.8.8.8:27015', '192.0.1.1:27015', '100.128.0.1:65535', '172.32.0.1:1']) {
    assert.doesNotThrow(() => parseAddress(endpoint));
    store.setItem(hiddenKey, JSON.stringify([endpoint]));
    assert.deepEqual([...readHidden(store)], [endpoint]);
  }
});

test('valid browser preferences restore with bounded fields and dynamic choices', () => {
  const store = storage();
  assert.equal(writePreferences(store, { search: 'xmas', country: 'PL', map: 'de_xmas', confidence: 'high',
    sort: 'players', slots: true, hideEmpty: true, favorites: true }), true);
  assert.deepEqual(readPreferences(store), { search: 'xmas', country: 'PL', map: 'de_xmas',
    confidence: 'high', sort: 'players', slots: true, hideEmpty: true, favorites: true });
  assert.equal(availableChoice('PL', [['DE', 'Germany'], ['PL', 'Poland']]), 'PL');
  assert.equal(availableChoice('de_xmas', [['de_xmas', 'de_xmas']]), 'de_xmas');
  assert.equal(availableChoice('PL', [['DE', 'Germany']]), '');
  assert.equal(availableChoice('de_xmas', [['de_dust2', 'de_dust2']]), '');
  assert.equal(restoredSort('proximity', null), 'recommended');
  assert.equal(restoredSort('proximity', { latitude: 1, longitude: 2 }), 'proximity');
});

test('corrupt, oversized, or invalid preferences safely fall back', () => {
  const store = storage();
  store.setItem(preferencesKey, '{broken');
  assert.equal(readPreferences(store).sort, 'recommended');
  store.setItem(preferencesKey, 'x'.repeat(4097));
  assert.equal(readPreferences(store).search, '');
  store.setItem(preferencesKey, JSON.stringify({ search: 'a'.repeat(500), country: 'bad',
    confidence: 'invalid', sort: 'invalid', slots: 'yes' }));
  const value = readPreferences(store);
  assert.equal(value.search.length, 200);
  assert.deepEqual([value.country, value.confidence, value.sort, value.slots], ['', '', 'recommended', false]);
  assert.equal(readPreferences({ getItem() { throw Error('blocked'); } }).sort, 'recommended');
  assert.equal(writePreferences({ setItem() { throw Error('quota'); } }, value), false);
});

test('hidden grouped endpoints disappear from visible results and totals, then restore', () => {
  const store = storage();
  const first = '8.8.8.8:27015'; const second = '1.1.1.1:27015';
  const group = row(first, [second]);
  const other = row('9.9.9.9:27015'); other.players = 4;
  const ids = readHidden(store);
  assert.equal(hideServer(group, ids), true);
  assert.deepEqual([...ids].sort(), [first, second].sort());
  assert.equal(writeHidden(store, ids), true);
  assert.deepEqual([...readHidden(store)].sort(), [first, second].sort());
  const moved = row(second, [first]);
  assert.equal(isHidden(moved, ids), true);
  const visible = filterServers([moved, other], filters, new Set(), ids);
  assert.deepEqual(visible.map(server => server.id), [other.id]);
  assert.deepEqual([visible.length, visible.reduce((sum, server) => sum + server.players, 0)], [1, 4]);
  assert.equal(hiddenEntries([moved, other], ids).length, 1);
  restoreServer(moved, ids);
  assert.equal(ids.size, 0);
  assert.deepEqual(filterServers([moved, other], filters, new Set(), ids).map(server => server.id), [second, other.id]);
});

test('missing hidden endpoints remain stored and can be listed by endpoint', () => {
  const store = storage(); const id = '8.8.4.4:27015';
  store.setItem(hiddenKey, JSON.stringify([id, 'not-an-endpoint']));
  const ids = readHidden(store);
  assert.deepEqual([...ids], [id]);
  assert.deepEqual(hiddenEntries([], ids), [{ id }]);
  assert.deepEqual(filterServers([row('9.9.9.9:27015')], filters, new Set(), ids).map(server => server.id), ['9.9.9.9:27015']);
  store.setItem(hiddenKey, '{broken');
  assert.equal(readHidden(store).size, 0);
  store.setItem(hiddenKey, 'x'.repeat(150001));
  assert.equal(readHidden(store).size, 0);
  const full = new Set(Array.from({ length: 5000 }, (_, index) => `8.8.8.8:${10000 + index}`));
  assert.equal(hideServer(row(id), full), false);
  assert.equal(full.size, 5000);
});
