import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readConfig, loadDetection } from '../src/config/index.js';
import { parseAddress } from '../src/utils/address.js';
import { a2sFingerprint } from '../src/domain/duplicates.js';
import { Monitor } from '../src/services/monitor.js';
import { createApp } from '../src/routes/app.js';
import { rankServers } from '../public/js/ranking.js';

const rules = await loadDetection(new URL('../config/detection.json', import.meta.url));
const endpoints = ['8.8.8.8:27015', '1.1.1.1:27015', '9.9.9.9:27015', '4.2.2.2:27015', '208.67.222.222:27015'];
const discovery = (id, name = 'Christmas Dust') => ({ ...parseAddress(id), name, map: 'de_xmas' });
const info = (players = 12, overrides = {}) => ({ name: 'Christmas Dust', map: 'de_xmas', numplayers: players,
  maxplayers: 32, password: false, version: '1.1.2.7/Stdio', raw: {
    steamid: '90123456789012345', folder: 'cstrike', game: 'Counter-Strike', protocol: 48,
    appId: 10, tags: ['xmas', 'secure'], secure: 1, ...overrides.raw
  }, ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'raw')) });

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
  const monitor = await fixture([first, second, other], row => info(12,
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
