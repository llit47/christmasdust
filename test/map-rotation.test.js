import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, loadDetection } from '../src/config/index.js';
import { classify } from '../src/domain/classify.js';
import { steamDiscovery } from '../src/services/discovery.js';
import { Monitor } from '../src/services/monitor.js';
import { parseAddress } from '../src/utils/address.js';

const rules = await loadDetection(new URL('../config/detection.json', import.meta.url));
const name = 'WINTER VIBE • ЗИМНИЙ ПАБЛИК • LEGION-CS';
const newStrong = ['cs_xmas_italy', 'lethal_urbandust2_xmas'];
const newProbable = ['de_dust2_winter16', 'css_miragewinter_go', 'cs_mansion_snow',
  'css_train_winter', 'de_nuke2x2_snow'];
const rotation = [
  ['de_dust2_2x2_xmas', 'high'],
  ['csg_office', 'probable'],
  ['cs_assault_christmas', 'high'],
  ['de_dust_winter16', 'probable'],
  ['awp_india_christmast', 'high'],
  ['de_dust2_xmas', 'high'],
  ['de_inferno_winter', 'probable'],
  ['de_westwood_bigxmas', 'high'],
  ...newProbable.map(map => [map, 'probable']),
  ...newStrong.map(map => [map, 'high'])
];

test('LEGION-CS seasonal identity qualifies on all 15 observed maps without targeted discovery', () => {
  for (const [map, confidence] of rotation) {
    const classification = classify({ name, map }, rules);
    assert.equal(classification.confidence, confidence, map);
    assert.ok(classification.signals.some(signal => signal.kind ===
      (confidence === 'high' ? 'known-strong-map' : 'known-probable-map')), map);
    assert.ok(classification.signals.some(signal => signal.field === 'name' && signal.kind === 'seasonal'), map);
    assert.equal(classification.signals.some(signal => signal.field === 'discovery'), false, map);
  }
});

test('new probable rotation maps require independent seasonal identity (PR #19)', () => {
  for (const map of newProbable) {
    assert.ok(rules.maps.probable.has(map), map);
    for (const discoverySources of [[], [`map:${map}`]]) {
      const classification = classify({ name: 'Public CS 1.6 Server', map, discoverySources }, rules);
      assert.equal(classification.confidence, 'none', map);
      assert.ok(classification.signals.some(signal => signal.kind === 'known-probable-map'), map);
    }
  }
});

test('new strong Xmas rotation maps qualify generic servers from catalog evidence alone', () => {
  for (const map of newStrong) {
    assert.ok(rules.maps.strong.has(map), map);
    const classification = classify({ name: 'Public CS 1.6 Server', map }, rules);
    assert.equal(classification.confidence, 'high', map);
    assert.equal(classification.score, 12, map);
    assert.deepEqual(classification.signals.map(signal => signal.kind), ['known-strong-map'], map);
  }
});

test('regional LEGION-CS stays classified and publicly visible through the complete live map rotation', async () => {
  const candidate = { ...parseAddress('8.8.8.8:27015'), name, map: rotation[0][0], discoverySources: ['regional'] };
  let currentMap = candidate.map;
  const monitor = new Monitor({ config: readConfig({}), rules,
    discover: async () => ({ servers: [candidate], successfulRequests: 1, partial: false, disabled: false }),
    query: async () => ({ name, map: currentMap, numplayers: 12, maxplayers: 32 }),
    store: { load: async () => null, save: async () => {} }, now: () => 1000000, log: { warn() {} } });
  await monitor.init();
  await monitor.run('discovery');
  for (const [map, confidence] of rotation) {
    currentMap = map;
    await monitor.run('live');
    const row = monitor.servers.get(candidate.id);
    assert.ok(row, map);
    assert.equal(row.classification.confidence, confidence, map);
    assert.equal(row.themeMisses, 0, map);
    assert.deepEqual(row.discoverySources, ['regional'], map);
    assert.equal(row.classification.signals.some(signal => signal.kind === 'live-verified-winter-name'), false, map);
    const visible = monitor.snapshot().servers;
    assert.equal(visible.length, 1, map);
    assert.equal(visible[0].map, map);
    assert.equal(visible[0].status, 'online', map);
    assert.equal(visible[0].stale, false, map);
  }
});

test('new rotation maps enter exact-map discovery within the existing request and concurrency budgets', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32) });
  const catalog = [...rules.maps.strong, ...rules.maps.probable];
  const seen = new Set();
  let filters = [], active = 0, peak = 0;
  const discover = steamDiscovery(config, rules, async url => {
    assert.equal(url.searchParams.get('limit'), '5000');
    filters.push(url.searchParams.get('filter'));
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return new Response(JSON.stringify({ response: { servers: [] } }));
  });
  for (let pass = 0; pass < Math.ceil(catalog.length / 20); pass++) {
    filters = [];
    const result = await discover();
    assert.equal(result.partial, false);
    assert.equal(result.successfulRequests, 33);
    assert.equal(filters.length, 33);
    assert.equal(filters.filter(filter => filter.includes('\\region\\')).length, 8);
    assert.equal(filters.filter(filter => filter.includes('\\name_match\\')).length, 5);
    const maps = filters.filter(filter => filter.includes('\\map\\')).map(filter => filter.split('\\map\\')[1]);
    assert.deepEqual(maps, Array.from({ length: 20 }, (_, index) => catalog[(pass * 20 + index) % catalog.length]));
    for (const map of maps) seen.add(map);
  }
  assert.equal(peak, 4);
  for (const map of [...newStrong, ...newProbable]) assert.ok(seen.has(map), map);
});
