import { GameDig } from 'gamedig';
import { usableServerIdentity } from '../domain/duplicates.js';
import { goldsrcIdentityProbe } from './goldsrc-identity.js';
export function gameQuery(config, query = GameDig.query.bind(GameDig), probe = goldsrcIdentityProbe, now = Date.now) {
  const identities = new Map();
  const identityTtl = Math.min(config.discoveryInterval, 600000);
  const retryTtl = Math.min(config.discoveryInterval, 300000);
  const remember = (key, id) => {
    if (!identities.has(key) && identities.size >= config.maxServers) identities.delete(identities.keys().next().value);
    identities.set(key, { id, at: now() });
  };
  return async server => {
    const result = await query({ type: 'counterstrike16', host: server.ip, port: server.port,
      givenPortOnly: true, maxAttempts: 1, socketTimeout: Math.max(250, config.queryTimeout - 250),
      attemptTimeout: config.queryTimeout, requestPlayers: false, requestRules: false });
    if (usableServerIdentity(result.raw?.steamid)) { identities.delete(server.id); return result; }
    const cached = identities.get(server.id);
    if (cached && now() - cached.at < (cached.id ? identityTtl : retryTtl))
      return cached.id ? { ...result, serverIdentity: cached.id } : result;
    let id = null;
    try { id = await probe(server, config.queryTimeout); } catch { /* Identity is optional. */ }
    if (!usableServerIdentity(id)) { remember(server.id, null); return result; }
    remember(server.id, id);
    return { ...result, serverIdentity: id };
  };
}
