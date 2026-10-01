import { createSocket } from 'node:dgram';
import { lookup } from 'node:dns/promises';
import { mapLimit } from '../utils/concurrency.js';
import { parseAddress } from '../utils/address.js';

const HOST = 'hl2master.steampowered.com';
const PORT = 27011;
const FILTER = '\\appid\\10\\gamedir\\cstrike';
const HEADER = Buffer.from([255, 255, 255, 255, 0x66, 0x0a]);

export function createMasterSendPacer({ now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const queue = []; let lastSendAt = -Infinity; let timer;
  const pump = () => {
    clearTimer(timer); timer = undefined;
    if (!queue.length) return;
    const delay = Math.max(0, 6000 - (now() - lastSendAt));
    if (delay) { timer = setTimer(pump, delay); return; }
    lastSendAt = now(); queue.shift()(); pump();
  };
  return send => {
    queue.push(send); pump();
    return () => {
      const index = queue.indexOf(send);
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

// One socket for both pages. Deadline covers the entire filter, never resets per page.
export function queryMaster({ ip, region, filter, limit, timeoutMs }, socketFactory = createSocket, pace = paceMasterSend) {
  parseAddress(`${ip}:${PORT}`);
  if (!Number.isInteger(region) || ![0, 1, 2, 3, 4, 5, 6, 7, 255].includes(region) ||
    !/^\\appid\\10\\gamedir\\cstrike(?:\\map\\[a-z0-9_]{3,32})?$/.test(filter)) throw Error('Invalid master filter');
  const cap = Math.max(1, Math.min(limit, 128));
  return new Promise(resolve => {
    const socket = socketFactory('udp4'); const servers = new Map();
    let settled = false; let pages = 0; let seed = '0.0.0.0:0'; let cancelSend; let awaitingReply = false;
    const finish = partial => {
      if (settled) return;
      settled = true; clearTimeout(timer); cancelSend?.();
      try { socket.close(); } catch { /* A failed socket may already be closed. */ }
      resolve({ servers: [...servers.values()], partial, successfulRequests: pages });
    };
    const send = () => {
      const packet = Buffer.concat([Buffer.from([0x31, region]), Buffer.from(`${seed}\0${filter}\0`, 'ascii')]);
      cancelSend = pace(() => {
        if (settled) return;
        awaitingReply = true;
        try { socket.send(packet, PORT, ip, error => { if (error) finish(true); }); }
        catch { finish(true); }
      });
    };
    const timer = setTimeout(() => finish(true), Math.max(1, Math.min(timeoutMs, 1500)));
    socket.on('error', () => finish(true));
    socket.on('message', (packet, source) => {
      if (settled || !awaitingReply || source.address !== ip || source.port !== PORT) return;
      const parsed = parseMasterResponse(packet);
      if (!parsed) return;
      awaitingReply = false;
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

export function masterDiscovery(config, rules, { resolve = lookup, query = queryMaster } = {}) {
  let mapCursor = 0; let requestCursor = 0;
  return async () => {
    if (config.discoveryMode === 'seeds') return { servers: [], disabled: true, partial: false, successfulRequests: 0 };
    const timeoutMs = Math.min(config.discoveryTimeout, 1500);
    let timer; let ip;
    try {
      const address = await Promise.race([resolve(HOST, { family: 4 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Master DNS timeout')), timeoutMs); })]);
      ip = parseAddress(`${address.address}:${PORT}`).ip;
    } catch { return { servers: [], disabled: false, partial: true, successfulRequests: 0 }; }
    finally { clearTimeout(timer); }
    const catalog = [...(rules.maps?.strong || []), ...(rules.maps?.probable || [])]
      .filter(map => /^[a-z0-9_]{3,32}$/.test(map));
    const maps = Array.from({ length: Math.min(20, catalog.length) }, (_, index) => catalog[(mapCursor + index) % catalog.length]);
    mapCursor = catalog.length ? (mapCursor + maps.length) % catalog.length : 0;
    // Rotate the first filter too: pacing deadlines must not starve trailing regions/maps.
    const requests = [
      ...maps.map(map => ({ region: 255, filter: `${FILTER}\\map\\${map}`, source: `master:map:${map}` })),
      ...Array.from({ length: 8 }, (_, region) => ({ region, filter: FILTER, source: 'master:regional' }))
    ];
    const ordered = [...requests.slice(requestCursor), ...requests.slice(0, requestCursor)];
    requestCursor = (requestCursor + 1) % requests.length;
    const results = await mapLimit(ordered, 2, async ({ region, filter, source }) => {
      const result = await query({ ip, region, filter, limit: Math.min(128, config.discoveryLimit), timeoutMs });
      return { ...result, source };
    });
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
    return { servers: [...servers.values()], partial, successfulRequests, disabled: false };
  };
}
