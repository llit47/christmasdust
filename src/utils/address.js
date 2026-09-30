import { isIP } from 'node:net';
export function parseAddress(value) {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(value)) throw new Error('Expected public IPv4:port');
  const [ip, raw] = value.split(':');
  const port = Number(raw);
  const [a, b, c] = ip.split('.').map(Number);
  if (isIP(ip) !== 4 || port < 1 || port > 65535 || a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) throw new Error('Address must be public IPv4 with a valid port');
  return { id: `${ip}:${port}`, ip, port };
}
export function deduplicate(items) { return [...new Map(items.map(item => [item.id, item])).values()]; }
