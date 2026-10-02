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
const result = (servers, overrides = {}) => ({ servers, successfulRequests: 1, partial: false, disabled: false, attempted: true, ...overrides });
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

const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

function pacedDiscovery({ paginate = false, fail = false } = {}) {
  const clock = pacingClock(); const pace = createMasterSendPacer(clock); const sends = []; const sockets = [];
  const discover = masterDiscovery(config, rules, { ...clock, resolve, query: input => {
    const instance = socket(current => {
      sends.push({ at: clock.now(), filter: input.filter, region: input.region });
      if (fail === 'timeout') return;
      if (fail === 'error') return current.emit('error', Error('UDP failed'));
      reply(current, packet([first.id], !paginate || current.sent.length === 2));
    });
    sockets.push(instance);
    return queryMaster(input, () => instance, pace, clock);
  } });
  const run = async () => {
    const pending = discover(); await flush();
    for (let step = 0; step < 16; step++) { clock.advance(1500); await flush(); }
    return pending;
  };
  return { clock, pace, sends, sockets, run };
}

test('queued master requests have no reply timeout until they physically send', async () => {
  const clock = pacingClock(); const pace = createMasterSendPacer(clock);
  pace(() => {});
  const instance = socket(current => reply(current, packet([first.id])));
  let settled = false;
  const pending = queryMaster({ ...options, deadline: 22500 }, () => instance, pace, clock)
    .then(value => { settled = true; return value; });
  clock.advance(5999); await flush();
  assert.equal(settled, false); assert.equal(instance.sent.length, 0); assert.equal(instance.closed, 0);
  clock.advance(1); await flush();
  const found = await pending;
  assert.equal(found.partial, false); assert.equal(found.attempted, true); assert.equal(instance.sent.length, 1);
  assert.equal(clock.pending(), 0);
});

test('healthy bounded master sampling stays non-partial and rotates only actually sent filters', async () => {
  const fixture = pacedDiscovery();
  // Another discovery instance has just used the process-wide send slot.
  fixture.pace(() => {});
  const firstRun = await fixture.run();
  assert.equal(firstRun.partial, false); assert.equal(firstRun.successfulRequests, 3);
  assert.deepEqual(fixture.sends.map(send => send.at), [6000, 12000, 18000]);
  assert.equal(fixture.sockets.length, 4); assert.equal(fixture.clock.pending(), 0);
  const catalog = [...rules.maps.strong, ...rules.maps.probable];
  const secondRun = await fixture.run();
  assert.equal(secondRun.partial, false); assert.equal(secondRun.successfulRequests, 4);
  assert.deepEqual(new Set(fixture.sends.filter(send => send.region !== 255).map(send => send.region)), new Set([0, 1, 2, 3]));
  assert.deepEqual(new Set(fixture.sends.filter(send => send.region === 255).map(send => send.filter)),
    new Set(catalog.slice(0, 3).map(map => `${filter}\\map\\${map}`)));
  assert.ok(fixture.sends.slice(3).every(send => send.at <= 24000 + 22500));
  fixture.clock.advance(60000); await flush();
  assert.equal(fixture.sends.length, 7); assert.equal(fixture.clock.pending(), 0);
});

test('pagination shares the paced run budget and unsent pages do not mark discovery partial', async () => {
  const fixture = pacedDiscovery({ paginate: true });
  const found = await fixture.run();
  assert.equal(found.partial, false); assert.equal(found.successfulRequests, 4);
  assert.deepEqual(fixture.sends.map(send => send.at), [0, 6000, 12000, 18000]);
  assert.equal(new Set(fixture.sends.map(send => `${send.region}:${send.filter}`)).size, 2);
  assert.equal(fixture.sockets.length, 4);
  assert.equal(fixture.clock.pending(), 0);
  const next = await fixture.run(); assert.equal(next.partial, false);
  const nextRequests = fixture.sends.slice(4);
  assert.ok(nextRequests.some(send => send.region === 1 && send.filter === filter));
  assert.ok(nextRequests.some(send => send.region === 255 && send.filter === `${filter}\\map\\${[...rules.maps.strong][1]}`));
});

test('a delayed pacer never sends after the master run budget', async () => {
  const clock = pacingClock(); const pace = createMasterSendPacer(clock);
  pace(() => {});
  const instance = socket(() => assert.fail('expired send must be skipped'));
  const pending = queryMaster({ ...options, deadline: 22500 }, () => instance, pace, clock);
  clock.stall(22501); await flush();
  const found = await pending;
  assert.equal(found.partial, false); assert.equal(found.attempted, false);
  assert.equal(instance.sent.length, 0); assert.equal(instance.closed, 1); assert.equal(clock.pending(), 0);
});

test('normal sampling, including an entirely skipped budget, does not degrade the public snapshot', async () => {
  const clock = pacingClock(); const pace = createMasterSendPacer(clock);
  pace(() => {});
  let instances = 0;
  const master = masterDiscovery(config, rules, { ...clock, resolve, query: input => {
    instances++;
    return queryMaster(input, () => socket(current => reply(current, packet([]))), pace, clock);
  } });
  const discover = combinedDiscovery(config, rules, {
    master, web: async () => result([], { disabled: true, successfulRequests: 0 })
  });
  const monitor = new Monitor({ config, rules, discover, now: clock.now, log: { warn() {} },
    store: { load: async () => null, save: async () => {} } });
  await monitor.init();
  const pending = monitor.run('discovery'); await flush();
  clock.stall(22501); await flush(); await pending;
  assert.equal(instances, 2); assert.equal(clock.pending(), 0);
  assert.equal(monitor.snapshot().meta.discoveryPartial, false);
  assert.equal(monitor.snapshot().meta.degraded, false);
  const healthy = monitor.run('discovery'); await flush();
  for (let step = 0; step < 16; step++) { clock.advance(1500); await flush(); }
  await healthy;
  assert.equal(monitor.snapshot().meta.discoveryPartial, false);
  assert.equal(monitor.snapshot().meta.degraded, false);
});

test('actual master sends that time out or error still mark the run partial', async () => {
  for (const fail of ['timeout', 'error']) {
    const fixture = pacedDiscovery({ fail }); const found = await fixture.run();
    assert.equal(found.partial, true); assert.equal(found.successfulRequests, 0);
    assert.deepEqual(fixture.sends.map(send => send.at), [0, 6000, 12000, 18000]);
    assert.equal(fixture.clock.pending(), 0);
  }
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
  assert.deepEqual(found, { servers: [first, second], partial: false, successfulRequests: 2, attempted: true, cursor: '0.0.0.0:0' });
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

test('master discovery rotates the full catalog and regions with at most four filters and concurrency two', async () => {
  const requests = []; let active = 0; let peak = 0;
  const discover = masterDiscovery(config, rules, { resolve, query: async input => {
    requests.push(input); active++; peak = Math.max(peak, active);
    await new Promise(done => setImmediate(done)); active--;
    return result([]);
  } });
  const catalog = [...rules.maps.strong, ...rules.maps.probable];
  for (let run = 0; run < Math.ceil(catalog.length / 2); run++) {
    const before = requests.length; const found = await discover();
    assert.equal(found.partial, false); assert.equal(requests.length - before, 4);
    assert.ok(requests.slice(before).some(request => request.region !== 255));
    assert.ok(requests.slice(before).some(request => request.region === 255));
  }
  assert.deepEqual(new Set(requests.filter(request => request.region === 255).map(request => request.filter.split('\\map\\')[1])), new Set(catalog));
  assert.deepEqual(new Set(requests.filter(request => request.region !== 255).map(request => request.region)), new Set([0, 1, 2, 3, 4, 5, 6, 7]));
  assert.ok(requests.every(request => request.timeoutMs === 1500 && request.limit === 128));
  assert.equal(peak, 2);
});

test('master adapter caps total endpoints, strips metadata, preserves provenance and bounds DNS failure', async () => {
  const discover = masterDiscovery({ ...config, maxServers: 1 }, rules, { resolve,
    query: async () => result([{ ...first, name: 'Untrusted Xmas', map: 'de_christmas' }, second,
      { id: '127.0.0.1:27015' }, { id: 'bad' }]) });
  const found = await discover();
  assert.equal(found.servers.length, 1); assert.equal(found.partial, true);
  assert.equal(found.servers[0].candidateOnly, true); assert.equal(found.servers[0].name, undefined);
  assert.equal(found.servers[0].map, undefined);
  assert.equal(found.servers[0].discoverySources.length, 3);
  assert.ok(found.servers[0].discoverySources.includes('master:regional'));
  assert.ok(found.servers[0].discoverySources.some(source => source.startsWith('master:map:')));
  assert.deepEqual(found.coverage, { masterRegionalEndpoints: 2, masterMapEndpoints: 2 });
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
  const webRow = found.servers.find(row => row.id === first.id);
  const masterRow = found.servers.find(row => row.id === second.id);
  assert.equal(webRow.name, 'Christmas Web'); assert.equal(webRow.candidateOnly, false);
  assert.deepEqual(webRow.discoverySources, ['regional', 'web-api', 'master:regional', 'master-udp']);
  assert.equal(masterRow.name, undefined); assert.equal(masterRow.candidateOnly, true);
  assert.ok(masterRow.discoverySources.includes('master-udp'));
  assert.deepEqual(found.coverage, { steamEndpoints: 1, masterRegionalEndpoints: 1, masterMapEndpoints: 1 });
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
    ...(row.id === ids[0] ? { name: 'Winter Public', map: 'de_aztec_hivers', numplayers: 2 } : {}),
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
  assert.deepEqual(monitor.snapshot().meta.coverage.live, { queriedEndpoints: 8, queryFailures: 8, classificationNone: 0 });
  monitor.query = async row => { queried.push(row.id); return live(row); };
  await monitor.run('live');
  assert.equal(queried.length, 8); assert.ok(!queried.includes(excluded));
  const rows = monitor.snapshot().servers;
  assert.equal(rows.length, 2);
  assert.deepEqual(monitor.snapshot().meta.coverage.visibility, { monitoredEndpoints: 8, classificationNone: 1,
    capacityHidden: 1, manifestSuppressed: 3, nameMirrorSuppressed: 0, duplicateAliases: 1, publicServers: 2 });
  assert.equal(rows.find(row => row.id === first.id).classification.confidence, 'probable');
  assert.equal(rows.find(row => row.duplicateCount === 1).duplicateEndpoints.length, 1);
  assert.ok(rows.every(row => !ids.slice(1, 6).includes(row.id)));
  assert.equal(monitor.servers.size, 8); assert.equal(persisted.servers.length, 8);
  assert.ok(persisted.servers.every(row => row.discoverySources.includes('master-udp')));
  await monitor.run('discovery');
  assert.equal(monitor.snapshot().servers.length, 2);
  // A later Web-only discovery must retain the endpoint's earlier master provenance.
  monitor.discover = async () => result([{ ...first, name: 'Winter Public', map: 'de_aztec_hivers', discoverySources: ['web-api'] }]);
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

async function pendingFixture(ids = [first.id], { saved = null, time = 1000000 } = {}) {
  let candidates = ids; let persisted;
  const discover = combinedDiscovery(config, rules, {
    master: async () => result(candidates.map(id => ({ ...parseAddress(id), discoverySources: ['master:regional'] })))
  });
  const monitor = new Monitor({ config, rules, discover, now: () => time, log: { warn() {} },
    query: async () => { throw Error('live timeout'); },
    store: { load: async () => saved, save: async value => { persisted = value; } } });
  await monitor.init(); await monitor.run('discovery');
  return { monitor, persisted: () => persisted, rotate: ids => { candidates = ids; } };
}

test('never-verified master-only pending candidates expire after three consecutive live failures', async () => {
  const { monitor, persisted } = await pendingFixture();
  for (let failures = 1; failures <= 2; failures++) {
    await monitor.run('live');
    assert.equal(monitor.servers.get(first.id).misses, failures);
    assert.equal(monitor.servers.get(first.id).lastSeenAt, null);
  }
  // Rediscovery must not reset the consecutive failure count.
  await monitor.run('discovery'); await monitor.run('live');
  assert.equal(monitor.servers.size, 0); assert.equal(persisted().servers.length, 0);
  assert.equal(monitor.snapshot().meta.livePartial, true);
});

test('expired pending slots admit later rotated master candidates', async () => {
  const ids = Array.from({ length: 128 }, (_, index) => `8.8.8.8:${27015 + index}`);
  const { monitor, rotate } = await pendingFixture(ids);
  assert.equal(monitor.servers.size, 128);
  rotate([second.id]); await monitor.run('discovery');
  assert.equal(monitor.servers.has(second.id), false);
  for (let failures = 0; failures < 3; failures++) await monitor.run('live');
  assert.equal(monitor.servers.size, 0);
  await monitor.run('discovery');
  assert.equal(monitor.servers.size, 1); assert.equal(monitor.servers.has(second.id), true);
  assert.equal(monitor.servers.get(second.id).classification.confidence, 'none');
  assert.equal(monitor.servers.get(second.id).misses, 0);
});

test('a previously live-verified endpoint retains last-good data after failures, including across restore', async () => {
  const fixture = await pendingFixture([first.id], { time: 0 });
  const monitor = fixture.monitor;
  monitor.query = async () => ({ name: 'Christmas Verified', map: 'de_xmas', numplayers: 12, maxplayers: 32 });
  await monitor.run('live');
  assert.equal(monitor.servers.get(first.id).classification.confidence, 'high');
  // A complete theme change hides it after one observation, but it has been live-verified.
  monitor.query = async () => ({ name: 'Public', map: 'de_dust2', numplayers: 5, maxplayers: 32 });
  await monitor.run('live');
  assert.equal(monitor.servers.get(first.id).classification.confidence, 'none');
  const restored = await pendingFixture([first.id], { saved: fixture.persisted(), time: 0 });
  for (let failures = 0; failures < 4; failures++) await restored.monitor.run('live');
  const row = restored.monitor.servers.get(first.id);
  assert.ok(row); assert.equal(row.lastSeenAt, 0);
  assert.equal(row.status, 'offline'); assert.equal(row.misses, 4);
  assert.equal(row.name, 'Public'); assert.equal(row.map, 'de_dust2');
  assert.equal(row.players, 5); assert.equal(row.maxPlayers, 32);
  assert.equal(restored.persisted().servers.length, 1);
});

test('a successful non-seasonal pending response resets failures and follows existing theme retirement', async () => {
  const { monitor } = await pendingFixture();
  await monitor.run('live'); await monitor.run('live');
  monitor.query = async () => ({ name: 'Public', map: 'fy_snow', numplayers: 3, maxplayers: 32 });
  await monitor.run('live');
  assert.equal(monitor.servers.get(first.id).misses, 0);
  assert.equal(monitor.servers.get(first.id).lastSeenAt, 1000000);
  assert.equal(monitor.servers.get(first.id).themeMisses, 1);
  assert.equal(monitor.snapshot().servers.length, 0);
  await monitor.run('live');
  assert.equal(monitor.servers.has(first.id), false);
});

test('pending endpoints also seen by Web API keep normal failure retention', async () => {
  const { monitor } = await pendingFixture();
  monitor.add({ ...first, discoverySources: ['web-api', 'regional'] });
  for (let failures = 0; failures < 4; failures++) await monitor.run('live');
  assert.equal(monitor.servers.get(first.id).misses, 4);
  assert.equal(monitor.servers.get(first.id).lastSeenAt, null);
});

test('regional cursors progress across cycles independently of a large map catalog', async () => {
  const requests = [];
  const discover = masterDiscovery(config, rules, { resolve, query: async input => {
    requests.push(input);
    return result([first], { cursor: input.cursor === '0.0.0.0:0' ? first.id : second.id });
  } });
  for (let cycle = 0; cycle < 8; cycle++) {
    const before = requests.length;
    await discover();
    const current = requests.slice(before);
    assert.equal(current.length, 4);
    assert.equal(current.filter(request => request.region !== 255).length, 2);
    assert.equal(current.filter(request => request.region === 255).length, 2);
  }
  for (let region = 0; region < 8; region++) {
    assert.deepEqual(requests.filter(request => request.region === region).map(request => request.cursor),
      ['0.0.0.0:0', first.id]);
  }
});

test('regional cursors retry timeout/error visits, reset after repeated failure and wrap after completion', async () => {
  for (const failure of ['timeout', 'error']) {
    const requests = []; let failures = 0;
    const discover = masterDiscovery(config, { ...rules, maps: {} }, { resolve, query: async input => {
      requests.push(input);
      if (input.region === 0 && input.cursor === first.id && failures++ < 2) {
        if (failure === 'error') throw Error('UDP adapter failure');
        return result([], { partial: true, successfulRequests: 0, cursor: input.cursor });
      }
      return result([first], { cursor: input.cursor === '0.0.0.0:0' ? first.id : '0.0.0.0:0' });
    } });
    for (let cycle = 0; cycle < 8; cycle++) await discover();
    assert.deepEqual(requests.filter(request => request.region === 0).map(request => request.cursor),
      ['0.0.0.0:0', first.id, first.id, '0.0.0.0:0']);
    assert.deepEqual(requests.filter(request => request.region === 1).map(request => request.cursor),
      ['0.0.0.0:0', first.id, '0.0.0.0:0', first.id]);
  }
});

test('master page cap resumes from the last returned endpoint even on a terminal page', async () => {
  const third = parseAddress('9.9.9.9:27015');
  const all = [first, second, third]; let cursor = '0.0.0.0:0';
  const collected = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    const instance = socket((current, request) => {
      assert.equal(request.subarray(2).toString('ascii'), `${cursor}\0${filter}\0`);
      const start = cursor === '0.0.0.0:0' ? 0 : all.findIndex(row => row.id === cursor) + 1;
      reply(current, packet(all.slice(start).map(row => row.id)));
    });
    const found = await queryMaster({ ...options, limit: 1, cursor }, () => instance, unpaced);
    collected.push(...found.servers);
    cursor = found.cursor;
  }
  assert.deepEqual(collected, all);
  assert.equal(cursor, '0.0.0.0:0');
  assert.throws(() => queryMaster({ ...options, cursor: '8.8.8.8:27015\0\\map\\fake' }));
});

test('timed-out or budget-skipped pagination retains successfully consumed cursor progress', async () => {
  const clock = pacingClock(); const pace = createMasterSendPacer(clock);
  const instance = socket(current => { if (current.sent.length === 1) reply(current, packet([first.id], false)); });
  const pending = queryMaster({ ...options, timeoutMs: 1500, deadline: 22500 }, () => instance, pace, clock);
  await flush(); clock.advance(7500); await flush();
  const failed = await pending;
  assert.equal(failed.partial, true); assert.equal(failed.cursor, first.id);
  const skippedSocket = socket(current => reply(current, packet([second.id], false)));
  const skipped = queryMaster({ ...options, cursor: first.id, timeoutMs: 1500, deadline: clock.now() + 4000 },
    () => skippedSocket, pace, clock);
  clock.advance(6000); await flush();
  const skippedResult = await skipped;
  assert.equal(skippedResult.attempted, false);
  assert.equal(skippedResult.cursor, first.id);
  assert.equal(skippedSocket.sent.length, 0);
});

test('targeted Web candidates share the bounded pending pool, reach live queries and expire after failures', async () => {
  const ids = Array.from({ length: 150 }, (_, index) => `8.8.8.8:${28000 + index}`);
  const discover = combinedDiscovery(config, rules, {
    web: async () => result(ids.map(id => ({ ...parseAddress(id), name: 'Winter Public', map: 'de_dust2',
      discoverySources: ['name:winter'] }))),
    master: async () => result([{ ...second, discoverySources: ['master:regional'] }])
  });
  const monitor = new Monitor({ config, rules, discover, now: () => 1000000, log: { warn() {} },
    query: async row => ({ name: 'Winter Public', map: row.id === ids[0] ? 'de_dust2_winter' : 'de_dust2', maxplayers: 32 }),
    store: { load: async () => null, save: async () => {} } });
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 128);
  assert.equal(monitor.servers.has(second.id), false); // Targeted samples receive admission before broad samples.
  assert.equal(monitor.snapshot().servers.length, 0);
  await monitor.run('live');
  assert.deepEqual(monitor.snapshot().servers.map(row => row.id), [ids[0]]);
  assert.equal(monitor.snapshot().servers[0].classification.confidence, 'probable');
  assert.deepEqual(monitor.snapshot().meta.coverage.live, { queriedEndpoints: 128, queryFailures: 0, classificationNone: 127 });
  // Complete non-matches retire on the second observation; never-queried good data isn't exposed.
  await monitor.run('live'); assert.equal(monitor.servers.size, 1);
  await monitor.run('discovery');
  monitor.query = async () => { throw Error('timeout'); };
  for (let failure = 0; failure < 3; failure++) await monitor.run('live');
  assert.equal(monitor.servers.size, 1); // Only the previously verified row retains last-good metadata.
});

test('non-progressing master pages reset the cursor instead of trapping the region', async () => {
  const instance = socket(current => reply(current, packet([first.id], false)));
  const found = await queryMaster({ ...options, cursor: first.id }, () => instance, unpaced);
  assert.equal(found.cursor, '0.0.0.0:0');
  assert.equal(found.partial, true);
  assert.equal(instance.sent.length, 1);
});

test('large regional samples share pending admission instead of always favoring the first region', async () => {
  const master = masterDiscovery(config, { ...rules, maps: {} }, { resolve, query: async input => result(
    Array.from({ length: 128 }, (_, index) => parseAddress(`8.8.8.${input.region + 1}:${28000 + index}`)),
    { cursor: `8.8.8.${input.region + 1}:28127` }
  ) });
  const discover = combinedDiscovery(config, rules, { master,
    web: async () => result([], { disabled: true, successfulRequests: 0 }) });
  const monitor = new Monitor({ config, rules, discover, now: () => 1000000, log: { warn() {} },
    store: { load: async () => null, save: async () => {} } });
  await monitor.init(); await monitor.run('discovery');
  assert.equal(monitor.servers.size, 128);
  for (let region = 0; region < 4; region++)
    assert.equal([...monitor.servers.values()].filter(row => row.ip === `8.8.8.${region + 1}`).length, 32);
  assert.equal(monitor.snapshot().meta.coverage.discovery.masterRegionalEndpoints, 512);
  assert.equal(monitor.snapshot().meta.coverage.discovery.candidatesDropped, 384);
});

for (const failedSource of ['web', 'master']) {
  test(`${failedSource} coverage survives adapter failures while the other source updates, then recovers to a real zero`, async () => {
    for (const failure of ['throw', 'reject', 'unavailable']) {
      let failing = false, recovering = false, emptyHealthy = false, latest;
      const fail = () => {
        if (failure === 'throw') throw Error('adapter threw');
        if (failure === 'reject') return Promise.reject(Error('adapter rejected'));
        return result([], { partial: true, successfulRequests: 0 });
      };
      const web = () => {
        if (failing && failedSource === 'web') return fail();
        return result(recovering || emptyHealthy ? [] : [first, ...(failing ? [second] : [])]);
      };
      const master = () => {
        if (failing && failedSource === 'master') return fail();
        return result(recovering || emptyHealthy ? [] : [
          { ...first, discoverySources: ['master:regional', 'master:map:de_christmas'] },
          ...(failing ? [{ ...second, discoverySources: ['master:regional', 'master:map:de_christmas'] }] : [])
        ]);
      };
      const combined = combinedDiscovery(config, rules, { web, master });
      const monitor = new Monitor({ config, rules, discover: async () => { latest = await combined(); return latest; },
        now: () => 1000000, log: { warn() {} }, store: { load: async () => null, save: async () => {} } });
      const counts = () => {
        const { steamEndpoints, masterRegionalEndpoints, masterMapEndpoints } = monitor.snapshot().meta.coverage.discovery;
        return { steamEndpoints, masterRegionalEndpoints, masterMapEndpoints };
      };
      await monitor.init(); await monitor.run('discovery');
      assert.deepEqual(counts(), { steamEndpoints: 1, masterRegionalEndpoints: 1, masterMapEndpoints: 1 });
      assert.equal(monitor.snapshot().meta.discoveryPartial, false);

      failing = true; await monitor.run('discovery');
      assert.equal(monitor.snapshot().meta.discoveryPartial, true);
      if (failedSource === 'web') {
        assert.deepEqual(latest.coverage, { masterRegionalEndpoints: 2, masterMapEndpoints: 2 });
        assert.deepEqual(counts(), { steamEndpoints: 1, masterRegionalEndpoints: 2, masterMapEndpoints: 2 });
      } else {
        assert.deepEqual(latest.coverage, { steamEndpoints: 2 });
        assert.deepEqual(counts(), { steamEndpoints: 2, masterRegionalEndpoints: 1, masterMapEndpoints: 1 });
      }

      emptyHealthy = true; await monitor.run('discovery');
      assert.equal(monitor.snapshot().meta.discoveryPartial, true);
      assert.deepEqual(counts(), failedSource === 'web' ?
        { steamEndpoints: 1, masterRegionalEndpoints: 0, masterMapEndpoints: 0 } :
        { steamEndpoints: 0, masterRegionalEndpoints: 1, masterMapEndpoints: 1 });

      failing = false; recovering = true; await monitor.run('discovery');
      assert.deepEqual(counts(), { steamEndpoints: 0, masterRegionalEndpoints: 0, masterMapEndpoints: 0 });
      assert.equal(monitor.snapshot().meta.discoveryPartial, false);
    }
  });
}
