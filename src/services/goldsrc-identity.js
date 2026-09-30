import { createSocket } from 'node:dgram';
import { parseAddress } from '../utils/address.js';
import { usableServerIdentity } from '../domain/duplicates.js';

const request = Buffer.from('\xff\xff\xff\xffgetchallenge steam\n', 'latin1');

// ReHLDS sends: FFFFFFFF A00000000 <challenge> 3 <steamid> <secure>\n\0.
export function parseGoldsrcIdentityResponse(packet) {
  if (!Buffer.isBuffer(packet) || packet.length > 256 || packet.length < 15 ||
    !packet.subarray(0, 4).equals(Buffer.from([255, 255, 255, 255]))) return null;
  const match = /^A00000000 \d{1,10} 3 ([1-9]\d{14,19}) [01]\n?\0?$/.exec(packet.subarray(4).toString('latin1'));
  return match && usableServerIdentity(match[1]) ? match[1] : null;
}

export function goldsrcIdentityProbe(server, timeoutMs, socketFactory = createSocket) {
  const { ip, port } = parseAddress(`${server.ip}:${server.port}`);
  const timeout = Math.max(250, Math.min(timeoutMs, 1500));
  return new Promise(resolve => {
    const socket = socketFactory('udp4');
    let settled = false;
    const finish = identity => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* A failed send may already have closed it. */ }
      resolve(identity);
    };
    socket.on('message', (packet, source) => {
      if (source.address !== ip || source.port !== port) return;
      const identity = parseGoldsrcIdentityResponse(packet);
      if (identity) finish(identity);
    });
    socket.on('error', () => finish(null));
    const timer = setTimeout(() => finish(null), timeout);
    try { socket.send(request, port, ip, error => { if (error) finish(null); }); }
    catch { finish(null); }
  });
}
