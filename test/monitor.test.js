import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, loadDetection } from '../src/config/index.js';
import { Monitor } from '../src/services/monitor.js';
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
  assert.equal(filters.length, 10); assert.equal(peak, 2);
  assert.ok(filters.every(filter => filter.startsWith('\\appid\\10\\gamedir\\cstrike\\')));
  assert.deepEqual(filters.filter(filter => filter.includes('name_match')).sort(),
    ['\\appid\\10\\gamedir\\cstrike\\name_match\\*xmas*', '\\appid\\10\\gamedir\\cstrike\\name_match\\*santa*'].sort());
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
  assert.ok(filters.length <= 18);
  const { monitor } = fixture({ discover });
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.snapshot().servers.length, 1);
  assert.equal(monitor.snapshot().servers[0].classification.confidence, 'high');
  assert.equal(Object.hasOwn(monitor.snapshot().servers[0], 'discoverySources'), false);
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
