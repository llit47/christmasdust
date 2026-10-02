import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { RatingsStore } from '../src/storage/ratings.js';
import { createApp } from '../src/routes/app.js';
import { readConfig } from '../src/config/index.js';
import { groupDuplicates } from '../src/domain/duplicates.js';
import { rankServers } from '../public/js/ranking.js';

const a = '8.8.8.8:27015', b = '1.1.1.1:27015';
const hash = token => createHash('sha256').update(token).digest('hex');
function store(t) { const ratings = new RatingsStore(':memory:'); t.after(() => ratings.close()); return ratings; }

test('SQLite creates schema idempotently, persists votes, enforces uniqueness and stores only token hashes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ratings-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'nested', 'ratings.sqlite');
  let ratings = new RatingsStore(path);
  const token = 'f'.repeat(64), voter = hash(token);
  ratings.mutate([a], a, voter, 1, 10);
  assert.throws(() => ratings.db.prepare('INSERT INTO ratings VALUES (?, ?, ?, ?, ?)').run(a, voter, -1, 11, 11), /UNIQUE/);
  assert.throws(() => ratings.db.prepare('INSERT INTO ratings VALUES (?, ?, ?, ?, ?)').run(a, 'other', 0, 11, 11), /CHECK/);
  ratings.close(); ratings = new RatingsStore(path); t.after(() => ratings.close());
  assert.deepEqual(ratings.totals([a], voter), { up: 1, down: 0, vote: 1 });
  assert.equal(ratings.db.prepare('SELECT voter_hash FROM ratings').get().voter_hash, voter);
  assert.equal((await readFile(path)).includes(Buffer.from(token)), false);
  ratings.mutate([a], a, voter, -1, 20);
  assert.deepEqual({ ...ratings.db.prepare('SELECT created_at, updated_at FROM ratings').get() }, { created_at: 10, updated_at: 20 });
});

test('votes change/delete transactionally across a group; splits, merges and representative changes keep endpoint history', t => {
  const ratings = store(t), voter = hash('voter');
  ratings.mutate([a], a, voter, 1, 10);
  ratings.mutate([b], b, voter, -1, 20);
  assert.deepEqual(ratings.totals([a, b], voter), { up: 0, down: 1, vote: -1 });
  assert.deepEqual(ratings.totals([b, a], voter), ratings.totals([a, b], voter));
  assert.deepEqual(ratings.totals([a], voter), { up: 1, down: 0, vote: 1 });
  assert.deepEqual(ratings.totals([b], voter), { up: 0, down: 1, vote: -1 });
  ratings.mutate([a, b], b, voter, 1, 30);
  assert.equal(ratings.db.prepare('SELECT count(*) AS n FROM ratings').get().n, 1);
  assert.equal(ratings.db.prepare('SELECT server_id FROM ratings').get().server_id, b);
  assert.deepEqual(ratings.totals([a], voter), { up: 0, down: 0, vote: null });
  ratings.mutate([a, b], a, voter, null, 40);
  assert.deepEqual(ratings.totals([a, b], voter), { up: 0, down: 0, vote: null });
  // A failed insert rolls back the group deletion.
  ratings.mutate([a], a, voter, 1, 50);
  assert.throws(() => ratings.mutate([a, b], b, voter, 0, 60));
  assert.equal(ratings.totals([a, b], voter).vote, 1);
});

async function fixture(t, env = {}) {
  const ratings = store(t); let clock = 100;
  const calls = [];
  const monitor = { snapshot: () => ({ servers: [{ id: a, duplicateEndpoints: [b] }], meta: {} }), run: () => calls.push('network') };
  const app = createApp({ config: readConfig(env), monitor, ratings, now: () => clock });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const get = (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
  const vote = (body, { method = 'PUT', cookie, headers = {} } = {}) => get('/api/ratings', { method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { ratings, monitor, calls, get, vote, advance: () => { clock += 60001; } };
}

test('rating API creates anonymous HttpOnly Lax cookie only on action and exposes totals/current vote in existing list', async t => {
  const { get, vote, ratings, calls } = await fixture(t);
  assert.equal((await get('/api/servers')).headers.get('set-cookie'), null);
  const response = await vote({ serverId: a, value: 1 });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /christmasdust_voter=[a-f0-9]{64}/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=31536000/); assert.doesNotMatch(cookie, /Secure/);
  const identity = cookie.split(';')[0];
  assert.equal(ratings.db.prepare('SELECT voter_hash FROM ratings').get().voter_hash, hash(identity.split('=')[1]));
  assert.deepEqual((await response.json()).ratings, { up: 1, down: 0, vote: 1 });
  const changed = await vote({ serverId: b, value: -1 }, { cookie: identity });
  assert.equal(changed.headers.get('set-cookie'), null);
  assert.deepEqual((await changed.json()).ratings, { up: 0, down: 1, vote: -1 });
  assert.equal(ratings.db.prepare('SELECT server_id FROM ratings').get().server_id, b);
  let list = await (await get('/api/servers', { headers: { Cookie: identity } })).json();
  assert.deepEqual(list.servers[0].ratings, { up: 0, down: 1, vote: -1 });
  assert.equal((await (await get('/api/servers')).json()).servers[0].ratings.vote, null);
  assert.deepEqual((await (await vote({ serverId: a }, { method: 'DELETE', cookie: identity })).json()).ratings, { up: 0, down: 0, vote: null });
  assert.deepEqual(calls, []);
});

test('cookie Secure follows HTTPS through explicitly trusted proxies only; invalid cookies are replaced', async t => {
  const trusted = await fixture(t, { TRUSTED_PROXIES: '127.0.0.1/32' });
  const response = await trusted.vote({ serverId: a, value: 1 }, { cookie: 'christmasdust_voter=bad', headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  const untrusted = await fixture(t);
  assert.doesNotMatch((await untrusted.vote({ serverId: a, value: -1 }, { headers: { 'X-Forwarded-Proto': 'https' } })).headers.get('set-cookie'), /Secure/);
});

test('API follows current representative, split and merge without rewriting stored endpoint rows', async t => {
  const { vote, monitor, get, ratings } = await fixture(t);
  const response = await vote({ serverId: a, value: 1 }); const cookie = response.headers.get('set-cookie').split(';')[0];
  monitor.snapshot = () => ({ servers: [{ id: b, duplicateEndpoints: [a] }], meta: {} });
  assert.equal((await (await get('/api/servers', { headers: { Cookie: cookie } })).json()).servers[0].ratings.vote, 1);
  assert.equal(ratings.db.prepare('SELECT server_id FROM ratings').get().server_id, a);
  monitor.snapshot = () => ({ servers: [{ id: a }, { id: b }], meta: {} });
  await vote({ serverId: b, value: -1 }, { cookie });
  let list = await (await get('/api/servers', { headers: { Cookie: cookie } })).json();
  assert.deepEqual(list.servers.map(row => row.ratings.vote), [1, -1]);
  monitor.snapshot = () => ({ servers: [{ id: b, duplicateEndpoints: [a] }], meta: {} });
  assert.equal((await (await get('/api/servers')).json()).servers[0].ratings.up + (await (await get('/api/servers')).json()).servers[0].ratings.down, 1);
  await vote({ serverId: b }, { method: 'DELETE', cookie });
  assert.equal(ratings.db.prepare('SELECT count(*) AS n FROM ratings').get().n, 0);
});

test('strict bodies, public canonical endpoint IDs, known targets and 1 KiB limit', async t => {
  const { vote, ratings, calls } = await fixture(t);
  for (const body of [null, [], {}, { serverId: a }, { serverId: 5, value: 1 }, { serverId: a, value: '1' },
    { serverId: a, value: 0 }, { serverId: a, value: 2 }, { serverId: a, value: true }, { serverId: a, value: 1, extra: 1 },
    { serverId: '127.0.0.1:27015', value: 1 }, { serverId: '8.8.8.8:027015', value: 1 }, '{bad']) {
    assert.equal((await vote(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await vote({ serverId: '9.9.9.9:27015', value: 1 })).status, 404);
  assert.equal((await vote({ serverId: a, value: 1 }, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await vote({ serverId: a, value: 1 }, { method: 'DELETE' })).status, 400);
  assert.equal((await vote(' '.repeat(1025))).status, 413);
  assert.equal(ratings.db.prepare('SELECT count(*) AS n FROM ratings').get().n, 0); assert.deepEqual(calls, []);
});

test('mutation limits apply to voter across IPs and to IP across fresh cookies, and expire', async t => {
  const { vote, advance, get } = await fixture(t, { TRUSTED_PROXIES: '127.0.0.1/32' });
  const first = await vote({ serverId: a, value: 1 }); const cookie = first.headers.get('set-cookie').split(';')[0];
  for (let i = 0; i < 19; i++) assert.equal((await vote({ serverId: a, value: 1 }, { cookie, headers: { 'X-Forwarded-For': `8.8.4.${i + 1}` } })).status, 200);
  assert.equal((await vote({ serverId: a, value: 1 }, { cookie, headers: { 'X-Forwarded-For': '1.0.0.1' } })).status, 429);
  advance();
  for (let i = 0; i < 60; i++) assert.equal((await vote({ serverId: a, value: 1 })).status, 200);
  const blocked = await vote({ serverId: a, value: 1 }); assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal((await get('/api/servers')).status, 200);
  advance(); assert.equal((await vote({ serverId: a, value: -1 }, { cookie })).status, 200);
});

test('ratings cannot influence existing duplicate representative or backend ranking', t => {
  const ratings = store(t);
  const rows = [{ id: a, a2sFingerprint: 'same', status: 'online', stale: false, players: 8, maxPlayers: 32, classification: { confidence: 'high' } },
    { id: b, a2sFingerprint: 'same', status: 'online', stale: false, players: 4, maxPlayers: 32, classification: { confidence: 'high' } }];
  const before = groupDuplicates(rows);
  const rated = rows.map((row, i) => ({ ...row, ratings: { up: i * 100, down: (1 - i) * 100, vote: -1 } }));
  assert.deepEqual(groupDuplicates(rated).map(({ ratings, ...row }) => row), before);
  assert.deepEqual(rankServers(rated, { includeRatings: false }).map(row => row.id), rankServers(rows).map(row => row.id));
});

test('compact rating controls show counts/selection, change votes, remove selection and retain data on failure', async () => {
  const { serverCard } = await import('../public/js/render.js');
  const document = { createElement: tag => ({ tag, children: [], listeners: {}, attrs: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; }, append(...children) { this.children.push(...children); } }) };
  const server = { id: a, name: 'Winter', players: 1, maxPlayers: 32, classification: { confidence: 'high' }, ratings: { up: 2, down: 3, vote: 1 } };
  const values = []; let fail = false;
  const card = serverCard(document, server, { rate: async (_server, value) => {
    values.push(value); return fail ? null : { up: 1, down: value === -1 ? 4 : 3, vote: value };
  } });
  const nodes = [card]; for (let i = 0; i < nodes.length; i++) nodes.push(...nodes[i].children);
  const up = nodes.find(node => node.textContent === '👍 2'), down = nodes.find(node => node.textContent === '👎 3');
  assert.equal(up.attrs['aria-pressed'], 'true'); assert.equal(down.attrs['aria-pressed'], 'false');
  await up.listeners.click(); assert.deepEqual(values, [null]); assert.equal(up.attrs['aria-pressed'], 'false');
  await down.listeners.click(); assert.deepEqual(values, [null, -1]); assert.equal(down.textContent, '👎 4'); assert.equal(down.attrs['aria-pressed'], 'true');
  fail = true; await up.listeners.click(); assert.equal(down.attrs['aria-pressed'], 'true'); assert.equal(up.disabled, false);
});

test('body limit also applies to chunked JSON and other API bodies remain rejected', async t => {
  const { get, ratings } = await fixture(t);
  async function* chunks() { yield '{"serverId":"'; yield 'a'.repeat(1100); yield '","value":1}'; }
  const response = await get('/api/ratings', { method: 'PUT', duplex: 'half', headers: { 'Content-Type': 'application/json' }, body: chunks() });
  assert.equal(response.status, 413);
  assert.equal((await get('/api/admin/refresh', { method: 'POST', body: '{}' })).status, 413);
  assert.equal((await get('/api/ratings', { method: 'POST', body: '{}' })).status, 413);
  assert.equal(ratings.db.prepare('SELECT count(*) AS n FROM ratings').get().n, 0);
});

test('server list stops ratings reads after the first failure and retries on the next request', async t => {
  const { get, monitor, ratings, vote } = await fixture(t);
  const snapshot = { servers: [{ id: a, name: 'Winter', status: 'online', duplicateEndpoints: [b] },
    { id: '9.9.9.9:27015', name: 'Other' }], meta: { lastLiveAt: 123, stale: false } };
  monitor.snapshot = () => snapshot;
  const original = structuredClone(snapshot);
  let reads = 0;
  ratings.totals = ids => {
    reads++;
    if (ids.includes(a)) throw new Error('SQLite read failure');
    return { up: 2, down: 1, vote: null };
  };
  const response = await get('/api/servers');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.servers[0], { ...snapshot.servers[0], ratings: null });
  assert.deepEqual(body.servers[1], { ...snapshot.servers[1], ratings: null });
  assert.equal(reads, 1);
  assert.deepEqual(body.meta, { ...snapshot.meta, ratingsPartial: true, serverGeoipConfigured: false });
  assert.deepEqual(snapshot, original);
  assert.equal((await vote({ serverId: a, value: 1 })).status, 500);
  ratings.totals = () => { reads++; return { up: 2, down: 1, vote: null }; };
  const recovered = await get('/api/servers');
  assert.equal(recovered.status, 200);
  assert.equal(reads, 4); // Initial read, failed mutation read, then both servers on recovery.
  const recoveredBody = await recovered.json();
  assert.equal(recoveredBody.meta.ratingsPartial, false);
  assert.deepEqual(recoveredBody.servers.map(server => server.ratings), [
    { up: 2, down: 1, vote: null }, { up: 2, down: 1, vote: null }]);
});

test('ratings read failure keeps successful totals including genuine zeros and marks failed/skipped reads unavailable', async t => {
  const { get, monitor, ratings } = await fixture(t);
  const ids = [a, b, '9.9.9.9:27015', '4.4.4.4:27015'];
  monitor.snapshot = () => ({ servers: ids.map(id => ({ id })), meta: {} });
  const queried = [];
  ratings.totals = endpoints => {
    queried.push(endpoints[0]);
    if (endpoints[0] === ids[2]) throw new Error('SQLite busy');
    if (endpoints[0] === b) return { up: 0, down: 0, vote: null };
    return { up: 2, down: 3, vote: 1 };
  };
  const response = await get('/api/servers');
  assert.equal(response.status, 200);
  assert.deepEqual(queried, ids.slice(0, 3));
  const body = await response.json();
  assert.equal(body.meta.ratingsPartial, true);
  assert.deepEqual(body.servers.map(server => server.ratings), [
    { up: 2, down: 3, vote: 1 }, { up: 0, down: 0, vote: null }, null, null]);
});

test('HTTPS PUT and DELETE renew the existing HTTP voter cookie as Secure without changing identity', async t => {
  const { vote, ratings } = await fixture(t, { TRUSTED_PROXIES: '127.0.0.1/32' });
  const initial = await vote({ serverId: a, value: 1 });
  assert.equal(initial.status, 200);
  const minted = initial.headers.get('set-cookie');
  assert.doesNotMatch(minted, /; Secure/);
  const cookie = minted.split(';')[0];
  const headers = { 'X-Forwarded-Proto': 'https' };
  for (const method of ['PUT', 'DELETE']) {
    const response = await vote(method === 'PUT' ? { serverId: a, value: -1 } : { serverId: a }, { method, cookie, headers });
    assert.equal(response.status, 200);
    const renewed = response.headers.get('set-cookie');
    assert.equal(renewed.split(';')[0], cookie);
    for (const attribute of [/; HttpOnly/, /; SameSite=Lax/, /; Secure/, /; Max-Age=31536000/, /; Path=\//, /; Expires=/])
      assert.match(renewed, attribute);
    if (method === 'PUT') {
      assert.deepEqual((await response.json()).ratings, { up: 0, down: 1, vote: -1 });
      assert.equal(ratings.db.prepare('SELECT count(*) AS n FROM ratings').get().n, 1);
      assert.equal(ratings.db.prepare('SELECT voter_hash FROM ratings').get().voter_hash, hash(cookie.split('=')[1]));
    } else assert.deepEqual((await response.json()).ratings, { up: 0, down: 0, vote: null });
  }
});
