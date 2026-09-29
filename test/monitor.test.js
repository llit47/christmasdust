import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, loadDetection } from '../src/config/index.js';
import { Monitor } from '../src/services/monitor.js';
import { SnapshotStore } from '../src/storage/snapshot.js';
import { parseAddress } from '../src/utils/address.js';
import { steamDiscovery } from '../src/services/discovery.js';
import { gameQuery } from '../src/services/query.js';
const rules = await loadDetection(new URL('../config/detection.json', import.meta.url));
const a = { ...parseAddress('8.8.8.8:27015'), name: 'Christmas A' };
const b = { ...parseAddress('1.1.1.1:27015'), name: 'Christmas B' };
function fixture(overrides = {}) {
  let time = 1000000;
  const monitor = new Monitor({ config: readConfig({}), rules, discover: async () => ({ servers: [a, b], successfulRequests: 1, partial: false }),
    query: async () => ({ name: 'Xmas online', map: 'de_xmas', numplayers: 12, maxplayers: 32, ping: 45 }),
    store: { load: async () => null, save: async () => {} }, now: () => time, log: { warn() {} }, ...overrides });
  return { monitor, advance: ms => { time += ms; } };
}
test('discovery and live are independent; scoped refresh retains unrelated entries', async () => {
  let calls = 0;
  const { monitor } = fixture({ query: async () => { calls++; return { name: 'xmas', numplayers: 2 }; } });
  await monitor.init(); await monitor.run('discovery'); assert.equal(calls, 0);
  await monitor.run('live'); assert.equal(calls, 2);
  const oldB = monitor.servers.get(b.id);
  await monitor.run('live', [a.id]); assert.equal(calls, 3); assert.strictEqual(monitor.servers.get(b.id), oldB);
  monitor.discover = async () => ({ servers: [a], successfulRequests: 1, partial: true });
  await monitor.run('discovery'); assert.equal(monitor.servers.size, 2); assert.equal(monitor.snapshot().meta.discoveryPartial, true);
});
test('failed queries preserve last good data, timestamps and progressively degrade', async () => {
  const { monitor, advance } = fixture(); await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  const last = monitor.snapshot().meta.lastLiveAt;
  monitor.query = async () => { throw Error('timeout'); };
  for (let i = 0; i < 3; i++) { advance(45000); await monitor.run('live'); }
  assert.equal(monitor.servers.get(a.id).players, 12); assert.equal(monitor.servers.get(a.id).misses, 3);
  assert.equal(monitor.servers.get(a.id).status, 'offline'); assert.equal(monitor.snapshot().meta.lastLiveAt, last);
  advance(180000); assert.equal(monitor.snapshot().meta.stale, true); assert.equal(monitor.snapshot().servers[0].stale, true);
  monitor.discover = async () => { throw Error('upstream'); }; await monitor.run('discovery'); assert.equal(monitor.servers.size, 2);
});
test('one live failure does not abort successful queries', async () => {
  const { monitor } = fixture({ query: async row => { if (row.id === b.id) throw Error(); return { name: 'snow', numplayers: 3 }; } });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  assert.equal(monitor.servers.get(a.id).players, 3); assert.equal(monitor.servers.get(b.id).misses, 1); assert.equal(monitor.snapshot().meta.livePartial, true);
});
test('refresh single flight, exclusion precedence and bounded retention', async () => {
  let release;
  const { monitor, advance } = fixture({ rules: { ...rules, include: [a], exclude: new Set([b.id]) }, discover: () => new Promise(resolve => { release = resolve; }) });
  await monitor.init(); const running = monitor.run('discovery');
  assert.equal(await monitor.run('live'), false); release({ servers: [a, b], successfulRequests: 1, partial: false }); await running;
  assert.equal(monitor.servers.size, 1); assert.equal(monitor.servers.get(a.id).classification.confidence, 'curated');
  advance(800000000); monitor.prune(); assert.equal(monitor.servers.size, 1);
  monitor.rules = { ...rules, include: [] }; monitor.prune(); assert.equal(monitor.servers.size, 0);
});
test('disk persistence roundtrip, atomic replacement, restore, corrupted schema', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'christmasdust-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'snapshot.json'); const store = new SnapshotStore(path);
  assert.equal(await store.load(), null);
  const { monitor } = fixture({ store }); await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  const saved = JSON.parse(await readFile(path, 'utf8')); assert.equal(saved.servers.length, 2);
  assert.deepEqual(await readdir(directory), ['snapshot.json']);
  const restored = fixture({ store }).monitor; await restored.init(); assert.equal(restored.servers.get(a.id).players, 12);
  await writeFile(path, '{"schema":99}'); await assert.rejects(store.load());
  const recovered = fixture({ store, rules: { ...rules, include: [a] } }).monitor; await recovered.init(); assert.equal(recovered.servers.size, 1);
});
test('persistence failure preserves in-memory snapshot and exposes degraded health', async () => {
  const { monitor } = fixture({ store: { load: async () => null, save: async () => { throw Error('disk full'); } } });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  assert.equal(monitor.snapshot().servers.length, 2); assert.equal(monitor.snapshot().meta.persistenceError, true);
});
test('regional upstream failure preserves successful discovery and deduplicates', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32) }); const urls = [];
  const discover = steamDiscovery(config, async url => {
    urls.push(url); const region = url.searchParams.get('filter').slice(-1);
    if (region === '1') throw Error('Steam unavailable');
    return new Response(JSON.stringify({ response: { servers: [{ addr: a.id, appid: 10, name: 'Christmas', gamedir: 'cstrike' }, { addr: '127.0.0.1:80', appid: 10 }, { addr: b.id, appid: 730 }] } }));
  });
  const result = await discover(); assert.equal(result.servers.length, 1); assert.equal(result.partial, true); assert.equal(result.successfulRequests, 7);
  assert.equal(urls.length, 8); assert.ok(urls.every(url => url.searchParams.get('filter').includes('\\appid\\10')));
});
test('disabled and truncated discovery are explicit', async () => {
  const disabled = await steamDiscovery(readConfig({}), () => { throw Error('must not request'); })(); assert.equal(disabled.disabled, true);
  const result = await steamDiscovery(readConfig({ STEAM_API_KEY: 'a'.repeat(32), DISCOVERY_LIMIT: '1' }), async () => new Response(JSON.stringify({ response: { servers: [{ addr: a.id, appid: 10 }] } })))();
  assert.equal(result.partial, true);
});
test('GameDig uses correct game and bounded timeout without player collection', async () => {
  let options; await gameQuery(readConfig({}), async input => { options = input; return {}; })(a);
  assert.equal(options.type, 'counterstrike16'); assert.equal(options.requestPlayers, false); assert.equal(options.maxAttempts, 1); assert.equal(options.givenPortOnly, true);
});
test('scheduler starts discovery then live and stops future work', async () => {
  const calls = [];
  const { monitor } = fixture({ discover: async () => { calls.push('discovery'); return { servers: [a], successfulRequests: 1 }; }, query: async () => { calls.push('query'); return { name: 'xmas' }; } });
  await monitor.init(); monitor.start(); await monitor.initial; monitor.stop();
  assert.deepEqual(calls, ['discovery', 'query']); assert.equal(await monitor.run('live'), false);
});
test('restoring after a reduced capacity preserves includes and stays bounded', async () => {
  const saved = { schema: 1, state: {}, servers: [a, b].map(row => ({ ...row, classification: { confidence: 'high', reasons: [] }, discoveredAt: 1000000 })) };
  const { monitor } = fixture({ config: readConfig({ MAX_SERVERS: '1' }), rules: { ...rules, include: [b] }, store: { load: async () => saved, save: async () => {} } });
  await monitor.init(); assert.equal(monitor.servers.size, 1); assert.equal(monitor.servers.has(b.id), true);
});
