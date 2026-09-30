import { favoriteEndpoints } from './favorites.js';

export const hiddenKey = 'christmasdust.hidden.v1';
const limit = 5000;
const validEndpoint = value => {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(value)) return false;
  const [ip, port] = value.split(':');
  const parts = ip.split('.');
  if (parts.some(part => +part > 255 || (part.length > 1 && part.startsWith('0'))) || +port < 1 || +port > 65535) return false;
  const [a, b, c] = parts.map(Number);
  // Keep these public IPv4 exclusions aligned with src/utils/address.js.
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
};

export function readHidden(storage) {
  try {
    const text = storage.getItem(hiddenKey);
    if (!text || text.length > 150000) return new Set();
    const value = JSON.parse(text);
    return new Set(Array.isArray(value) ? value.slice(0, limit).filter(validEndpoint) : []);
  } catch { return new Set(); }
}

export function writeHidden(storage, ids) {
  try {
    if (ids.size > limit || [...ids].some(id => !validEndpoint(id))) return false;
    storage.setItem(hiddenKey, JSON.stringify([...ids])); return true;
  }
  catch { return false; }
}

export function isHidden(server, ids) {
  return favoriteEndpoints(server).some(id => ids.has(id));
}

export function hideServer(server, ids) {
  const endpoints = favoriteEndpoints(server).filter(validEndpoint);
  if (new Set([...ids, ...endpoints]).size > limit) return false;
  for (const id of endpoints) ids.add(id);
  return true;
}

export function restoreServer(server, ids) {
  for (const id of favoriteEndpoints(server)) ids.delete(id);
}

export function hiddenEntries(servers, ids) {
  const found = servers.filter(server => isHidden(server, ids));
  const represented = new Set(found.flatMap(favoriteEndpoints));
  return [...found.map(server => ({ server, id: server.id })),
    ...[...ids].filter(id => !represented.has(id)).map(id => ({ id }))];
}
