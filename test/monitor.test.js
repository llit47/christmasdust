import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, loadDetection } from '../src/config/index.js';
import { Monitor } from '../src/services/monitor.js';
import { PlayerStatsStore, SAMPLE_MS } from '../src/storage/player-stats.js';
import { SnapshotStore } from '../src/storage/snapshot.js';
import { parseAddress } from '../src/utils/address.js';
import { steamDiscovery, targetedTerms } from '../src/services/discovery.js';
import { gameQuery } from '../src/services/query.js';
const rules = await loadDetection(new URL('../config/detection.json', import.meta.url));
const a = { ...parseAddress('8.8.8.8:27015'), name: 'Christmas A' };
const b = { ...parseAddress('1.1.1.1:27015'), name: 'Christmas B' };
const tagsOnly = { ...parseAddress('9.9.9.9:27015'), name: 'Public Server', map: 'de_dust2', tags: 'xmas,secure' };
function fixture(overrides = {}) {
  let time = 1000000;
  const monitor = new Monitor({ config: readConfig({}), rules, discover: async () => ({ servers: [a, b], successfulRequests: 1, partial: false }),
    query: async () => ({ name: 'Xmas online', map: 'de_xmas', numplayers: 12, maxplayers: 32, ping: 45 }),
    store: { load: async () => null, save: async () => {} }, now: () => time, log: { warn() {} }, ...overrides });
  return { monitor, advance: ms => { time += ms; } };
}
test('GeoIP enrichment exposes server country and coordinates after discovery and snapshot restore', async () => {
  const located = { countryCode: 'DE', country: 'Germany', latitude: 52.52, longitude: 13.405, accuracyRadiusKm: 20 };
  const geoip = ip => ip === a.ip ? located : {};
  const store = { load: async () => null, save: async () => {} };
  const { monitor } = fixture({ geoip, store });
  await monitor.init(); await monitor.run('discovery');
  assert.deepEqual(Object.fromEntries(['countryCode', 'country', 'latitude', 'longitude'].map(key => [key, monitor.snapshot().servers.find(row => row.id === a.id)[key]])),
    { countryCode: 'DE', country: 'Germany', latitude: 52.52, longitude: 13.405 });
  const prior = { ...monitor.servers.get(a.id), countryCode: null, country: null, latitude: null, longitude: null };
  const restored = fixture({ geoip, store: { load: async () => ({ state: monitor.state, servers: [prior] }), save: async () => {} } }).monitor;
  await restored.init();
  assert.equal(restored.snapshot().servers[0].countryCode, 'DE');
  assert.equal(restored.snapshot().servers[0].latitude, 52.52);
});
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
test('incomplete successful GameDig responses preserve last good metadata', async () => {
  let live = { name: 'Christmas Server', map: 'de_xmas', numplayers: 20, maxplayers: 32,
    password: true, ping: 42, raw: { numbots: 3 } };
  const { monitor } = fixture({ query: async () => live });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  live = { name: 'Christmas Server', numplayers: 12 };
  await monitor.run('live');
  const row = monitor.servers.get(a.id);
  assert.deepEqual({ name: row.name, map: row.map, players: row.players, maxPlayers: row.maxPlayers,
    password: row.password, backendQueryMs: row.backendQueryMs, bots: row.bots },
  { name: 'Christmas Server', map: 'de_xmas', players: 12, maxPlayers: 32,
    password: true, backendQueryMs: 42, bots: 3 });
  assert.equal(row.classification.confidence, 'high');
});
test('explicit GameDig zero counts and false password replace prior values', async () => {
  let live = { name: 'Christmas Server', map: 'de_xmas', numplayers: 20, maxplayers: 32,
    password: true, ping: 42, raw: { numbots: 3 } };
  const { monitor } = fixture({ query: async () => live });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  live = { name: '', map: '', numplayers: 0, maxplayers: 0, password: false, ping: 0, raw: { numbots: 0 } };
  await monitor.run('live');
  const row = monitor.servers.get(a.id);
  assert.deepEqual({ name: row.name, map: row.map, players: row.players, maxPlayers: row.maxPlayers,
    password: row.password, backendQueryMs: row.backendQueryMs, bots: row.bots },
  { name: 'Christmas Server', map: 'de_xmas', players: 0, maxPlayers: 0,
    password: false, backendQueryMs: 0, bots: 0 });
  assert.equal(row.themeMisses, 0);
});
test('public capacity sanity allows 32 and unknown slots while hiding oversized servers from totals', async () => {
  const capacities = [32, 33, 64, 200, 255, 0, undefined];
  const servers = capacities.map((maxPlayers, index) => ({
    ...parseAddress(`8.8.8.8:${27015 + index}`), name: `Christmas ${index}`, map: 'de_xmas', players: 5,
    ...(maxPlayers === undefined ? {} : { maxPlayers })
  }));
  const { monitor } = fixture({
    rules: { ...rules, include: [servers[1]] },
    discover: async () => ({ servers, successfulRequests: 1, partial: false }),
    query: async row => servers.find(server => server.id === row.id)
  });
  await monitor.init(); await monitor.run('discovery');
  const assertPublic = () => {
    const rows = monitor.snapshot().servers;
    assert.deepEqual(rows.map(row => row.id).sort(), [servers[0], servers[5], servers[6]].map(row => row.id).sort());
    assert.equal(rows.length, 3);
    assert.equal(rows.reduce((sum, row) => sum + row.players, 0), 15);
    assert.equal(monitor.servers.size, capacities.length);
  };
  assertPublic();
  await monitor.run('live'); assertPublic();
});
test('oversized capacity stays hidden across incomplete or failed queries and recovers at 32 slots', async () => {
  let live = { name: 'Christmas Server', map: 'de_xmas', numplayers: 12, maxplayers: 64 };
  let saved;
  const { monitor } = fixture({
    discover: async () => ({ servers: [a], successfulRequests: 1, partial: false }),
    query: async () => live,
    store: { load: async () => null, save: async snapshot => { saved = snapshot; } }
  });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  assert.equal(monitor.snapshot().servers.length, 0);
  assert.equal(saved.servers[0].maxPlayers, 64);
  live = { name: 'Christmas Server', map: 'de_xmas' };
  await monitor.run('live');
  assert.equal(monitor.servers.get(a.id).maxPlayers, 64);
  assert.equal(monitor.snapshot().servers.length, 0);
  const query = monitor.query;
  monitor.query = async () => { throw Error('UDP timeout'); };
  await monitor.run('live');
  assert.equal(monitor.snapshot().servers.length, 0);
  monitor.query = query; live = { ...live, numplayers: 12, maxplayers: 32 };
  await monitor.run('live');
  const rows = monitor.snapshot().servers;
  assert.equal(rows.length, 1); assert.equal(rows[0].id, a.id);
  assert.equal(rows[0].maxPlayers, 32); assert.equal(rows[0].players, 12);
});
test('one live failure does not abort successful queries', async () => {
  const { monitor } = fixture({ query: async row => { if (row.id === b.id) throw Error(); return { name: 'snow', numplayers: 3 }; } });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  assert.equal(monitor.servers.get(a.id).players, 3); assert.equal(monitor.servers.get(b.id).misses, 1); assert.equal(monitor.snapshot().meta.livePartial, true);
});
test('two complete non-matching observations retire automatic candidates and free query capacity', async () => {
  const normal = { ...a, name: 'Normal Public Server', map: 'de_dust2' };
  let discovery = [a, b]; let queries = [];
  const { monitor, advance } = fixture({
    discover: async () => ({ servers: discovery, successfulRequests: 1, partial: false }),
    query: async row => { queries.push(row.id); return { name: 'Christmas server', map: 'de_xmas', numplayers: 12, maxplayers: 32 }; }
  });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  assert.equal(monitor.servers.get(a.id).classification.confidence, 'high');
  const lastMatchingDiscovery = monitor.servers.get(a.id).discoveredAt;
  discovery = [normal, b]; advance(1000); await monitor.run('discovery');
  assert.equal(monitor.servers.get(a.id).themeMisses, 1);
  assert.equal(monitor.servers.get(a.id).discoveredAt, lastMatchingDiscovery);
  assert.equal(monitor.snapshot().servers.some(row => row.id === a.id), false);
  // A failed GameDig query supplies no theme evidence.
  monitor.query = async row => { queries.push(row.id); if (row.id === a.id) throw Error('UDP timeout'); return { name: 'Christmas B', map: 'de_xmas' }; };
  await monitor.run('live'); assert.equal(monitor.servers.get(a.id).themeMisses, 1);
  advance(1000); await monitor.run('discovery');
  assert.equal(monitor.servers.has(a.id), false);
  await monitor.run('discovery'); assert.equal(monitor.servers.has(a.id), false);
  queries = []; await monitor.run('live'); assert.deepEqual(queries, [b.id]);
  discovery = [a, b]; await monitor.run('discovery');
  assert.equal(monitor.servers.get(a.id).classification.confidence, 'high');
});
test('incomplete metadata does not retire a candidate, but unseen theme evidence ages out', async () => {
  const { monitor, advance } = fixture();
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  monitor.add({ ...a, name: 'Normal Public Server', map: '' });
  assert.equal(monitor.servers.get(a.id).themeMisses, 0);
  assert.equal(monitor.servers.get(a.id).classification.confidence, 'high');
  monitor.add({ ...a, name: 'Normal Public Server', map: 'de_dust2' });
  assert.equal(monitor.servers.get(a.id).themeMisses, 1);
  monitor.query = async () => ({ name: 'Normal Public Server' });
  await monitor.run('live');
  assert.equal(monitor.servers.get(a.id).themeMisses, 1);
  advance(monitor.config.retention + 1); monitor.prune();
  assert.equal(monitor.servers.has(a.id), false);
});
test('successful live queries can retire a server even between discovery cycles', async () => {
  const { monitor } = fixture({
    query: async row => row.id === a.id
      ? { name: 'Normal Public Server', map: 'de_dust2', numplayers: 3, maxplayers: 20 }
      : { name: 'Christmas B', map: 'de_xmas' }
  });
  await monitor.init(); await monitor.run('discovery');
  await monitor.run('live');
  assert.equal(monitor.servers.get(a.id).themeMisses, 1);
  assert.equal(monitor.snapshot().servers.some(row => row.id === a.id), false);
  await monitor.run('live');
  assert.equal(monitor.servers.has(a.id), false);
  assert.equal(monitor.servers.has(b.id), true);
});
test('Steam tags-only evidence survives repeated GameDig observations and snapshot restore', async () => {
  let saved = null;
  const store = { load: async () => saved, save: async value => { saved = structuredClone(value); } };
  const adapters = { store, discover: async () => ({ servers: [tagsOnly], successfulRequests: 1 }),
    query: async () => ({ name: 'Public Server', map: 'de_dust2', numplayers: 12 }) };
  const { monitor } = fixture(adapters);
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.servers.get(tagsOnly.id).classification.confidence, 'high');
  assert.deepEqual(monitor.servers.get(tagsOnly.id).classification.reasons, ['tags: xmas']);
  for (let i = 0; i < 3; i++) await monitor.run('live');
  assert.equal(monitor.servers.get(tagsOnly.id).themeMisses, 0);
  assert.equal(monitor.servers.get(tagsOnly.id).discoveryTags, 'xmas,secure');
  const publicRow = monitor.snapshot().servers.find(row => row.id === tagsOnly.id);
  assert.equal(publicRow.classification.confidence, 'high');
  assert.equal(Object.hasOwn(publicRow, 'discoveryTags'), false);
  const restored = fixture(adapters).monitor; await restored.init(); await restored.run('live');
  assert.equal(restored.servers.get(tagsOnly.id).classification.confidence, 'high');
});
test('explicit updated Steam tags can retire a tags-only candidate; omitted tags cannot', async () => {
  let discovered = [tagsOnly];
  const { tags: _tags, ...withoutTags } = tagsOnly;
  const { monitor } = fixture({ discover: async () => ({ servers: discovered, successfulRequests: 1 }) });
  await monitor.init(); await monitor.run('discovery');
  discovered = [withoutTags]; await monitor.run('discovery');
  assert.equal(monitor.servers.get(tagsOnly.id).themeMisses, 0);
  assert.equal(monitor.servers.get(tagsOnly.id).discoveryTags, 'xmas,secure');
  discovered = [{ ...tagsOnly, tags: 'secure' }]; await monitor.run('discovery');
  assert.equal(monitor.servers.get(tagsOnly.id).themeMisses, 1);
  assert.equal(monitor.snapshot().servers.some(row => row.id === tagsOnly.id), false);
  await monitor.run('discovery');
  assert.equal(monitor.servers.has(tagsOnly.id), false);
});
test('positive GameDig name/map evidence restores a candidate after Steam tags change', async () => {
  let discovered = [tagsOnly];
  let live = { name: 'Public Server', map: 'de_dust2' };
  const { monitor } = fixture({ discover: async () => ({ servers: discovered, successfulRequests: 1 }), query: async () => live });
  await monitor.init(); await monitor.run('discovery');
  discovered = [{ ...tagsOnly, tags: 'secure' }]; await monitor.run('discovery');
  assert.equal(monitor.servers.get(tagsOnly.id).themeMisses, 1);
  live = { name: 'Public Server', map: 'de_xmas' }; await monitor.run('live');
  assert.equal(monitor.servers.get(tagsOnly.id).themeMisses, 0);
  assert.equal(monitor.snapshot().servers[0].classification.confidence, 'high');
  live = { name: 'Public Server', map: 'de_dust2' }; await monitor.run('live');
  assert.equal(monitor.servers.get(tagsOnly.id).themeMisses, 1);
  assert.equal(monitor.snapshot().servers.length, 0);
});
test('retiring a hidden automatic candidate releases MAX_SERVERS capacity', async () => {
  let discovered = [a];
  const { monitor } = fixture({ config: readConfig({ MAX_SERVERS: '1' }),
    discover: async () => ({ servers: discovered, successfulRequests: 1 }) });
  await monitor.init(); await monitor.run('discovery');
  discovered = [{ ...a, name: 'Normal Public Server', map: 'de_dust2' }];
  await monitor.run('discovery'); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 0);
  discovered = [b]; await monitor.run('discovery');
  assert.equal(monitor.servers.size, 1); assert.equal(monitor.servers.has(b.id), true);
});
test('curated servers remain monitored without theme signals, and exclusion wins', async () => {
  const normal = { ...a, name: 'Normal Public Server', map: 'de_dust2' };
  const curated = fixture({ rules: { ...rules, include: [a], exclude: new Set() },
    discover: async () => ({ servers: [normal], successfulRequests: 1 }), query: async () => normal }).monitor;
  await curated.init(); await curated.run('discovery'); await curated.run('live'); await curated.run('discovery');
  assert.equal(curated.servers.get(a.id).classification.confidence, 'curated');
  assert.equal(curated.servers.get(a.id).themeMisses, 0);
  const excluded = fixture({ rules: { ...rules, include: [a], exclude: new Set([a.id]) },
    discover: async () => ({ servers: [normal], successfulRequests: 1 }) }).monitor;
  await excluded.init(); await excluded.run('discovery');
  assert.equal(excluded.servers.has(a.id), false);
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
  const discover = steamDiscovery(config, { strong: [], weak: [] }, async url => {
    urls.push(url); const region = url.searchParams.get('filter').slice(-1);
    if (region === '1') throw Error('Steam unavailable');
    return new Response(JSON.stringify({ response: { servers: [{ addr: a.id, appid: 10, name: 'Christmas', gamedir: 'cstrike' }, { addr: '127.0.0.1:80', appid: 10 }, { addr: b.id, appid: 730 }] } }));
  });
  const result = await discover(); assert.equal(result.servers.length, 1); assert.equal(result.partial, true); assert.equal(result.successfulRequests, 7);
  assert.equal(urls.length, 8); assert.ok(urls.every(url => url.searchParams.get('filter').includes('\\appid\\10')));
});
test('Steam gametype alone creates a monitored Christmas candidate', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32) });
  const discover = steamDiscovery(config, rules, async () => new Response(JSON.stringify({ response: { servers: [
    { addr: tagsOnly.id, appid: 10, gamedir: 'cstrike', name: 'Public Server', map: 'de_dust2', gametype: 'xmas,secure' }
  ] } })));
  const { monitor } = fixture({ discover });
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.servers.get(tagsOnly.id).discoveryTags, 'xmas,secure');
  assert.equal(monitor.snapshot().servers[0].classification.confidence, 'high');
});
test('disabled and truncated discovery are explicit', async () => {
  const disabled = await steamDiscovery(readConfig({}), rules, () => { throw Error('must not request'); })(); assert.equal(disabled.disabled, true);
  const result = await steamDiscovery(readConfig({ STEAM_API_KEY: 'a'.repeat(32), DISCOVERY_LIMIT: '1' }), { strong: [], weak: [] }, async () => new Response(JSON.stringify({ response: { servers: [{ addr: a.id, appid: 10 }] } })))();
  assert.equal(result.partial, true);
});
test('targeted term selection reuses safe configured terms with a fixed request cap', () => {
  assert.deepEqual(targetedTerms({ strong: ['Xmas', 'Święta', 'xmas', 'winter\\region\\0', '*'], related: ['santa'], weak: ['snow', 'snowy'] }), ['xmas', 'swieta', 'santa']);
  assert.deepEqual(targetedTerms(rules, 5), ['christmas', 'xmas', 'noel', 'weihnacht', 'swieta']);
  assert.equal(targetedTerms({ strong: Array.from({ length: 20 }, (_, i) => `term${i}`), weak: [] }).length, 8);
});
test('broad and targeted discovery merge safely despite a targeted failure', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32) });
  const niche = parseAddress('9.9.9.9:27015');
  const filters = []; let active = 0; let peak = 0;
  const discover = steamDiscovery(config, { strong: ['xmas', 'santa'], weak: ['snow'] }, async url => {
    assert.equal(url.origin, 'https://api.steampowered.com');
    const filter = url.searchParams.get('filter'); filters.push(filter);
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    if (filter.includes('name_match\\*santa*')) throw Error('targeted timeout');
    const rows = filter.endsWith('region\\0') ? [{ addr: a.id, appid: 10, gamedir: 'cstrike', name: 'Christmas A', map: 'de_xmas', gametype: 'xmas,secure' }] :
      filter.includes('name_match\\*xmas*') ? [
        { addr: a.id, appid: 10, gamedir: 'cstrike', name: 'Christmas A', map: 'de_xmas' },
        { addr: niche.id, appid: 10, gamedir: 'cstrike', name: 'Niche Xmas', map: 'de_dust2', players: 12, max_players: 32 },
        { addr: '127.0.0.1:27015', appid: 10, name: 'Xmas private' },
        { addr: 'not-an-address', appid: 10, name: 'Xmas invalid' }
      ] : [];
    return new Response(JSON.stringify({ response: { servers: rows } }));
  });
  const result = await discover();
  assert.deepEqual(result.servers.map(row => row.id).sort(), [a.id, niche.id].sort());
  assert.equal(result.servers.find(row => row.id === a.id).tags, 'xmas,secure');
  assert.equal(result.servers.find(row => row.id === niche.id).maxPlayers, 32);
  assert.equal(result.partial, true); assert.equal(result.successfulRequests, 9);
  assert.equal(filters.length, 10); assert.equal(peak, 4);
  assert.ok(filters.every(filter => filter.startsWith('\\appid\\10\\gamedir\\cstrike\\')));
  assert.deepEqual(filters.filter(filter => filter.includes('name_match')).sort(),
    ['\\appid\\10\\gamedir\\cstrike\\name_match\\*xmas*', '\\appid\\10\\gamedir\\cstrike\\name_match\\*santa*'].sort());
});
test('default discovery fits below the stale threshold with four concurrent requests', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32) });
  const filters = []; const pending = []; const batches = [];
  const discover = steamDiscovery(config, rules, url => {
    filters.push(url.searchParams.get('filter'));
    return new Promise((resolve, reject) => pending.push(reject));
  });
  const resultPromise = discover();
  // Release one full timeout wave at a time without waiting 15 real seconds.
  let completed = 0;
  while (completed < 33) {
    await new Promise(resolve => setImmediate(resolve));
    const batch = pending.splice(0);
    assert.ok(batch.length > 0 && batch.length <= 4);
    batches.push(batch.length); completed += batch.length;
    batch.forEach(reject => reject(new Error('simulated request timeout')));
  }
  const result = await resultPromise;
  assert.deepEqual(batches, [4, 4, 4, 4, 4, 4, 4, 4, 1]);
  assert.equal(filters.length, 33);
  assert.equal(filters.filter(filter => filter.includes('\\map\\')).length, 20);
  assert.equal(filters.filter(filter => filter.includes('\\name_match\\')).length, 5);
  assert.equal(config.discoveryTimeout, 15000);
  assert.equal(batches.length * config.discoveryTimeout, 135000);
  assert.equal(config.staleAfter, 180000);
  assert.ok(batches.length * config.discoveryTimeout < config.staleAfter);
  assert.equal(result.partial, true); assert.equal(result.successfulRequests, 0);
});
test('exact Christmas map search finds a generic hostname and merges duplicate sources', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32) });
  const filters = [];
  const discover = steamDiscovery(config, rules, async url => {
    const filter = url.searchParams.get('filter'); filters.push(filter);
    const rows = filter.endsWith('region\\0') || filter.endsWith('map\\de_dust2_xmas')
      ? [{ addr: a.id, appid: 10, gamedir: 'cstrike', name: 'Public CS Server #4', map: 'de_dust2_xmas' }] : [];
    return new Response(JSON.stringify({ response: { servers: rows } }));
  });
  const result = await discover();
  assert.equal(result.servers.length, 1);
  assert.deepEqual(result.servers[0].discoverySources, ['regional', 'map:de_dust2_xmas']);
  assert.ok(filters.includes('\\appid\\10\\gamedir\\cstrike\\map\\de_dust2_xmas'));
  assert.equal(filters.length, 33);
  const { monitor } = fixture({ discover });
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.snapshot().servers.length, 1);
  assert.equal(monitor.snapshot().servers[0].classification.confidence, 'high');
  assert.equal(Object.hasOwn(monitor.snapshot().servers[0], 'discoverySources'), false);
});
test('exact map discovery rotates across the full catalog with bounded requests despite failures', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32) });
  const catalog = [...rules.maps.strong, ...rules.maps.probable];
  let filters = [];
  const discover = steamDiscovery(config, rules, async url => {
    const filter = url.searchParams.get('filter'); filters.push(filter);
    if (filter.endsWith(`map\\${catalog[0]}`)) throw Error('map search unavailable');
    return new Response(JSON.stringify({ response: { servers: [] } }));
  });
  const covered = new Set();
  for (let run = 0; run <= Math.ceil(catalog.length / 20); run++) {
    filters = [];
    const result = await discover();
    const maps = filters.filter(filter => filter.includes('\\map\\')).map(filter => filter.split('\\map\\')[1]);
    assert.deepEqual(maps, Array.from({ length: 20 }, (_, index) => catalog[(run * 20 + index) % catalog.length]));
    assert.equal(new Set(maps).size, 20);
    maps.forEach(map => covered.add(map));
    assert.equal(filters.filter(filter => filter.includes('\\region\\')).length, 8);
    assert.equal(filters.filter(filter => filter.includes('\\name_match\\')).length, 5);
    assert.equal(filters.length, 33);
    assert.equal(result.partial, maps.includes(catalog[0]));
  }
  assert.deepEqual(covered, new Set(catalog));
});
test('small map catalogs query each safe map once and retain at most five safe name searches', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32) });
  const filters = [];
  const discover = steamDiscovery(config, { ...rules, maps: {
    strong: new Set(['de_christmas', 'unsafe\\region\\0']), probable: new Set(['de_aztec_hivers'])
  } }, async url => {
    filters.push(url.searchParams.get('filter'));
    return new Response(JSON.stringify({ response: { servers: [] } }));
  });
  await discover(); await discover();
  assert.equal(filters.length, 30);
  assert.deepEqual(filters.filter(filter => filter.includes('\\map\\')).map(filter => filter.split('\\map\\')[1]),
    ['de_christmas', 'de_aztec_hivers', 'de_christmas', 'de_aztec_hivers']);
  assert.ok(filters.every(filter => !filter.includes('unsafe')));
});
test('multiple targeted searches return one logical endpoint', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32) });
  const discover = steamDiscovery(config, rules, async url => {
    const filter = url.searchParams.get('filter');
    const rows = filter.endsWith('map\\de_dust2_xmas') || filter.includes('name_match\\*christmas*')
      ? [{ addr: a.id, appid: 10, gamedir: 'cstrike', name: 'Christmas Public', map: 'de_dust2_xmas' }] : [];
    return new Response(JSON.stringify({ response: { servers: rows } }));
  });
  const result = await discover();
  assert.equal(result.servers.length, 1);
  assert.deepEqual(result.servers[0].discoverySources, ['map:de_dust2_xmas', 'name:christmas']);
});
test('restored generic snow snapshot is reclassified before serving', async () => {
  const saved = { schema: 1, state: {}, servers: [{ ...a, name: 'Public Deathmatch', map: 'fy_snow',
    classification: { confidence: 'probable', reasons: ['map: snow'] }, discoveredAt: 1000000 }] };
  const { monitor } = fixture({ store: { load: async () => saved, save: async () => {} } });
  await monitor.init();
  assert.equal(monitor.servers.has(a.id), false);
  assert.equal(monitor.snapshot().servers.length, 0);
});
test('restore preserves an already hidden candidate and its retirement grace', async () => {
  const hidden = { ...a, name: 'Public Server', map: 'de_dust2',
    classification: { confidence: 'none', reasons: [] }, themeMisses: 1, discoveredAt: 1000000 };
  const { monitor } = fixture({ store: { load: async () => ({ schema: 1, state: {}, servers: [hidden] }), save: async () => {} } });
  await monitor.init();
  assert.equal(monitor.servers.get(a.id).themeMisses, 1);
  assert.equal(monitor.snapshot().servers.length, 0);
});
test('a targeted result cap marks discovery partial while preserving broad results', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32), DISCOVERY_LIMIT: '1' });
  const discover = steamDiscovery(config, { strong: ['xmas'], weak: [] }, async url => {
    const rows = url.searchParams.get('filter').includes('name_match') ? [{ addr: b.id, appid: 10, name: 'Xmas B' }] : [];
    return new Response(JSON.stringify({ response: { servers: rows } }));
  });
  const result = await discover();
  assert.equal(result.partial, true); assert.deepEqual(result.servers.map(row => row.id), [b.id]);
});
test('GameDig uses correct game and bounded timeout without player collection', async () => {
  let options; await gameQuery(readConfig({}), async input => { options = input; return {}; }, async () => null)(a);
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

test('persisted probable-map-only servers are removed on restore and stay absent after saving again', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'christmasdust-map-restore-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new SnapshotStore(join(directory, 'snapshot.json'));
  const generic = { ...a, name: 'Public Server', map: 'cs_alpin', discoverySources: ['map:cs_alpin'] };
  const qualifying = [
    { name: 'Winter Server', map: 'cs_alpin', expected: 'probable' },
    { name: 'Public Server', map: 'cs_alpin', discoveryTags: 'snow', expected: 'probable' },
    { name: 'Public Server', map: 'cs_alpin', discoveryDescription: 'winter server', expected: 'probable' },
    { name: 'Xmas Server', map: 'cs_alpin', expected: 'high' },
    { name: 'Public Server', map: 'de_dust2_xmas', expected: 'high' },
    { name: 'Public Server', map: 'cs_alpin', curated: true, expected: 'curated' }
  ].map((row, i) => ({ ...parseAddress(`8.8.4.${i + 1}:27015`), ...row }));
  const included = parseAddress(qualifying.at(-1).id);
  const updatedRules = { ...rules, include: [included] };
  const persisted = [generic, ...qualifying].map(({ expected, ...row }) => ({ ...row, status: 'online',
    classification: { confidence: 'probable', reasons: ['map: verified winter map (cs_alpin)'] },
    discoveredAt: 1000000, lastSeenAt: 1000000 }));
  await store.save({ schema: 1, state: {}, servers: persisted });
  const { monitor } = fixture({ store, rules: updatedRules, query: async row => ({ name: row.name, map: row.map }) });
  await monitor.init();
  assert.equal(monitor.servers.has(generic.id), false);
  const expected = qualifying.map(row => [row.id, row.expected]);
  assert.deepEqual(monitor.snapshot().servers.map(row => [row.id, row.classification.confidence]), expected);
  await monitor.run('live'); // Save the reclassified monitor state through the real persistence adapter.
  const saved = await store.load();
  assert.equal(saved.servers.some(row => row.id === generic.id), false);
  assert.deepEqual(saved.servers.map(row => [row.id, row.classification.confidence]), expected);
  const restored = fixture({ store, rules: updatedRules }).monitor;
  await restored.init();
  assert.deepEqual(restored.snapshot().servers.map(row => [row.id, row.classification.confidence]), expected);
});

test('cached strong maps preserve visibility without renewing theme-observation state', async () => {
  for (const map of ['de_dust2_xmas', 'custom_christmas_arena']) {
    const server = { ...a, name: 'Public Server', map };
    const { monitor, advance } = fixture({
      discover: async () => ({ servers: [server], successfulRequests: 1, partial: false }),
      query: async () => ({ name: 'Public Server', map, numplayers: 12, maxplayers: 32 })
    });
    await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
    const lastMatch = monitor.servers.get(a.id).lastThemeMatchAt;
    monitor.query = async () => ({ name: 'Public Server' });
    advance(Math.floor(monitor.config.retention / 2)); await monitor.run('live');
    const retained = monitor.servers.get(a.id);
    assert.equal(retained.lastThemeMatchAt, lastMatch);
    assert.equal(retained.lastSeenAt, monitor.now()); // Successful queries still update liveness.
    assert.equal(monitor.snapshot().servers[0].map, map);
    assert.ok(retained.classification.signals.some(signal => signal.field === 'map' && signal.points > 0 &&
      ['known-strong-map', 'explicit'].includes(signal.kind)));
    const previous = { ...retained, themeMisses: 1 };
    const cachedOnly = monitor.themeObservation({ name: 'Public Server' }, previous, false);
    assert.equal(cachedOnly.themeMisses, 1); assert.equal(cachedOnly.lastThemeMatchAt, lastMatch);
    const observed = monitor.themeObservation({ name: 'XMAS Public Server' }, previous, false);
    assert.equal(observed.themeMisses, 0); assert.equal(observed.lastThemeMatchAt, monitor.now());
    advance(Math.floor(monitor.config.retention / 2) - 1); await monitor.run('live');
    assert.equal(monitor.servers.get(a.id).lastThemeMatchAt, lastMatch);
    advance(2); monitor.prune();
    assert.equal(monitor.servers.has(a.id), true); // Active high confidence does not expire on theme age alone.
    assert.equal(monitor.servers.get(a.id).lastThemeMatchAt, lastMatch);
    assert.equal(monitor.snapshot().servers[0].map, map);
    monitor.query = async () => ({ name: 'Public Server', map: 'de_dust2' });
    await monitor.run('live');
    const ordinary = monitor.servers.get(a.id);
    assert.equal(ordinary.classification.confidence, 'none');
    assert.ok(!ordinary.classification.signals.some(signal => signal.field === 'map' && signal.points > 0));
    assert.equal(monitor.snapshot().servers.length, 0);
    monitor.prune();
    assert.equal(monitor.servers.has(a.id), false); // Theme retention expiry applies once classification is none.
  }
});

test('old theme timestamps expire only none-confidence candidates while active high/probable servers stay', () => {
  const { monitor, advance } = fixture();
  monitor.add({ ...a, map: 'de_dust2' });
  monitor.add({ ...b, name: 'Winter Community', map: 'cs_alpin' });
  const pending = parseAddress('9.9.9.9:27015');
  monitor.add({ ...pending, name: 'Public Server', map: 'de_dust2', candidateOnly: true });
  const lastMatch = monitor.now();
  advance(monitor.config.retention + 1);
  for (const row of monitor.servers.values()) {
    row.lastSeenAt = monitor.now(); row.status = 'online'; row.lastThemeMatchAt = lastMatch;
  }
  monitor.prune();
  assert.equal(monitor.servers.get(a.id).classification.confidence, 'high');
  assert.equal(monitor.servers.get(b.id).classification.confidence, 'probable');
  assert.equal(monitor.servers.has(pending.id), false);
  assert.equal(monitor.snapshot().servers.length, 2);
});


test('history records current measured counts only; missing counts and query failures leave gaps', async t => {
  const stats = new PlayerStatsStore(':memory:'); t.after(() => stats.close());
  const { monitor, advance } = fixture({ stats });
  await monitor.init(); await monitor.run('discovery');
  assert.equal(stats.db.prepare('SELECT COUNT(*) AS n FROM player_samples').get().n, 0);
  await monitor.run('live');
  assert.equal(stats.db.prepare('SELECT players FROM player_samples WHERE server_id=?').get(a.id).players, 12);
  advance(1800000); monitor.query = async () => ({ name: 'Xmas online' }); await monitor.run('live');
  assert.equal(monitor.servers.get(a.id).players, 12);
  advance(1800000); monitor.query = async () => { throw Error('timeout'); }; await monitor.run('live');
  assert.equal(monitor.servers.get(a.id).players, 12);
  advance(SAMPLE_MS); monitor.query = async () => ({ numplayers: 0 }); await monitor.run('live');
  assert.equal(monitor.servers.get(a.id).players, 0);
  assert.deepEqual(stats.db.prepare('SELECT players FROM player_samples WHERE server_id=? ORDER BY bucket_at').all(a.id).map(row => row.players), [12, 0]);
  assert.equal(stats.history([a.id], monitor.now()).histories[a.id][46], null);
});

test('history write and cleanup failures preserve monitoring, snapshot data and visibility', async () => {
  let writes = 0;
  const normal = fixture().monitor;
  const broken = fixture({ stats: { record() { writes++; throw Error('SQLite unavailable'); }, prune() { throw Error('SQLite unavailable'); } } }).monitor;
  for (const monitor of [normal, broken]) { await monitor.init(); await monitor.run('discovery'); await monitor.run('live'); }
  assert.deepEqual(broken.snapshot(), normal.snapshot());
  assert.equal(writes, 1); await broken.run('live'); assert.equal(writes, 2);
});

test('removed endpoints stop querying and rediscovery continues their persistent history', async t => {
  const stats = new PlayerStatsStore(':memory:'); t.after(() => stats.close());
  let calls = 0;
  const { monitor, advance } = fixture({ stats, discover: async () => ({ servers: [a], successfulRequests: 1 }),
    query: async () => { calls++; return { numplayers: calls * 3 }; } });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  advance(monitor.config.retention + 1); monitor.prune();
  assert.equal(monitor.servers.size, 0);
  await monitor.run('live'); assert.equal(calls, 1);
  // Expired samples may be pruned, so model a short disappearance via existing exclusion.
  await monitor.run('discovery'); await monitor.run('live');
  monitor.rules = { ...rules, exclude: new Set([a.id]) }; monitor.prune();
  advance(SAMPLE_MS); await monitor.run('live'); assert.equal(calls, 2);
  monitor.rules = rules; await monitor.run('discovery'); await monitor.run('live'); assert.equal(calls, 3);
  assert.deepEqual(stats.db.prepare('SELECT players FROM player_samples WHERE server_id=? ORDER BY bucket_at').all(a.id).map(row => row.players), [6, 9]);
});


test('invalid player counts and unmeasured GameDig player lists never create zero samples', async t => {
  const stats = new PlayerStatsStore(':memory:'); t.after(() => stats.close());
  const { monitor, advance } = fixture({ stats });
  await monitor.init(); await monitor.run('discovery');
  for (const count of [null, undefined, -1, NaN, 1.5, []]) {
    monitor.query = async () => ({ numplayers: count });
    advance(SAMPLE_MS); await monitor.run('live');
  }
  assert.equal(stats.db.prepare('SELECT COUNT(*) AS n FROM player_samples').get().n, 0);
  monitor.query = async () => ({ players: 4 }); await monitor.run('live');
  assert.equal(stats.db.prepare('SELECT players FROM player_samples WHERE server_id=?').get(a.id).players, 4);
});
