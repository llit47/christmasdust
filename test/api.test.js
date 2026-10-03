import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createApp } from '../src/routes/app.js';
import { PlayerStatsStore, SAMPLE_MS } from '../src/storage/player-stats.js';
import { readConfig } from '../src/config/index.js';
async function fixture(t, env = {}, extras = {}) {
  const calls = []; const monitor = { ready: true, busy: null, snapshot: () => ({ servers: [], meta: { stale: true } }), run: async kind => { calls.push(kind); } };
  const app = createApp({ config: readConfig(env), monitor, geoip: () => ({ countryCode: 'DE', latitude: 1, longitude: 2 }), ...extras });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { monitor, calls, get: (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options) };
}
test('public polling never triggers discovery; visitor location is country only', async t => {
  const { get, calls } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const response = await get('/api/servers', { headers: { 'CF-IPCountry': 'US', 'X-Forwarded-For': '8.8.8.8' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
    const body = await response.json(); assert.deepEqual(body.visitor, { countryCode: 'DE' });
  }
  assert.equal((await get('/api/servers?filter=%5Cname_match%5C%2Aprivate%2A')).status, 200);
  assert.deepEqual(calls, []); assert.equal((await get('/api/query?ip=127.0.0.1')).status, 404);
});
test('server snapshot reports whether server GeoIP is configured without visitor coordinates', async t => {
  const absent = await fixture(t);
  const absentBody = await (await absent.get('/api/servers')).json();
  assert.equal(absentBody.meta.serverGeoipConfigured, false);
  const configured = await fixture(t, { GEOIP_PATH: '/var/lib/christmasdust-geoip/GeoLite2-City.mmdb' });
  configured.monitor.snapshot = () => ({ servers: [{ id: '8.8.8.8:27015', countryCode: 'DE', country: 'Germany', latitude: 52.52, longitude: 13.405 }], meta: {} });
  const body = await (await configured.get('/api/servers')).json();
  assert.equal(body.meta.serverGeoipConfigured, true);
  assert.deepEqual(body.servers[0], { id: '8.8.8.8:27015', countryCode: 'DE', country: 'Germany', latitude: 52.52, longitude: 13.405 });
  assert.deepEqual(body.visitor, { countryCode: 'DE' });
});
test('health and readiness work independently of upstream freshness', async t => {
  const { get, monitor } = await fixture(t); assert.equal((await get('/api/ready')).status, 200);
  const body = await (await get('/api/health')).json(); assert.equal(body.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version); assert.equal(body.stale, true);
  monitor.ready = false; assert.equal((await get('/api/ready')).status, 503);
});
test('Cloudflare headers require explicitly trusted immediate proxy', async t => {
  const { get } = await fixture(t, { TRUST_CF_COUNTRY: 'true', TRUSTED_PROXIES: '127.0.0.1/32' });
  assert.equal((await (await get('/api/servers', { headers: { 'CF-IPCountry': 'PL' } })).json()).visitor.countryCode, 'PL');
  const other = await fixture(t, { TRUST_CF_COUNTRY: 'true', TRUSTED_PROXIES: '1.1.1.1/32' });
  assert.equal((await (await other.get('/api/servers', { headers: { 'CF-IPCountry': 'PL' } })).json()).visitor.countryCode, 'DE');
});
test('admin disabled by default; auth, busy response and cooldown when enabled', async t => {
  const initial = await fixture(t); assert.equal((await initial.get('/api/admin/refresh', { method: 'POST' })).status, 404);
  const token = 'z'.repeat(32); const { get, calls, monitor } = await fixture(t, { ADMIN_TOKEN: token });
  assert.equal((await get('/api/admin/refresh', { method: 'POST' })).status, 401);
  const options = { method: 'POST', headers: { Authorization: `Bearer ${token}` } };
  monitor.busy = 'live'; assert.equal((await get('/api/admin/refresh', options)).status, 409); monitor.busy = null;
  assert.equal((await get('/api/admin/refresh', options)).status, 202);
  assert.equal((await get('/api/admin/refresh', options)).status, 429); assert.deepEqual(calls, ['discovery', 'live']);
});
test('frontend assets served with strict headers; unknown routes reveal no stack', async t => {
  const { get } = await fixture(t); const response = await get('/'); assert.equal(response.status, 200);
  assert.match(await response.text(), /Winter server browser/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get('/.env')).status, 404); assert.equal((await get('/api/unknown')).status, 404);
});
test('all API request bodies are rejected before they can cause work', async t => {
  const { get, calls } = await fixture(t, { ADMIN_TOKEN: 'a'.repeat(32) });
  assert.equal((await get('/api/admin/refresh', { method: 'POST', body: '{"target":"127.0.0.1"}', headers: { Authorization: `Bearer ${'a'.repeat(32)}` } })).status, 413);
  assert.deepEqual(calls, []);
});


test('history API returns only current public IDs with bounded series and no live queries', async t => {
  const stats = new PlayerStatsStore(':memory:'); t.after(() => stats.close());
  const now = 100 * 86400000;
  const a = '8.8.8.8:27015', b = '1.1.1.1:27015', hidden = '9.9.9.9:27015';
  stats.record(a, 0, now); stats.record(b, 12, now); stats.record(hidden, 30, now);
  const { get, monitor, calls } = await fixture(t, {}, { stats, now: () => now });
  monitor.snapshot = () => ({ servers: [{ id: a, duplicateEndpoints: [hidden] }, { id: b }], meta: {} });
  const response = await get(`/api/player-history?serverId=${hidden}`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.deepEqual(Object.keys(data.histories), [b, a]);
  assert.equal(data.bucketMs, 1800000); assert.equal(data.startAt + data.bucketMs * 48, now + data.bucketMs);
  assert.equal(data.histories[a].length, 48); assert.equal(data.histories[a][47], 0);
  assert.ok(data.histories[a].slice(0, 47).every(value => value === null));
  const list = await (await get('/api/servers')).json();
  assert.deepEqual(list.servers, monitor.snapshot().servers);
  assert.equal(Object.hasOwn(list, 'histories'), false);
  monitor.snapshot = () => ({ servers: [{ id: hidden }], meta: {} });
  assert.deepEqual(Object.keys((await (await get('/api/player-history')).json()).histories), [hidden]);
  assert.equal((await get('/api/player-history', { method: 'POST', body: '{}' })).status, 413);
  assert.equal((await get('/api/player-history', { method: 'PUT' })).status, 404);
  assert.deepEqual(calls, []);
});

test('history database read failure and absence leave the ordinary server API unchanged', async t => {
  const stats = { history() { throw Error('SQLite failure'); } };
  const { get, monitor } = await fixture(t, {}, { stats });
  const snapshot = { servers: [{ id: '8.8.8.8:27015', players: 18 }], meta: {} };
  monitor.snapshot = () => snapshot;
  assert.equal((await get('/api/player-history')).status, 503);
  assert.deepEqual((await (await get('/api/servers')).json()).servers, snapshot.servers);
  const absent = await fixture(t); assert.equal((await absent.get('/api/player-history')).status, 503);
  assert.equal((await absent.get('/api/servers')).status, 200);
});

const historyFor = (ids, timestamp) => ({ startAt: timestamp, bucketMs: 1800000,
  histories: Object.fromEntries(ids.map(id => [id, Array(48).fill(null)])) });

test('history cache shares aggregation and serialized JSON across requests with the same public ID set', async t => {
  const a = '8.8.8.8:27015', b = '1.1.1.1:27015';
  let reads = 0, serializations = 0;
  const stats = { history(ids, timestamp) {
    reads++;
    const data = historyFor(ids, timestamp);
    return { toJSON() { serializations++; return data; } };
  } };
  const { get, monitor } = await fixture(t, {}, { stats, now: () => 1000000 });
  monitor.snapshot = () => ({ servers: [{ id: a }, { id: b }], meta: {} });
  const first = await get('/api/player-history');
  assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.match(first.headers.get('content-type'), /^application\/json/);
  const payload = await first.text();
  assert.deepEqual(JSON.parse(payload), historyFor([b, a], 1000000));
  monitor.snapshot = () => ({ servers: [{ id: b, players: 12 }, { id: a }], meta: { lastLiveAt: 1000001 } });
  for (let i = 0; i < 3; i++) {
    const response = await get('/api/player-history', { headers: { Cookie: `visitor=${i}` } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), payload);
  }
  assert.equal(reads, 1); assert.equal(serializations, 1);
});

test('history cache rebuilds when public IDs change and never serves removed or hidden endpoints', async t => {
  const a = '8.8.8.8:27015', b = '1.1.1.1:27015', c = '9.9.9.9:27015';
  const reads = [];
  const stats = { history(ids, timestamp) { reads.push(ids); return historyFor(ids, timestamp); } };
  const { get, monitor } = await fixture(t, {}, { stats, now: () => 1000000 });
  monitor.snapshot = () => ({ servers: [{ id: a }, { id: b }], meta: {} });
  assert.deepEqual(Object.keys((await (await get('/api/player-history')).json()).histories), [b, a]);
  monitor.snapshot = () => ({ servers: [{ id: a, duplicateEndpoints: [b] }, { id: c }], meta: {} });
  const changed = await (await get('/api/player-history')).json();
  assert.deepEqual(Object.keys(changed.histories), [a, c]);
  assert.equal(Object.hasOwn(changed.histories, b), false);
  assert.deepEqual(reads, [[b, a], [a, c]]);
  await get('/api/player-history'); assert.equal(reads.length, 2);
  monitor.snapshot = () => ({ servers: [], meta: {} });
  assert.deepEqual((await (await get('/api/player-history')).json()).histories, {});
  await get('/api/player-history'); assert.equal(reads.length, 3);
});

test('history cache expires after one sampling interval without extending expiry on cache hits', async t => {
  let timestamp = 1000000, reads = 0;
  const stats = { history(ids, at) { reads++; return historyFor(ids, at); } };
  const { get } = await fixture(t, {}, { stats, now: () => timestamp });
  const initial = await (await get('/api/player-history')).json();
  timestamp += SAMPLE_MS - 1;
  assert.deepEqual(await (await get('/api/player-history')).json(), initial);
  assert.equal(reads, 1);
  timestamp++;
  const refreshed = await (await get('/api/player-history')).json();
  assert.equal(refreshed.startAt, timestamp); assert.equal(reads, 2);
  await get('/api/player-history'); assert.equal(reads, 2);
});

test('history cache never caches failures and retries immediately, including after a cached success expires', async t => {
  let timestamp = 1000000, reads = 0, fail = true;
  const stats = { history(ids, at) { reads++; if (fail) throw Error('SQLite failure'); return historyFor(ids, at); } };
  const { get } = await fixture(t, {}, { stats, now: () => timestamp });
  const failure = await get('/api/player-history');
  assert.equal(failure.status, 503); assert.equal(failure.headers.get('cache-control'), 'no-store');
  fail = false;
  assert.equal((await get('/api/player-history')).status, 200); assert.equal(reads, 2);
  await get('/api/player-history'); assert.equal(reads, 2);
  timestamp += SAMPLE_MS; fail = true;
  assert.equal((await get('/api/player-history')).status, 503); assert.equal(reads, 3);
  fail = false;
  assert.equal((await get('/api/player-history')).status, 200); assert.equal(reads, 4);
});

test('history cache does not retain a result whose JSON serialization fails', async t => {
  let reads = 0;
  const stats = { history(ids, timestamp) {
    if (++reads === 1) return { toJSON() { throw Error('Serialization failure'); } };
    return historyFor(ids, timestamp);
  } };
  const { get } = await fixture(t, {}, { stats, now: () => 1000000 });
  assert.equal((await get('/api/player-history')).status, 503);
  assert.equal((await get('/api/player-history')).status, 200);
  await get('/api/player-history'); assert.equal(reads, 2);
});

test('health and servers expose compact coverage metadata without triggering discovery or live queries', async t => {
  const { get, monitor, calls } = await fixture(t);
  const coverage = { discovery: { steamEndpoints: 23,
    candidatesRetained: 12, candidatesDropped: 4 },
  live: { queriedEndpoints: 12, queryFailures: 2, classificationNone: 3 },
  visibility: { monitoredEndpoints: 12, classificationNone: 3, capacityHidden: 1,
    manifestSuppressed: 0, nameMirrorSuppressed: 2, duplicateAliases: 1, publicServers: 5 } };
  monitor.snapshot = () => ({ servers: [], meta: { coverage } });
  const health = await (await get('/api/health')).json();
  const servers = await (await get('/api/servers')).json();
  assert.deepEqual(health.coverage, coverage);
  assert.deepEqual(servers.meta.coverage, coverage);
  assert.deepEqual(calls, []);
});
