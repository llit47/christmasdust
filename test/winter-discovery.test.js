import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, loadDetection } from '../src/config/index.js';
import { classify } from '../src/domain/classify.js';
import { combinedDiscovery } from '../src/services/combined-discovery.js';
import { steamDiscovery } from '../src/services/discovery.js';
import { Monitor } from '../src/services/monitor.js';
import { parseAddress } from '../src/utils/address.js';

const rules = await loadDetection(new URL('../config/detection.json', import.meta.url));
const reference = { ...parseAddress('91.224.117.35:27155'),
  name: '[PL] ZIMA 1.6 * Classic Winter * Choinka * www.zima16.pl', map: 'de_westwood', maxPlayers: 18,
  discoverySources: ['name:winter'] };
const vibe = { ...parseAddress('92.62.251.120:27015'), name: 'WINTER VIBE • ЗИМНИЙ ПАБЛИК • LEGION-CS',
  map: 'de_dust2', discoverySources: ['name:winter'] };
const christmas = { ...parseAddress('1.1.1.1:27015'), name: 'Christmas Public', map: 'de_dust2', discoverySources: ['regional'] };
const response = servers => ({ servers, successfulRequests: 1, partial: false, disabled: false });
const farm = (start = 0, length = 300) => Array.from({ length }, (_, index) => ({
  ...parseAddress(`8.8.8.8:${28000 + start + index}`), name: index % 2 ? '  ϟ LUDNICA Jailbreak [ＷＩＮＴＥＲ UPDATE] ' :
    'ϟ Ludnica Jailbreak [WINTER UPDATE]', map: 'de_dust2', discoverySources: ['name:winter']
}));
function fixture(servers, { maxServers = 1000, saved = null, include = [], query } = {}) {
  let candidates = servers, persisted, time = 1000000;
  const config = readConfig({ MAX_SERVERS: String(maxServers), STEAM_API_KEY: 'a'.repeat(32) });
  const discover = combinedDiscovery(config, rules, { web: async () => response(candidates) });
  const monitor = new Monitor({ config, rules: { ...rules, include }, discover,
    query: query ?? (async row => ({ name: row.name, map: row.map, maxplayers: row.maxPlayers || 32 })),
    now: () => time, log: { warn() {} },
    store: { load: async () => saved, save: async value => { persisted = value; } } });
  return { monitor, rotate: rows => { candidates = rows; }, persisted: () => persisted,
    advance: ms => { time += ms; } };
}

for (const candidate of [reference, vibe]) {
  test(`${candidate.id}: targeted winter identity becomes probable only after successful live verification`, async () => {
    const { monitor } = fixture([candidate]);
    assert.equal(classify(candidate, rules).confidence, 'none');
    await monitor.init(); await monitor.run('discovery');
    assert.equal(monitor.servers.get(candidate.id).classification.confidence, 'none');
    assert.equal(monitor.snapshot().servers.length, 0);
    await monitor.run('live');
    const row = monitor.snapshot().servers.find(row => row.id === candidate.id);
    assert.ok(row); assert.equal(row.status, 'online'); assert.equal(row.stale, false);
    assert.equal(row.classification.confidence, 'probable');
    assert.equal(row.map, candidate.map);
    assert.ok(row.classification.signals.some(signal => signal.kind === 'live-verified-winter-name'));
    if (candidate.id === reference.id) assert.equal(row.maxPlayers, 18);
    assert.equal(classify(monitor.servers.get(candidate.id), rules).confidence, 'none');
  });
}

test('failed live winter queries remain pending and never receive promotion', async () => {
  const { monitor } = fixture([reference], { query: async () => { throw Error('timeout'); } });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  const row = monitor.servers.get(reference.id);
  assert.equal(row.classification.confidence, 'none'); assert.equal(row.status, 'uncertain');
  assert.equal(row.lastSeenAt, null); assert.equal(monitor.snapshot().servers.length, 0);
  assert.equal(monitor.state.livePartial, true);
});

for (const [label, candidate, liveName] of [
  ['snow-only', { ...reference, name: 'Snow Arena', discoverySources: ['name:snow'] }, 'Snow Arena'],
  ['snow discovery with live winter name', { ...reference, discoverySources: ['name:snow'] }, reference.name],
  ['regional-only winter', { ...reference, discoverySources: ['regional'] }, reference.name],
  ['lost winter identity', reference, 'Classic Public'],
  ['winter substring', reference, 'Wintertime Public'],
  ['negated winter identity', reference, 'No Winter Public']
]) {
  test(`${label} does not receive targeted winter promotion`, async () => {
    const { monitor } = fixture([candidate], { query: async () => ({ name: liveName, map: 'de_westwood', maxplayers: 18 }) });
    await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
    assert.equal(monitor.servers.get(reference.id)?.classification.confidence ?? 'none', 'none');
    assert.equal(monitor.snapshot().servers.length, 0);
  });
}

test('winter farm normalization caps admission at two and leaves room for distinct relevant servers', async () => {
  const { monitor } = fixture([...farm(), reference, christmas], { maxServers: 4 });
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 4);
  assert.equal([...monitor.servers.values()].filter(row => row.ip === '8.8.8.8').length, 2);
  assert.ok(monitor.servers.has(reference.id)); assert.ok(monitor.servers.has(christmas.id));
  assert.equal(monitor.coverage.discovery.candidatesDropped, 298);
  assert.equal(monitor.state.discoveryPartial, false); // Deliberate name sampling is not an upstream outage.
});

test('winter cap applies across live promotion, restore and later cycles without deleting existing rows', async () => {
  const initial = fixture(farm(0, 2)); const { monitor } = initial;
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  assert.equal(monitor.servers.size, 2);
  assert.ok([...monitor.servers.values()].every(row => row.classification.confidence === 'probable'));
  initial.rotate(farm(2)); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 2);
  const restored = fixture(farm(2), { saved: initial.persisted() }).monitor;
  await restored.init(); await restored.run('discovery');
  assert.equal(restored.servers.size, 2);
  assert.ok([...restored.servers.values()].every(row => row.classification.confidence === 'probable'));
  assert.deepEqual([...restored.servers.keys()], farm(0, 2).map(row => row.id));
});

test('winter cap exempts independent Christmas/XMAS, known-map and operator inclusion evidence', async () => {
  const same = farm(0, 6);
  same[2].tags = 'christmas'; same[3].description = 'xmas'; same[4].map = 'de_christmas';
  const { monitor } = fixture(same, { include: [same[5]] });
  await monitor.init(); await monitor.run('discovery');
  for (const candidate of same.slice(2)) assert.ok(monitor.servers.has(candidate.id));
  assert.equal(monitor.servers.get(same[5].id).classification.confidence, 'curated');
  // Preexisting unclassified rows are kept even when other members now exhaust the cap.
  for (const candidate of same.slice(0, 2)) monitor.servers.set(candidate.id, { ...candidate,
    classification: classify(candidate, rules), discoveredAt: monitor.now() });
  await monitor.run('discovery');
  assert.equal(monitor.servers.size, 6);
});

for (const maxServers of [1, 3]) {
  test(`issue #26: Christmas wins the last slot with MAX_SERVERS=${maxServers} despite noisy winter hits`, async () => {
    const { monitor } = fixture([...farm(), christmas], { maxServers });
    await monitor.init();
    for (let index = 0; index < maxServers - 1; index++) monitor.add({ ...parseAddress(`9.9.9.9:${27015 + index}`), name: 'Xmas Existing' });
    await monitor.run('discovery');
    assert.equal(monitor.servers.size, maxServers);
    assert.ok(monitor.servers.has(christmas.id));
    assert.equal(monitor.servers.get(christmas.id).classification.confidence, 'high');
    assert.ok(![...monitor.servers.values()].some(row => row.ip === '8.8.8.8'));
  });
}

test('monitor admission orders relevant, targeted pending, then broad pending independently of adapter order', async () => {
  const { monitor } = fixture([], { maxServers: 2 });
  const targeted = { ...reference, candidateOnly: true };
  const broad = { ...parseAddress('9.9.9.9:27015'), candidateOnly: true, discoverySources: ['master:regional'] };
  monitor.discover = async () => response([broad, targeted, christmas]);
  await monitor.init(); await monitor.run('discovery');
  assert.deepEqual([...monitor.servers.keys()], [christmas.id, targeted.id]);
});

test('distinct winter names still share the 128 pending bound without blocking classifiable candidates', async () => {
  const candidates = farm(0, 150).map((row, index) => ({ ...row, name: `Winter Community ${index}` }));
  const { monitor } = fixture([...candidates, christmas]);
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 129);
  assert.equal([...monitor.servers.values()].filter(row => row.classification.confidence === 'none').length, 128);
  assert.ok(monitor.servers.has(christmas.id));
});

test('verified winter survives discovery, incomplete responses and failures, then retires after losing live identity', async () => {
  const fixtureState = fixture([reference]); const { monitor } = fixtureState;
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  fixtureState.rotate([{ ...reference, name: 'Old Public Metadata' }]); await monitor.run('discovery');
  assert.equal(monitor.servers.get(reference.id).classification.confidence, 'probable');
  assert.equal(monitor.servers.get(reference.id).name, reference.name);
  monitor.query = async () => ({ numplayers: 4 }); await monitor.run('live');
  assert.equal(monitor.servers.get(reference.id).classification.confidence, 'probable');
  monitor.query = async () => { throw Error('timeout'); }; await monitor.run('live');
  assert.equal(monitor.servers.get(reference.id).classification.confidence, 'probable');
  monitor.query = async () => ({ name: 'Classic Public', map: 'de_westwood', maxplayers: 18 });
  await monitor.run('live');
  assert.equal(monitor.servers.get(reference.id).classification.confidence, 'none');
  assert.equal(monitor.servers.get(reference.id).themeMisses, 1);
  assert.equal(monitor.snapshot().servers.length, 0);
  await monitor.run('live'); assert.equal(monitor.servers.has(reference.id), false);
});

test('healthy Steam discovery never invokes unavailable legacy Master or reports its coverage', async () => {
  const config = readConfig({ STEAM_API_KEY: 'a'.repeat(32) }); let requests = 0, masterCalls = 0;
  const web = steamDiscovery(config, rules, async () => {
    requests++;
    return new Response(JSON.stringify({ response: { servers: [{ addr: christmas.id, appid: 10, gamedir: 'cstrike', name: christmas.name }] } }));
  });
  const { monitor } = fixture([]);
  monitor.discover = combinedDiscovery(config, rules, { web, master: () => {
    masterCalls++; throw Object.assign(Error('legacy DNS unavailable'), { code: 'ENOTFOUND' });
  } });
  await monitor.init(); await monitor.run('discovery');
  assert.ok(requests > 8); assert.equal(masterCalls, 0);
  assert.equal(monitor.state.discoveryPartial, false); assert.equal(monitor.state.discoveryDisabled, false);
  assert.deepEqual(monitor.snapshot().meta.coverage.discovery, { steamEndpoints: 1, candidatesRetained: 1, candidatesDropped: 0 });
  assert.deepEqual(monitor.servers.get(christmas.id).discoverySources.at(-1), 'web-api');
});

for (const mode of ['auto', 'seeds']) {
  test(`${mode} without a key uses configured includes without Steam or Master requests`, async () => {
    const config = readConfig({ DISCOVERY_MODE: mode });
    const { monitor } = fixture([], { include: [reference] });
    monitor.discover = combinedDiscovery(config, rules, {
      web: steamDiscovery(config, rules, () => assert.fail('no Steam request')),
      master: () => assert.fail('no Master request')
    });
    await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
    assert.equal(monitor.state.discoveryDisabled, true); assert.equal(monitor.state.discoveryPartial, false);
    assert.equal(monitor.snapshot().servers[0].classification.confidence, 'curated');
  });
}

for (const failure of ['throw', 'reject', 'unavailable']) {
  test(`Steam coverage and last-good rows survive ${failure}, then recover to a real zero`, async () => {
    let failing = false, empty = false;
    const { monitor } = fixture([]);
    monitor.discover = combinedDiscovery(monitor.config, rules, { web: () => {
      if (failing) {
        if (failure === 'throw') throw Error('adapter failure');
        if (failure === 'reject') return Promise.reject(Error('adapter failure'));
        return { ...response([]), partial: true, successfulRequests: 0 };
      }
      return response(empty ? [] : [christmas]);
    } });
    await monitor.init(); await monitor.run('discovery');
    assert.equal(monitor.coverage.discovery.steamEndpoints, 1);
    failing = true; await monitor.run('discovery');
    assert.equal(monitor.coverage.discovery.steamEndpoints, 1); assert.equal(monitor.state.discoveryPartial, true);
    assert.ok(monitor.servers.has(christmas.id));
    failing = false; empty = true; await monitor.run('discovery');
    assert.equal(monitor.coverage.discovery.steamEndpoints, 0); assert.equal(monitor.state.discoveryPartial, false);
    assert.ok(monitor.servers.has(christmas.id));
  });
}

test('issue #26 across cycles: a Christmas arrival replaces one pending winter row at MAX_SERVERS=2', async () => {
  const { monitor, rotate, persisted } = fixture([reference, vibe], { maxServers: 2 });
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 2);
  assert.ok([...monitor.servers.values()].every(row => row.classification.confidence === 'none' && row.lastSeenAt === null));
  assert.deepEqual(monitor.coverage.discovery, { steamEndpoints: 2, candidatesRetained: 2, candidatesDropped: 0 });
  rotate([christmas]); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 2);
  assert.equal(monitor.servers.get(christmas.id).classification.confidence, 'high');
  assert.equal(monitor.servers.has(reference.id), false);
  assert.equal(monitor.servers.has(vibe.id), true);
  assert.equal(monitor.state.discoveryPartial, false);
  // Admission counters describe this response, not evictions absent from it.
  assert.deepEqual(monitor.coverage.discovery, { steamEndpoints: 1, candidatesRetained: 1, candidatesDropped: 0 });
  assert.deepEqual(persisted().servers.map(row => row.id), [vibe.id, christmas.id]);
});

for (const older of ['age', 'endpoint tie-break']) {
  test(`pending eviction deterministically chooses by ${older} rather than insertion order`, async () => {
    const { monitor, rotate, advance } = fixture(older === 'age' ? [vibe] : [vibe, reference], { maxServers: 2 });
    await monitor.init(); await monitor.run('discovery');
    if (older === 'age') {
      advance(1000); rotate([reference]); await monitor.run('discovery');
    }
    assert.equal(monitor.servers.size, 2);
    rotate([christmas]); await monitor.run('discovery');
    const evicted = older === 'age' ? vibe : reference;
    const retained = older === 'age' ? reference : vibe;
    assert.equal(monitor.servers.has(evicted.id), false);
    assert.ok(monitor.servers.has(retained.id)); assert.ok(monitor.servers.has(christmas.id));
    assert.equal(monitor.servers.size, 2);
  });
}

test('curated/operator-included rows stay while a pending row is evicted', async () => {
  const { monitor, rotate } = fixture([reference, vibe], { maxServers: 2, include: [reference] });
  await monitor.init(); await monitor.run('discovery');
  const included = monitor.servers.get(reference.id);
  assert.equal(included.classification.confidence, 'curated');
  rotate([christmas]); await monitor.run('discovery');
  assert.strictEqual(monitor.servers.get(reference.id), included);
  assert.equal(monitor.servers.has(vibe.id), false); assert.ok(monitor.servers.has(christmas.id));
  assert.equal(monitor.servers.size, 2);
});

test('operator includes remain protected even when persisted flags do not identify them as curated', async () => {
  const { monitor, rotate } = fixture([reference, vibe], { maxServers: 2, include: [reference] });
  await monitor.init(); await monitor.run('discovery');
  const included = monitor.servers.get(reference.id);
  included.curated = false; included.classification = classify(reference, rules);
  rotate([christmas]); await monitor.run('discovery');
  assert.strictEqual(monitor.servers.get(reference.id), included);
  assert.equal(monitor.servers.has(vibe.id), false); assert.ok(monitor.servers.has(christmas.id));
  assert.equal(monitor.servers.size, 2);
});

for (const confidence of ['high', 'probable']) {
  test(`existing ${confidence} live rows are protected while a pending row is evicted`, async () => {
    const existing = confidence === 'high' ? { ...reference, name: 'Xmas Existing' } : reference;
    const { monitor, rotate } = fixture([existing, vibe], { maxServers: 2 });
    await monitor.init(); await monitor.run('discovery'); await monitor.run('live', [existing.id]);
    const retained = monitor.servers.get(existing.id);
    assert.equal(retained.classification.confidence, confidence);
    rotate([christmas]); await monitor.run('discovery');
    assert.strictEqual(monitor.servers.get(existing.id), retained);
    assert.equal(monitor.servers.has(vibe.id), false); assert.ok(monitor.servers.has(christmas.id));
    assert.equal(monitor.servers.size, 2);
  });
}

test('full classified capacity rejects arrivals without evicting existing high or probable rows', async () => {
  const existingHigh = { ...vibe, name: 'Christmas Existing' };
  const { monitor, rotate } = fixture([reference, existingHigh], { maxServers: 2 });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live', [reference.id]);
  const prior = new Map(monitor.servers);
  assert.equal(prior.get(reference.id).classification.confidence, 'probable');
  assert.equal(prior.get(existingHigh.id).classification.confidence, 'high');
  rotate([christmas]); await monitor.run('discovery');
  assert.deepEqual(monitor.servers, prior); assert.equal(monitor.servers.has(christmas.id), false);
  assert.deepEqual(monitor.coverage.discovery, { steamEndpoints: 1, candidatesRetained: 0, candidatesDropped: 1 });
});

test('full curated capacity rejects arrivals without evicting includes', async () => {
  const { monitor, rotate } = fixture([], { maxServers: 2, include: [reference, vibe] });
  await monitor.init();
  const prior = new Map(monitor.servers);
  rotate([christmas]); await monitor.run('discovery');
  assert.deepEqual(monitor.servers, prior); assert.equal(monitor.servers.has(christmas.id), false);
  assert.deepEqual(monitor.coverage.discovery, { steamEndpoints: 1, candidatesRetained: 0, candidatesDropped: 1 });
});

test('previously successful live rows remain protected even when currently unclassified', async () => {
  const { monitor, rotate } = fixture([reference, vibe], { maxServers: 2,
    query: async () => ({ name: 'Public', map: 'de_dust2', maxplayers: 32 }) });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  assert.ok([...monitor.servers.values()].every(row => row.classification.confidence === 'none' && row.lastSeenAt != null));
  monitor.servers.get(reference.id).lastSeenAt = 0; // A valid successful timestamp must not count as unverified.
  const prior = new Map(monitor.servers);
  rotate([christmas]); await monitor.run('discovery');
  assert.deepEqual(monitor.servers, prior); assert.equal(monitor.servers.has(christmas.id), false);
  assert.deepEqual(monitor.coverage.discovery, { steamEndpoints: 1, candidatesRetained: 0, candidatesDropped: 1 });
});

test('unclassified arrivals cannot evict earlier pending discovery rows', async () => {
  const { monitor, rotate } = fixture([reference, vibe], { maxServers: 2 });
  await monitor.init(); await monitor.run('discovery');
  const prior = new Map(monitor.servers);
  rotate(farm(0, 1)); await monitor.run('discovery');
  assert.deepEqual(monitor.servers, prior);
  assert.deepEqual(monitor.coverage.discovery, { steamEndpoints: 1, candidatesRetained: 0, candidatesDropped: 1 });
});

test('evicted pending candidates also returned in the current pass count as dropped, with retained rows counted once', async () => {
  const { monitor, rotate } = fixture([reference, vibe], { maxServers: 2 });
  await monitor.init(); await monitor.run('discovery');
  rotate([reference, vibe, christmas]); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 2); assert.ok(monitor.servers.has(christmas.id));
  assert.equal(monitor.servers.has(reference.id), false); assert.ok(monitor.servers.has(vibe.id));
  assert.deepEqual(monitor.coverage.discovery, { steamEndpoints: 3, candidatesRetained: 2, candidatesDropped: 1 });
});
