import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDetection, readConfig } from '../src/config/index.js';
import { classify } from '../src/domain/classify.js';
import { filterSameNameMirrors } from '../src/domain/name-mirrors.js';
import { parseAddress } from '../src/utils/address.js';
import { Monitor } from '../src/services/monitor.js';
import { SnapshotStore } from '../src/storage/snapshot.js';

const rules = await loadDetection(new URL('../config/detection.json', import.meta.url));
const name = 'Winter Community XMAS | [Events!]';
const endpoints = ['8.8.8.8:27015', '1.1.1.1:27015', '9.9.9.9:27015', '4.2.2.2:27015',
  '208.67.222.222:27015', '8.8.4.4:27015', '208.67.220.220:27015'];
const rows = (count = 5) => endpoints.slice(0, count).map(id => ({ ...parseAddress(id), name, map: 'de_dust2',
  status: 'online', stale: false, misses: 0, backendQueryMs: 40, players: 12,
  classification: classify({ name, map: 'de_dust2' }, rules) }));
const select = values => filterSameNameMirrors(values, rules);
const total = values => values.reduce((sum, row) => sum + row.players, 0);

test('four distinct IPs remain visible; five retain exactly one stable endpoint without summing players', () => {
  const four = rows(4); assert.deepEqual(select(four), four);
  const five = rows(); const before = structuredClone(five);
  const visible = select(five);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, [...endpoints.slice(0, 5)].sort()[0]);
  assert.equal(total(visible), 12); assert.equal(total(five), 60);
  assert.deepEqual(select([...five].reverse()), visible);
  assert.deepEqual(five, before);
});

test('multiple ports on one IP cannot meet the five-IP threshold', () => {
  const ports = Array.from({ length: 12 }, (_, i) => ({ ...rows(1)[0], ...parseAddress(`8.8.8.8:${27015 + i}`) }));
  const values = [...ports, ...rows(4).slice(1)]; // Fifteen endpoints, only four distinct IPs.
  assert.deepEqual(select(values), values);
});

test('case, spacing and punctuation variations form the same repeated-name cluster', () => {
  const variants = ['WINTER COMMUNITY XMAS | [EVENTS!]', ' winter   community xmas events ',
    'Winter-Community-XMAS: (Events)', 'Winter Community XMAS / Events...', 'Winter Community XMAS — {Events}'];
  const values = rows().map((row, i) => ({ ...row, name: variants[i] }));
  assert.equal(select(values).length, 1);
  assert.equal(select(values.reverse()).length, 1);
  assert.deepEqual(select(rows().map(row => ({ ...row, name: '---[]' }))).length, 5);
});

test('known strong maps, explicit Christmas/Xmas maps and curated entries are exempt', () => {
  const ordinary = rows();
  const exempt = ['de_dust2_xmas', 'custom_christmas_arena', 'custom_x-mas_arena'].map((map, i) => ({
    ...rows(1)[0], ...parseAddress(`8.8.8.${i + 10}:27015`), map
  }));
  exempt.push({ ...rows(1)[0], ...parseAddress('8.8.8.20:27015'), curated: true,
    classification: classify({}, rules, true) });
  const selected = select([...ordinary, ...exempt]);
  assert.equal(selected.length, 1 + exempt.length);
  assert.ok(exempt.every(row => selected.includes(row)));
  // Exempt IPs cannot supply the fifth eligible address.
  assert.deepEqual(select([...ordinary.slice(0, 4), ...exempt]), [...ordinary.slice(0, 4), ...exempt]);
  assert.equal(select(rows().map(row => ({ ...row, map: 'de_dust2_xmas' }))).length, 5);
});

test('fresh/responding representatives prefer fewer misses, measured latency, then endpoint ID', () => {
  const values = rows();
  values.forEach((row, i) => { row.misses = 1; row.backendQueryMs = i + 1; });
  values[0].misses = 0; values[0].backendQueryMs = null;
  assert.equal(select(values)[0].id, values[0].id); // Misses outrank latency.
  values[1].misses = 0; values[1].backendQueryMs = 30;
  assert.equal(select(values)[0].id, values[1].id); // Available latency outranks missing latency.
  values[2].misses = 0; values[2].backendQueryMs = 0;
  assert.equal(select(values)[0].id, values[2].id);
  values.forEach(row => { row.misses = 0; row.backendQueryMs = null; });
  assert.equal(select(values)[0].id, [...values.map(row => row.id)].sort()[0]);
});

test('stale, offline, uncertain and unverified rows never contribute to cluster size', () => {
  for (const inactive of [{ stale: true }, { status: 'offline' }, { status: 'uncertain' }, { status: 'unknown' }]) {
    const values = rows(); Object.assign(values[4], inactive, { backendQueryMs: 0 });
    assert.deepEqual(select(values), values);
  }
  const values = rows(7); Object.assign(values[5], { stale: true }); Object.assign(values[6], { status: 'offline' });
  const selected = select(values);
  assert.equal(selected.length, 3); assert.ok(selected.includes(values[5]) && selected.includes(values[6]));
});

test('name or map divergence restores visibility when eligible IPs fall below threshold', () => {
  const values = rows(); assert.equal(select(values).length, 1);
  values[4].name = 'Other Community XMAS'; assert.equal(select(values).length, 5);
  values[4].name = name; assert.equal(select(values).length, 1);
  values[4].map = 'custom_xmas_arena'; assert.equal(select(values).length, 5);
  values[4].map = 'de_mirage'; assert.equal(select(values).length, 1);
});

async function monitorFixture(store, ids = endpoints.slice(0, 5)) {
  const queried = [];
  const maps = ['de_dust2', 'de_mirage', 'de_airstrip'];
  const monitor = new Monitor({ config: readConfig({}), rules, now: () => 1000000, log: { warn() {} }, store,
    discover: async () => ({ servers: ids.map(id => ({ ...parseAddress(id), name, map: 'de_dust2' })),
      successfulRequests: 1, partial: false }),
    query: async row => {
      queried.push(row.id);
      const i = ids.indexOf(row.id);
      return { name, map: maps[i % maps.length], numplayers: i + 5, maxplayers: 32, ping: 20 + i };
    } });
  await monitor.init(); return { monitor, queried };
}

test('public snapshots suppress copies but keep every endpoint queried, persisted and recoverable after restore', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'christmasdust-name-mirrors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SnapshotStore(join(directory, 'snapshot.json'));
  const { monitor, queried } = await monitorFixture(store);
  await monitor.run('discovery');
  assert.equal(monitor.snapshot().servers.length, 5); // Unverified names do not form a cluster.
  await monitor.run('live');
  let visible = monitor.snapshot().servers;
  assert.equal(visible.length, 1); assert.equal(visible[0].id, endpoints[0]); assert.equal(total(visible), 5);
  assert.equal(monitor.servers.size, 5);
  assert.equal((await store.load()).servers.length, 5);
  await monitor.run('live'); assert.equal(queried.length, 10);
  assert.equal(monitor.snapshot().servers.length, 1);
  const restored = (await monitorFixture(store)).monitor;
  assert.equal(restored.servers.size, 5); assert.equal(restored.snapshot().servers.length, 1);
  restored.query = async row => ({ name: row.id === endpoints[4] ? 'Other XMAS Community' : name,
    map: row.map, numplayers: row.players, maxplayers: 32 });
  await restored.run('live'); visible = restored.snapshot().servers;
  assert.equal(visible.length, 5); assert.equal(total(visible), 35);
  assert.equal((await store.load()).servers.length, 5);
  restored.now = () => 1000000 + restored.config.staleAfter + 1;
  assert.equal(restored.snapshot().servers.length, 5);
});

test('backend snapshot includes strong-map and operator-included members beside the one eligible representative', async () => {
  const ids = endpoints.slice(0, 7);
  const { monitor } = await monitorFixture({ load: async () => null, save: async () => {} }, ids);
  monitor.rules = { ...rules, include: [parseAddress(ids[5])] };
  await monitor.run('discovery');
  const query = monitor.query;
  monitor.query = async row => ({ ...await query(row), ...(row.id === ids[6] ? { map: 'custom_christmas_arena' } : {}) });
  await monitor.run('live');
  const visible = monitor.snapshot().servers;
  assert.equal(visible.length, 3);
  assert.deepEqual(visible.map(row => row.id).sort(), [ids[0], ids[5], ids[6]].sort());
  assert.equal(monitor.servers.size, 7);
  assert.equal(visible.find(row => row.id === ids[5]).classification.confidence, 'curated');
});
