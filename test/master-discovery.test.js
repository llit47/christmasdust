import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readConfig, loadDetection } from '../src/config/index.js';
import { parseAddress } from '../src/utils/address.js';
import { parseMasterResponse, queryMaster, masterDiscovery, createMasterSendPacer } from '../src/services/master-discovery.js';
import { combinedDiscovery } from '../src/services/combined-discovery.js';
import { steamDiscovery } from '../src/services/discovery.js';
import { Monitor } from '../src/services/monitor.js';

const rules = await loadDetection(new URL('../config/detection.json', import.meta.url));
const config = readConfig({});
const masterIp = '8.8.4.4';
const first = parseAddress('8.8.8.8:27015');
const second = parseAddress('1.1.1.1:27015');
const filter = '\\appid\\10\\gamedir\\cstrike';
const result = (servers, overrides = {}) => ({ servers, successfulRequests: 1, partial: false, disabled: false, ...overrides });
const resolve = async (host, options) => {
  assert.equal(host, 'hl2master.steampowered.com'); assert.deepEqual(options, { family: 4 });
  return { address: masterIp };
};
function packet(ids, done = true) {
  const entries = [...ids, ...(done ? ['0.0.0.0:0'] : [])].map(id => {
    const [ip, port] = id.split(':'); const entry = Buffer.alloc(6);
    ip.split('.').forEach((byte, index) => { entry[index] = Number(byte); });
    entry.writeUInt16BE(Number(port), 4); return entry;
  });
  return Buffer.concat([Buffer.from([255, 255, 255, 255, 0x66, 0x0a]), ...entries]);
}
function socket(onSend) {
  const instance = new EventEmitter(); instance.closed = 0; instance.sent = [];
  instance.close = () => { instance.closed++; };
  instance.send = (request, port, ip, callback) => {
    assert.equal(ip, masterIp); assert.equal(port, 27011);
    instance.sent.push(request); callback();
    queueMicrotask(() => onSend(instance, request));
  };
  return instance;
}
const reply = (instance, data) => instance.emit('message', data, { address: masterIp, port: 27011 });
const options = { ip: masterIp, region: 3, filter, limit: 128, timeoutMs: 30 };
// Protocol fixtures exercise both pages immediately; pacing is verified separately below.
const unpaced = send => { send(); return () => {}; };

function pacingClock() {
  let time = 0; let nextId = 0; const timers = new Map();
  const drain = target => {
    while (true) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      time = Math.max(time, next[1].at); timers.delete(next[0]); next[1].callback();
    }
    time = target;
  };
  return { now: () => time,
    setTimer: (callback, delay) => { const id = nextId++; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimer: id => timers.delete(id), advance: ms => drain(time + ms),
    stall: ms => { time += ms; drain(time); }, pending: () => timers.size };
}

test('shared master send pacing prevents bursts from fast replies and pagination', () => {
  const clock = pacingClock(); const pace = createMasterSendPacer(clock); const sends = [];
  for (let filter = 0; filter < 12; filter++) pace(() => {
    sends.push(clock.now());
    // A successful instantaneous first page queues the next page on the same pacer.
    pace(() => sends.push(clock.now()));
  });
  clock.advance(180000);
  assert.equal(sends.length, 24); assert.equal(clock.pending(), 0);
  assert.ok(sends.slice(1).every((at, index) => at - sends[index] >= 6000));
  for (let start = 0; start <= sends.at(-1); start += 1000)
    assert.ok(sends.filter(at => at >= start && at < start + 60000).length <= 10);
});

test('master pacing cancels queued sends and never catches up with a burst after a delayed timer', () => {
  const clock = pacingClock(); const pace = createMasterSendPacer(clock); const sends = [];
  pace(() => sends.push(clock.now()));
  const cancel = pace(() => assert.fail('cancelled packet must never be sent'));
  cancel(); assert.equal(clock.pending(), 0);
  pace(() => sends.push(clock.now())); pace(() => sends.push(clock.now()));
  clock.stall(60000);
  assert.deepEqual(sends, [0, 60000]);
  clock.advance(5999); assert.equal(sends.length, 2);
  clock.advance(1); assert.deepEqual(sends, [0, 60000, 66000]);
});

test('production master pacing is global across sockets and instances, with expired pages cancelled', async () => {
  const firstSocket = socket(current => reply(current, packet([first.id], false)));
  const found = await queryMaster(options, () => firstSocket);
  assert.deepEqual(found.servers, [first]); assert.equal(found.partial, true);
  assert.equal(firstSocket.sent.length, 1); assert.equal(firstSocket.closed, 1);
  const secondSocket = socket(() => assert.fail('pacing must prevent another immediate send'));
  const blocked = await queryMaster(options, () => secondSocket);
  assert.equal(blocked.partial, true); assert.equal(secondSocket.sent.length, 0);
  const instances = [];
  const discover = masterDiscovery({ ...config, discoveryTimeout: 10 }, { maps: {} }, {
    resolve, query: input => {
      const instance = socket(() => assert.fail('a new discovery instance must share the pacer'));
      instances.push(instance); return queryMaster(input, () => instance);
    }
  });
  const empty = await discover(); assert.equal(empty.partial, true);
  assert.equal(instances.length, 8); assert.ok(instances.every(instance => instance.sent.length === 0 && instance.closed === 1));
});

test('master parser validates framing, public IPv4 endpoints and network-order ports', () => {
  const unsafe = ['127.0.0.1:27015', '10.1.1.1:27015', '100.64.1.1:27015', '169.254.1.1:27015',
    '198.51.100.1:27015', '224.0.0.1:27015', '8.8.8.8:0'];
  assert.deepEqual(parseMasterResponse(packet([first.id, ...unsafe, second.id])).servers, [first, second]);
  assert.equal(parseMasterResponse(packet([])).done, true);
  for (const invalid of [Buffer.alloc(8197), Buffer.alloc(12), packet([first.id]).subarray(0, -1),
    Buffer.concat([packet([]), Buffer.alloc(6)]), Buffer.alloc(6)]) assert.equal(parseMasterResponse(invalid), null);
});

test('master query uses fixed destination, exact wire filters and the same socket for pagination', async () => {
  const instance = socket((current, request) => {
    if (current.sent.length === 1) {
      assert.deepEqual([...request.subarray(0, 2)], [0x31, 3]);
      assert.equal(request.subarray(2).toString('ascii'), `0.0.0.0:0\0${filter}\0`);
      current.emit('message', packet([second.id]), { address: '9.9.9.9', port: 27011 });
      current.emit('message', packet([second.id]), { address: masterIp, port: 1234 });
      reply(current, Buffer.alloc(12));
      reply(current, packet([first.id], false));
    } else {
      assert.equal(request.subarray(2).toString('ascii'), `${first.id}\0${filter}\0`);
      reply(current, packet([second.id]));
    }
  });
  const found = await queryMaster(options, () => instance, unpaced);
  assert.deepEqual(found, { servers: [first, second], partial: false, successfulRequests: 2 });
  assert.equal(instance.sent.length, 2); assert.equal(instance.closed, 1);
  assert.throws(() => queryMaster({ ...options, filter: `${filter}\\map\\*` }));
  assert.throws(() => queryMaster({ ...options, ip: '127.0.0.1' }));
});

test('master timeout retains prior pages and bounds pagination, endpoint counts and socket lifetime', async () => {
  const timeoutSocket = socket(current => { if (current.sent.length === 1) reply(current, packet([first.id], false)); });
  const timed = await queryMaster(options, () => timeoutSocket, unpaced);
  assert.deepEqual(timed.servers, [first]); assert.equal(timed.partial, true);
  assert.equal(timeoutSocket.closed, 1);
  const cappedSocket = socket(current => reply(current, packet([first.id, second.id])));
  const capped = await queryMaster({ ...options, limit: 1 }, () => cappedSocket, unpaced);
  assert.deepEqual(capped.servers, [first]); assert.equal(capped.partial, true);
  const pageSocket = socket(current => reply(current, packet([current.sent.length === 1 ? first.id : second.id], false)));
  const pages = await queryMaster(options, () => pageSocket, unpaced);
  assert.equal(pageSocket.sent.length, 2); assert.equal(pages.partial, true);
  assert.equal(pages.servers.length, 2); assert.equal(pageSocket.closed, 1);
  const failedSocket = socket(current => current.emit('error', Error('UDP unavailable')));
  assert.equal((await queryMaster(options, () => failedSocket, unpaced)).partial, true);
  assert.equal(failedSocket.closed, 1);
});

test('master discovery rotates the full catalog, covers regions and bounds requests/concurrency', async () => {
  let requests = []; let active = 0; let peak = 0;
  const discover = masterDiscovery(config, rules, { resolve, query: async input => {
    requests.push(input); active++; peak = Math.max(peak, active);
    await new Promise(done => setImmediate(done)); active--;
    return result([]);
  } });
  const catalog = [...rules.maps.strong, ...rules.maps.probable];
  for (let run = 0; run < Math.ceil(catalog.length / 20); run++) {
    requests = []; await discover();
    assert.equal(requests.length, 28);
    assert.deepEqual(requests.filter(request => request.region !== 255).map(request => request.region).sort(), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(new Set(requests.filter(request => request.region === 255).map(request => request.filter.split('\\map\\')[1])),
      new Set(Array.from({ length: 20 }, (_, index) => catalog[(run * 20 + index) % catalog.length])));
    assert.equal(requests[0].filter, `${filter}\\map\\${catalog[(run * 20 + run) % catalog.length]}`);
    assert.ok(requests.every(request => request.timeoutMs === 1500 && request.limit === 128));
  }
  assert.equal(peak, 2);
  assert.equal(Math.ceil(28 / peak) * 1500 + 1500, 22500);
});

test('master rotates its first filter so pacing cannot permanently starve regional searches', async () => {
  let firstRequest; const firstRegions = new Set();
  const discover = masterDiscovery(config, rules, { resolve, query: async input => {
    firstRequest ??= input; return result([]);
  } });
  for (let run = 0; run < 28; run++) {
    firstRequest = null; await discover();
    if (firstRequest.region !== 255) firstRegions.add(firstRequest.region);
  }
  assert.deepEqual(firstRegions, new Set([0, 1, 2, 3, 4, 5, 6, 7]));
});

test('master adapter caps total endpoints, strips metadata, preserves provenance and bounds DNS failure', async () => {
  const discover = masterDiscovery({ ...config, maxServers: 1 }, rules, { resolve,
    query: async () => result([{ ...first, name: 'Untrusted Xmas', map: 'de_christmas' }, second,
      { id: '127.0.0.1:27015' }, { id: 'bad' }]) });
  const found = await discover();
  assert.equal(found.servers.length, 1); assert.equal(found.partial, true);
  assert.equal(found.servers[0].candidateOnly, true); assert.equal(found.servers[0].name, undefined);
  assert.equal(found.servers[0].map, undefined);
  assert.ok(found.servers[0].discoverySources.includes('master:regional'));
  assert.ok(found.servers[0].discoverySources.includes('master:map:de_christmas'));
  for (const resolve of [async () => { throw Error('DNS failed'); }, () => new Promise(() => {})]) {
    const failed = await masterDiscovery({ ...config, discoveryTimeout: 10 }, rules, {
      resolve, query: () => { throw Error('must not query'); }
    })();
    assert.equal(failed.partial, true); assert.equal(failed.successfulRequests, 0);
  }
  const seeds = readConfig({ DISCOVERY_MODE: 'seeds' });
  const disabled = await combinedDiscovery(seeds, rules, {
    web: steamDiscovery(seeds, rules, () => { throw Error('must not fetch'); }),
    master: masterDiscovery(seeds, rules, { resolve: () => { throw Error('must not resolve'); } })
  })();
  assert.equal(disabled.disabled, true); assert.equal(disabled.servers.length, 0);
});

test('combined discovery merges endpoints once without replacing Web API metadata or losing provenance', async () => {
  const web = async () => result([{ ...first, name: 'Christmas Web', map: 'de_dust2_xmas', discoverySources: ['regional'] }]);
  let master = () => result([{ ...first, name: 'Spoof', map: 'fy_snow', discoverySources: ['master:regional'] },
    { ...second, name: 'Spoof Xmas', map: 'de_christmas', discoverySources: ['master:map:de_christmas'] }]);
  const discover = combinedDiscovery(config, rules, { web, master: () => master() });
  const found = await discover();
  assert.equal(found.servers.length, 2);
  assert.equal(found.servers[0].name, 'Christmas Web'); assert.equal(found.servers[0].candidateOnly, false);
  assert.deepEqual(found.servers[0].discoverySources, ['regional', 'web-api', 'master:regional', 'master-udp']);
  assert.equal(found.servers[1].name, undefined); assert.equal(found.servers[1].candidateOnly, true);
  assert.ok(found.servers[1].discoverySources.includes('master-udp'));
  for (const failed of [() => { throw Error('UDP timeout'); }, () => result([], { partial: true, successfulRequests: 0 })]) {
    master = failed; const remaining = await discover();
    assert.equal(remaining.partial, true); assert.equal(remaining.servers.length, 1);
    assert.equal(remaining.servers[0].name, 'Christmas Web'); assert.equal(remaining.successfulRequests, 1);
  }
});

test('master-only endpoints enter monitoring but must pass live classification and all public filters', async () => {
  const ids = [first.id, second.id, '9.9.9.9:27015', '4.2.2.2:27015', '208.67.222.222:27015',
    '8.8.4.4:27015', '208.67.220.220:27015', '1.0.0.1:27015', '13.107.21.200:27015'];
  const excluded = ids.at(-1); const queried = []; let persisted;
  const live = row => ({ name: 'Christmas Mirrors', map: 'de_xmas', numplayers: 12, maxplayers: 32,
    password: false, version: '1.1.2.7/Stdio', raw: { folder: 'cstrike', game: 'Counter-Strike', protocol: 48, appId: 10 },
    ...(row.id === ids[0] ? { name: 'Public', map: 'de_aztec_hivers', numplayers: 2 } : {}),
    ...(row.id === ids[1] ? { name: 'Public', map: 'fy_snow' } : {}),
    ...(row.id === ids[2] ? { maxplayers: 64 } : {}),
    ...(ids.slice(6, 8).includes(row.id) ? { name: 'Christmas Alias', numplayers: row.id === ids[6] ? 2 : 5,
      serverIdentity: '90123456789012345' } : {}) });
  const master = masterDiscovery(config, rules, { resolve, query: async () => result(ids.map(parseAddress)) });
  const discover = combinedDiscovery(config, rules, { master });
  const monitor = new Monitor({ config, rules: { ...rules, exclude: new Set([excluded]) }, discover,
    query: async () => { throw Error('live timeout'); }, now: () => 1000000, log: { warn() {} },
    store: { load: async () => null, save: async value => { persisted = value; } } });
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 8); assert.equal(monitor.snapshot().servers.length, 0);
  assert.equal(monitor.snapshot().meta.discoveryDisabled, false);
  await monitor.run('live'); assert.equal(monitor.snapshot().servers.length, 0);
  monitor.query = async row => { queried.push(row.id); return live(row); };
  await monitor.run('live');
  assert.equal(queried.length, 8); assert.ok(!queried.includes(excluded));
  const rows = monitor.snapshot().servers;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === first.id).classification.confidence, 'probable');
  assert.equal(rows.find(row => row.duplicateCount === 1).duplicateEndpoints.length, 1);
  assert.ok(rows.every(row => !ids.slice(1, 6).includes(row.id)));
  assert.equal(monitor.servers.size, 8); assert.equal(persisted.servers.length, 8);
  assert.ok(persisted.servers.every(row => row.discoverySources.includes('master-udp')));
  await monitor.run('discovery');
  assert.equal(monitor.snapshot().servers.length, 2);
  // A later Web-only discovery must retain the endpoint's earlier master provenance.
  monitor.discover = async () => result([{ ...first, name: 'Public', map: 'de_aztec_hivers', discoverySources: ['web-api'] }]);
  await monitor.run('discovery');
  assert.ok(monitor.servers.get(first.id).discoverySources.includes('master-udp'));
  assert.ok(monitor.servers.get(first.id).discoverySources.includes('web-api'));
});

test('pending master candidates are capped without blocking Web API candidates', async () => {
  const candidates = Array.from({ length: 150 }, (_, index) => parseAddress(`8.8.8.8:${27015 + index}`));
  const discover = combinedDiscovery(config, rules, {
    web: async () => result([{ ...second, name: 'Christmas Web', map: 'de_xmas', discoverySources: ['regional'] }]),
    master: async () => result(candidates.map(row => ({ ...row, discoverySources: ['master:regional'] })))
  });
  let queries = 0;
  const monitor = new Monitor({ config, rules, discover, now: () => 1000000, log: { warn() {} },
    query: async row => { queries++; return { name: row.id === second.id ? 'Christmas Web' : 'Public', map: 'fy_snow' }; },
    store: { load: async () => null, save: async () => {} } });
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 129); assert.equal(monitor.snapshot().meta.discoveryPartial, true);
  assert.deepEqual(monitor.snapshot().servers.map(row => row.id), [second.id]);
  await monitor.run('live'); assert.equal(queries, 129);
  assert.deepEqual(monitor.snapshot().servers.map(row => row.id), [second.id]);
});
