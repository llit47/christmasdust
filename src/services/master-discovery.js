import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { mapLimit } from '../utils/concurrency.js';
import { parseAddress } from '../utils/address.js';

const HOST = 'hl2master.steampowered.com';
const PORT = 27011;
const FILTER = '\\appid\\10\\gamedir\\cstrike';
const RUN_BUDGET_MS = 22500;
const SEND_INTERVAL_MS = 6000;
const HEADER = Buffer.from([255, 255, 255, 255, 0x66, 0x0a]);

export function createMasterSendPacer({ now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const queue = []; let lastSendAt = -Infinity; let timer; let pumping = false;
  const pump = () => {
    if (pumping) return;
    pumping = true;
    clearTimer(timer); timer = undefined;
    try {
      while (queue.length) {
        const delay = Math.max(0, SEND_INTERVAL_MS - (now() - lastSendAt));
        const next = queue[0];
        if (now() + delay > next.latestSendAt) { queue.shift(); next.skip(); continue; }
        if (delay) { timer = setTimer(pump, delay); return; }
        lastSendAt = now(); queue.shift().send();
      }
    } finally { pumping = false; }
  };
  return (send, { latestSendAt = Infinity, skip = () => {} } = {}) => {
    const entry = { send, latestSendAt, skip };
    queue.push(entry); pump();
    return () => {
      const index = queue.indexOf(entry);
      if (index >= 0) { queue.splice(index, 1); pump(); }
    };
  };
}
// Shared by every filter, page, socket and discovery instance in this process.
const paceMasterSend = createMasterSendPacer();

// Six-byte IPv4/network-order port entries; the all-zero entry terminates the list.
export function parseMasterResponse(packet) {
  if (!Buffer.isBuffer(packet) || packet.length < 12 || packet.length > 8196 ||
    !packet.subarray(0, 6).equals(HEADER) || (packet.length - 6) % 6) return null;
  const servers = []; let cursor = null; let done = false;
  for (let offset = 6; offset < packet.length; offset += 6) {
    const ip = [...packet.subarray(offset, offset + 4)].join('.');
    const port = packet.readUInt16BE(offset + 4);
    if (ip === '0.0.0.0' && port === 0) {
      if (offset !== packet.length - 6) return null;
      done = true; break;
    }
    cursor = `${ip}:${port}`;
    try { servers.push(parseAddress(cursor)); } catch { /* Reject unsafe endpoints, including FakeIP. */ }
  }
  return { servers, cursor, done };
}

// Reply timers start at the physical send; queued pages share the discovery deadline.
export function queryMaster({ ip, region, filter, limit, timeoutMs, deadline = Infinity }, socketFactory = createSocket, pace = paceMasterSend,
  { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  parseAddress(`${ip}:${PORT}`);
  if (!Number.isInteger(region) || ![0, 1, 2, 3, 4, 5, 6, 7, 255].includes(region) ||
    !/^\\appid\\10\\gamedir\\cstrike(?:\\map\\[a-z0-9_]{3,32})?$/.test(filter)) throw Error('Invalid master filter');
  const cap = Math.max(1, Math.min(limit, 128));
  return new Promise(resolve => {
    const socket = socketFactory('udp4'); const servers = new Map();
    let settled = false; let pages = 0; let attempted = false; let timer; let seed = '0.0.0.0:0'; let cancelSend; let awaitingReply = false;
    const finish = partial => {
      if (settled) return;
      settled = true; clearTimer(timer); cancelSend?.();
      try { socket.close(); } catch { /* A failed socket may already be closed. */ }
      resolve({ servers: [...servers.values()], partial, successfulRequests: pages, attempted });
    };
    const send = () => {
      const packet = Buffer.concat([Buffer.from([0x31, region]), Buffer.from(`${seed}\0${filter}\0`, 'ascii')]);
      cancelSend = pace(() => {
        if (settled) return;
        attempted = true; awaitingReply = true;
        timer = setTimer(() => finish(true), Math.max(1, Math.min(timeoutMs, 1500)));
        try { socket.send(packet, PORT, ip, error => { if (error) finish(true); }); }
        catch { finish(true); }
      }, { latestSendAt: deadline - Math.max(1, Math.min(timeoutMs, 1500)), skip: () => finish(false) });
    };
    socket.on('error', () => finish(true));
    socket.on('message', (packet, source) => {
      if (settled || !awaitingReply || source.address !== ip || source.port !== PORT) return;
      const parsed = parseMasterResponse(packet);
      if (!parsed) return;
      awaitingReply = false; clearTimer(timer);
      pages++;
      let capped = false;
      for (const server of parsed.servers) {
        if (servers.has(server.id)) continue;
        if (servers.size >= cap) { capped = true; break; }
        servers.set(server.id, server);
      }
      if (parsed.done) return finish(capped);
      if (capped || servers.size >= cap || pages >= 2 || !parsed.cursor || parsed.cursor === seed) return finish(true);
      seed = parsed.cursor; send();
    });
    send();
  });
}

export function masterDiscovery(config, rules, { resolve = lookup, query = queryMaster,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let requestCursor = 0;
  return async () => {
    if (config.discoveryMode === 'seeds') return { servers: [], disabled: true, partial: false, successfulRequests: 0 };
    const deadline = now() + RUN_BUDGET_MS;
    const timeoutMs = Math.min(config.discoveryTimeout, 1500);
    let timer; let ip;
    try {
      const address = await Promise.race([resolve(HOST, { family: 4 }),
        new Promise((_, reject) => { timer = setTimer(() => reject(Error('Master DNS timeout')), timeoutMs); })]);
      ip = parseAddress(`${address.address}:${PORT}`).ip;
    } catch { return { servers: [], disabled: false, partial: true, successfulRequests: 0 }; }
    finally { clearTimer(timer); }
    const catalog = [...(rules.maps?.strong || []), ...(rules.maps?.probable || [])]
      .filter(map => /^[a-z0-9_]{3,32}$/.test(map));
    const requests = [
      ...catalog.map(map => ({ region: 255, filter: `${FILTER}\\map\\${map}`, source: `master:map:${map}` })),
      ...Array.from({ length: 8 }, (_, region) => ({ region, filter: FILTER, source: 'master:regional' }))
    ];
    // At most four first-page candidates, rather than queuing the full filter plan.
    // Pagination competes for these same globally paced send slots.
    const count = Math.max(0, Math.min(4, Math.floor((deadline - now() - timeoutMs) / SEND_INTERVAL_MS) + 1));
    const ordered = Array.from({ length: Math.min(count, requests.length) },
      (_, index) => requests[(requestCursor + index) % requests.length]);
    const results = await mapLimit(ordered, 2, async ({ region, filter, source }) => {
      if (now() + timeoutMs > deadline) return { servers: [], partial: false, successfulRequests: 0, attempted: false, source };
      const result = await query({ ip, region, filter, limit: Math.min(128, config.discoveryLimit), timeoutMs, deadline });
      return { ...result, source };
    });
    requestCursor = (requestCursor + results.filter(result =>
      result.status === 'fulfilled' && result.value.attempted).length) % requests.length;
    const servers = new Map(); const cap = Math.min(config.discoveryLimit, config.maxServers, 1000);
    let partial = results.some(result => result.status === 'rejected'); let successfulRequests = 0;
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      partial ||= result.value.partial; successfulRequests += result.value.successfulRequests;
      for (const raw of result.value.servers) {
        let address;
        try { address = parseAddress(raw.id); } catch { continue; }
        const previous = servers.get(address.id);
        if (!previous && servers.size >= cap) { partial = true; continue; }
        servers.set(address.id, { ...address, candidateOnly: true,
          discoverySources: [...new Set([...(previous?.discoverySources || []), result.value.source])] });
      }
    }
    return { servers: [...servers.values()], partial, successfulRequests, disabled: false,
      samplingSkipped: !partial && !results.some(result => result.status === 'fulfilled' && result.value.attempted) };
  };
}
