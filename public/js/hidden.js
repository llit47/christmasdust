import { favoriteEndpoints } from './favorites.js';

export const hiddenKey = 'christmasdust.hidden.v1';
const limit = 5000;
const validEndpoint = value => {
  if (typeof value !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(value)) return false;
  const [ip, port] = value.split(':');
  return ip.split('.').every(part => +part <= 255) && +port >= 1 && +port <= 65535;
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
