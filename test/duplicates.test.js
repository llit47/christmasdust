import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readConfig, loadDetection } from '../src/config/index.js';
import { parseAddress } from '../src/utils/address.js';
import { a2sFingerprint } from '../src/domain/duplicates.js';
import { liveManifestFingerprint } from '../src/domain/manifests.js';
import { PlayerStatsStore } from '../src/storage/player-stats.js';
import { Monitor } from '../src/services/monitor.js';
import { createApp } from '../src/routes/app.js';
import { rankServers } from '../public/js/ranking.js';
import { isFavorite, toggleServerFavorite } from '../public/js/favorites.js';
import { filterServers } from '../public/js/filters.js';
import { gameQuery } from '../src/services/query.js';

const rules = await loadDetection(new URL('../config/detection.json', import.meta.url));
const endpoints = ['8.8.8.8:27015', '1.1.1.1:27015', '9.9.9.9:27015', '4.2.2.2:27015', '208.67.222.222:27015'];
const discovery = (id, name = 'Christmas Dust') => ({ ...parseAddress(id), name, map: 'de_xmas' });
const info = (players = 12, overrides = {}) => ({ name: 'Christmas Dust', map: 'de_xmas', numplayers: players,
  maxplayers: 32, password: false, version: '1.1.2.7/Stdio', raw: {
    steamid: '90123456789012345', folder: 'cstrike', game: 'Counter-Strike', protocol: 48,
    appId: 10, tags: ['xmas', 'secure'], secure: 1, ...overrides.raw
  }, ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'raw')) });
const distinctInfo = (row, players = 12, overrides = {}) => info(players, { ...overrides, raw: {
  steamid: String(90123456789012345n + BigInt(endpoints.indexOf(row.id))), ...overrides.raw
} });

async function fixture(ids, query, store = { load: async () => null, save: async () => {} }) {
  const monitor = new Monitor({ config: readConfig({}), rules,
    discover: async () => ({ servers: ids.map(id => discovery(id)), successfulRequests: 1, partial: false }),
    query, store, now: () => 1000000, log: { warn() {} } });
  await monitor.init(); await monitor.run('discovery'); await monitor.run('live');
  return monitor;
}

test('complete shared A2S identity groups endpoints without deleting monitored candidates', async () => {
  const [first, second, other] = endpoints;
  let persisted;
  const store = { load: async () => null, save: async value => { persisted = value; } };
  const monitor = await fixture([first, second, other], row => info(row.id === other ? 11 : 12,
    row.id === other ? { raw: { steamid: '90123456789012346' } } : {}), store);
  assert.equal(monitor.servers.size, 3);
  assert.equal(persisted.servers.length, 3);
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.servers.length, 2);
  const clone = snapshot.servers.find(row => row.duplicateCount === 1);
  assert.ok(clone);
  assert.deepEqual([clone.id, ...clone.duplicateEndpoints].sort(), [first, second].sort());
  assert.equal(Object.hasOwn(clone, 'a2sFingerprint'), false);
  assert.equal(snapshot.servers.find(row => row.id === other).duplicateCount, 0);
  const restored = new Monitor({ config: readConfig({}), rules, discover: async () => ({}), query: async () => ({}),
    store: { load: async () => persisted, save: async () => {} }, now: () => 1000000, log: { warn() {} } });
  await restored.init();
  assert.equal(restored.servers.size, 3);
  assert.equal(restored.snapshot().servers.length, 2);
});

test('shared GoldSrc challenge identity groups endpoints without A2S steamid', async () => {
  const [first, second, other] = endpoints;
  const query = gameQuery(readConfig({}), async options => info(options.host === parseAddress(other).ip ? 11 : 12, { raw: { steamid: undefined } }),
    async row => row.id === other ? '1' : '8412857032437472227');
  const monitor = await fixture([first, second, other], query);
  assert.equal(monitor.servers.size, 3);
  assert.equal(monitor.snapshot().servers.length, 2);
  assert.equal(monitor.snapshot().servers.find(row => row.id === other).duplicateCount, 0);
});

test('similar names and populations remain separate without matching strong A2S identity', async () => {
  const same = info();
  assert.equal(a2sFingerprint({ ...same, raw: { ...same.raw, steamid: undefined } }), null);
  assert.notEqual(a2sFingerprint(same), a2sFingerprint(info(12, { raw: { steamid: '90123456789012346' } })));
  assert.notEqual(a2sFingerprint(same), a2sFingerprint(info(12, { name: 'Christmas Dust #2' })));
  assert.notEqual(a2sFingerprint(same), a2sFingerprint(info(12, { raw: { tags: ['winter', 'secure'] } })));
  assert.equal(a2sFingerprint(same), a2sFingerprint(info(9, {
    name: '  CHRISTMAS   DUST  ', raw: { tags: ['secure', 'xmas'] }
  })));
  const [first, second] = endpoints;
  const monitor = await fixture([first, second], row => row.id === first ? same :
    info(12, { raw: { steamid: '90123456789012346' } }));
  assert.equal(monitor.snapshot().servers.length, 2);
  assert.ok(monitor.snapshot().servers.every(row => row.duplicateCount === 0));
});

test('representative uses existing recommended ranking and hidden clones do not occupy result slots', async () => {
  const [full, available, third, unique, another] = endpoints;
  const monitor = await fixture([full, available, third, unique, another], row => {
    if (row.id === full) return info(32);
    if (row.id === available) return info(12);
    if (row.id === third) return info(32);
    return info(4, { raw: { steamid: row.id === unique ? '90123456789012346' : '90123456789012347' } });
  });
  const rows = monitor.snapshot().servers;
  assert.equal(rows.length, 3);
  const representative = rows.find(row => row.duplicateCount === 2);
  assert.equal(representative.id, available);
  assert.deepEqual(representative.duplicateEndpoints, [full, third].sort());
  const firstPage = rankServers(rows).slice(0, 2);
  assert.equal(firstPage.length, 2);
  assert.equal(new Set(firstPage.map(row => row.id)).size, 2);
  assert.equal(firstPage.filter(row => [full, available, third].includes(row.id)).length, 1);
});

test('cached API exposes duplicate counts and endpoint IDs, never internal fingerprints', async t => {
  const monitor = await fixture(endpoints.slice(0, 2), () => info());
  const app = createApp({ config: readConfig({}), monitor });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/servers`)).json();
  assert.equal(body.servers.length, 1);
  assert.equal(body.servers[0].duplicateCount, 1);
  assert.deepEqual(body.servers[0].duplicateEndpoints, [endpoints[0] === body.servers[0].id ? endpoints[1] : endpoints[0]]);
  assert.equal(Object.hasOwn(body.servers[0], 'a2sFingerprint'), false);
  assert.equal(Object.hasOwn(body.servers[0], 'liveManifestFingerprint'), false);
  assert.equal(Object.hasOwn(body.servers[0], 'establishedManifestFingerprint'), false);
  assert.equal(Object.hasOwn(body.servers[0], 'curated'), false);
});

test('partial live A2S data ends grouping while failed queries retain last good endpoints', async () => {
  let complete = true;
  const [first, second] = endpoints;
  const monitor = await fixture([first, second], () => complete ? info() : { name: 'Christmas Dust', numplayers: 12 });
  assert.equal(monitor.snapshot().servers.length, 1);
  complete = false;
  await monitor.run('live');
  assert.equal(monitor.snapshot().servers.length, 2);
  assert.equal(monitor.servers.size, 2);
  monitor.query = async () => { throw new Error('timeout'); };
  await monitor.run('live');
  assert.equal(monitor.servers.size, 2);
});

test('stale A2S observations separate endpoints even when their stored fingerprints match', async () => {
  const monitor = await fixture(endpoints.slice(0, 2), () => info());
  assert.equal(monitor.snapshot().servers.length, 1);
  monitor.now = () => 1000000 + monitor.config.staleAfter + 1;
  const rows = monitor.snapshot().servers;
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.stale && row.duplicateCount === 0));
});

test('three identical fresh manifests hide every member despite distinct identities and recover on divergence', async () => {
  const ids = endpoints.slice(0, 3); let persisted; const queried = [];
  const monitor = await fixture(ids, row => { queried.push(row.id); return distinctInfo(row); }, {
    load: async () => null, save: async value => { persisted = value; }
  });
  assert.equal(new Set([...monitor.servers.values()].map(row => row.a2sFingerprint)).size, 3);
  assert.equal(new Set([...monitor.servers.values()].map(row => row.liveManifestFingerprint)).size, 1);
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.servers.length, 0);
  assert.equal(snapshot.servers.reduce((sum, row) => sum + row.players, 0), 0);
  assert.equal(monitor.servers.size, 3); assert.equal(persisted.servers.length, 3);
  assert.ok(persisted.servers.every(row => row.liveManifestFingerprint));
  await monitor.run('live');
  assert.deepEqual(queried, [...ids, ...ids]);
  assert.equal(monitor.snapshot().servers.length, 0);
  monitor.query = row => distinctInfo(row, row.id === ids[2] ? 11 : 12);
  await monitor.run('live');
  assert.equal(monitor.snapshot().servers.length, 3);
  assert.equal(monitor.snapshot().servers.reduce((sum, row) => sum + row.players, 0), 35);
  assert.equal(persisted.servers.length, 3);
});

test('two identical manifests are insufficient and multiple ports do not count as distinct IPs', async () => {
  const pair = await fixture(endpoints.slice(0, 2), row => distinctInfo(row));
  assert.equal(pair.snapshot().servers.length, 2);
  const sameIp = await fixture([endpoints[0], '8.8.8.8:27016', endpoints[1]], () => info(12, { raw: { steamid: undefined } }));
  assert.equal(sameIp.snapshot().servers.length, 3);
});

test('an established standalone manifest survives later clones and snapshot restore', async () => {
  const ids = endpoints.slice(0, 3); let persisted;
  const store = { load: async () => null, save: async value => { persisted = value; } };
  const monitor = await fixture([ids[0]], row => distinctInfo(row), store);
  assert.equal(monitor.servers.get(ids[0]).establishedManifestFingerprint,
    monitor.servers.get(ids[0]).liveManifestFingerprint);
  monitor.discover = async () => ({ servers: ids.map(id => discovery(id)), successfulRequests: 1, partial: false });
  await monitor.run('discovery'); await monitor.run('live');
  assert.deepEqual(monitor.snapshot().servers.map(row => row.id), [ids[0]]);
  assert.equal(monitor.snapshot().servers[0].players, 12);
  assert.equal(monitor.servers.size, 3); assert.equal(persisted.servers.length, 3);
  assert.ok(persisted.servers[0].establishedManifestFingerprint);
  assert.ok(persisted.servers.slice(1).every(row => !row.establishedManifestFingerprint));
  const restored = new Monitor({ config: readConfig({}), rules, query: row => distinctInfo(row),
    store: { load: async () => persisted, save: async () => {} }, now: () => 1000000, log: { warn() {} } });
  await restored.init(); await restored.run('live');
  assert.deepEqual(restored.snapshot().servers.map(row => row.id), [ids[0]]);
  // Evidence protects its exact manifest, not all future manifests on the endpoint.
  restored.query = row => distinctInfo(row, 11);
  await restored.run('live');
  assert.equal(restored.snapshot().servers.length, 0);
  restored.query = row => distinctInfo(row, row.id === ids[0] ? 10 : 11);
  await restored.run('live');
  assert.equal(restored.snapshot().servers.length, 3);
});

test('failed and partial standalone queries do not establish protection from later clones', async () => {
  const ids = endpoints.slice(0, 3);
  for (const query of [async () => { throw Error('timeout'); }, async () => ({ name: 'Christmas Dust', numplayers: 12 })]) {
    const monitor = await fixture([ids[0]], query);
    assert.equal(monitor.servers.get(ids[0]).establishedManifestFingerprint, undefined);
    monitor.query = row => distinctInfo(row);
    monitor.discover = async () => ({ servers: ids.map(id => discovery(id)), successfulRequests: 1, partial: false });
    await monitor.run('discovery'); await monitor.run('live');
    assert.equal(monitor.snapshot().servers.length, 0);
    assert.ok([...monitor.servers.values()].every(row => !row.establishedManifestFingerprint));
  }
});

test('a live observation that ages stale during its batch cannot establish protection', async () => {
  const ids = endpoints.slice(0, 3);
  const monitor = await fixture([], () => ({}));
  ids.slice(0, 2).forEach(id => monitor.add(discovery(id)));
  monitor.query = async row => {
    if (row.id === ids[0]) return distinctInfo(row);
    await new Promise(resolve => setImmediate(resolve));
    monitor.now = () => 1000000 + monitor.config.staleAfter + 1;
    throw Error('delayed timeout');
  };
  await monitor.run('live');
  assert.ok(monitor.snapshot().servers.find(row => row.id === ids[0]).stale);
  assert.ok([...monitor.servers.values()].every(row => !row.establishedManifestFingerprint));
  monitor.add(discovery(ids[2])); monitor.query = row => distinctInfo(row);
  await monitor.run('live');
  assert.equal(monitor.snapshot().servers.length, 0);
});

test('operator includes are exempt from manifest hiding without standalone evidence', async () => {
  const ids = endpoints.slice(0, 3);
  const monitor = await fixture(ids, row => distinctInfo(row));
  assert.equal(monitor.snapshot().servers.length, 0);
  monitor.rules = { ...rules, include: [discovery(ids[0])] };
  await monitor.run('discovery'); await monitor.run('live');
  assert.deepEqual(monitor.snapshot().servers.map(row => row.id), [ids[0]]);
  assert.equal(monitor.snapshot().servers[0].classification.confidence, 'curated');
  assert.equal(monitor.servers.get(ids[0]).establishedManifestFingerprint, undefined);
});

test('different player counts or maps prevent exact manifest clusters', async () => {
  const ids = endpoints.slice(0, 3);
  const players = await fixture(ids, row => distinctInfo(row, row.id === ids[2] ? 11 : 12));
  assert.equal(players.snapshot().servers.length, 3);
  const maps = await fixture(ids, row => distinctInfo(row, 12, row.id === ids[2] ? { map: 'de_dust2_xmas' } : {}));
  assert.equal(maps.snapshot().servers.length, 3);
});

test('partial, failed and stale observations cannot supply the third manifest match', async () => {
  const ids = endpoints.slice(0, 3);
  const monitor = await fixture(ids, row => row.id === ids[2] ? { name: 'Christmas Dust', numplayers: 12 } : distinctInfo(row));
  assert.equal(monitor.snapshot().servers.length, 3);
  monitor.query = row => { if (row.id === ids[2]) throw Error('timeout'); return distinctInfo(row); };
  await monitor.run('live');
  assert.equal(monitor.snapshot().servers.length, 3);
  monitor.query = row => distinctInfo(row);
  await monitor.run('live');
  assert.deepEqual(monitor.snapshot().servers.map(row => row.id).sort(), ids.slice(0, 2).sort());
  monitor.servers.get(ids[2]).lastSeenAt -= monitor.config.staleAfter + 1;
  assert.equal(monitor.snapshot().servers.length, 3);
  await monitor.run('live');
  monitor.query = row => { if (row.id === ids[2]) throw Error('timeout'); return distinctInfo(row); };
  await monitor.run('live');
  assert.equal(monitor.snapshot().servers.length, 3);
  monitor.query = row => row.id === ids[2] ? { name: 'Christmas Dust', numplayers: 12 } : distinctInfo(row);
  await monitor.run('live');
  assert.equal(monitor.snapshot().servers.length, 3);
});

test('manifest fingerprints normalize complete fields, exclude identities/endpoints and reject incomplete data', () => {
  const fingerprint = liveManifestFingerprint(info());
  assert.ok(fingerprint);
  assert.equal(fingerprint, liveManifestFingerprint(info(12, { name: '  CHRISTMAS   DUST ',
    serverIdentity: 'different', gamePort: 27016, raw: { steamid: '90123456789012346',
      address: '1.1.1.1:27016', tags: ['secure', 'XMAS'] } })));
  for (const field of ['name', 'map', 'numplayers', 'maxplayers', 'password', 'version']) {
    const raw = info(); delete raw[field];
    assert.equal(liveManifestFingerprint(raw), null, field);
  }
  for (const field of ['folder', 'game', 'protocol']) {
    const raw = info(); delete raw.raw[field];
    assert.equal(liveManifestFingerprint(raw), null, field);
  }
  for (const override of [{ maxplayers: 0 }, { numplayers: NaN }, { password: undefined },
    { raw: { numbots: -1 } }, { raw: { tags: [1] } }])
    assert.equal(liveManifestFingerprint(info(12, override)), null);
  for (const override of [{ maxplayers: 31 }, { password: true }, { version: 'another version' },
    { raw: { numbots: 0 } }, { raw: { folder: 'other' } }, { raw: { game: 'other' } },
    { raw: { protocol: 47 } }, { raw: { appId: 11 } }, { raw: { tags: ['other'] } },
    { raw: { secure: 0 } }, { raw: { environment: 'l' } }])
    assert.notEqual(liveManifestFingerprint(info(12, override)), fingerprint);
});

test('favorites follow any grouped endpoint when the representative changes', () => {
  const [oldId, newId] = endpoints;
  const favorites = new Set([oldId]);
  const group = { id: newId, duplicateEndpoints: [oldId], name: 'Christmas Dust', map: 'de_xmas',
    players: 12, status: 'online', classification: { confidence: 'high' } };
  const filters = { search: '', country: '', map: '', confidence: '', slots: false,
    favorites: true, hideEmpty: false };
  assert.equal(isFavorite(group, favorites), true);
  assert.deepEqual(filterServers([group], filters, favorites), [group]);
  toggleServerFavorite(group, favorites);
  assert.equal(favorites.size, 0);
  toggleServerFavorite(group, favorites);
  assert.deepEqual([...favorites], [newId]);
  const reverted = { ...group, id: oldId, duplicateEndpoints: [newId] };
  assert.equal(isFavorite(reverted, favorites), true);
  assert.deepEqual(filterServers([reverted], filters, favorites), [reverted]);
});


test('history is collected for identity-grouped and manifest-suppressed endpoints', async t => {
  for (const [ids, query, publicCount] of [
    [endpoints.slice(0, 2), () => info(), 1],
    [endpoints.slice(0, 3), row => distinctInfo(row), 0]
  ]) {
    const stats = new PlayerStatsStore(':memory:'); t.after(() => stats.close());
    const monitor = await fixture(ids, query); monitor.stats = stats;
    const before = monitor.snapshot();
    await monitor.run('live');
    assert.deepEqual(monitor.snapshot(), before);
    assert.equal(monitor.snapshot().servers.length, publicCount);
    assert.equal(monitor.servers.size, ids.length);
    assert.deepEqual(stats.db.prepare('SELECT server_id, players FROM player_samples ORDER BY server_id').all().map(row => [row.server_id, row.players]),
      [...ids].sort().map(id => [id, 12]));
  }
});
