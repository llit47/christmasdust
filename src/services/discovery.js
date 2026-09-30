import { mapLimit } from '../utils/concurrency.js';
import { parseAddress } from '../utils/address.js';
import { metadata, cleanText } from '../domain/server.js';
// Restrict upstream filter operands to simple ASCII words/map IDs. They are
// configuration-derived, never taken from a public request or server response.
export function targetedTerms(rules, limit = 8) {
  const terms = [...new Set([...(rules.strong || []), ...(rules.related || [])]
    .map(term => term.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim())
    .filter(term => /^[a-z0-9]{4,32}$/.test(term)))];
  return terms.filter((term, index) => !terms.slice(0, index).some(previous => term.startsWith(previous))).slice(0, limit);
}
// Public Steam Web API. Fixed origin; neither callers nor server metadata choose URLs.
export function steamDiscovery(config, rules, fetcher = fetch) {
  return async () => {
    if (config.discoveryMode === 'seeds' || !config.steamKey) return { servers: [], disabled: true, partial: false, successfulRequests: 0 };
    const maps = [...(rules.maps?.strong || []), ...(rules.maps?.probable || [])]
      .filter(map => /^[a-z0-9_]{3,32}$/.test(map)).slice(0, 5);
    const requests = [
      ...Array.from({ length: 8 }, (_, region) => ({ filter: `\\appid\\10\\gamedir\\cstrike\\region\\${region}`, source: 'regional' })),
      ...maps.map(map => ({ filter: `\\appid\\10\\gamedir\\cstrike\\map\\${map}`, source: `map:${map}` })),
      ...targetedTerms(rules, 10 - maps.length).map(term => ({ filter: `\\appid\\10\\gamedir\\cstrike\\name_match\\*${term}*`, source: `name:${term}` }))
    ];
    const results = await mapLimit(requests, 2, async ({ filter, source }) => {
      const url = new URL('https://api.steampowered.com/IGameServersService/GetServerList/v1/');
      url.search = new URLSearchParams({ key: config.steamKey, filter, limit: String(config.discoveryLimit) });
      const response = await fetcher(url, { signal: AbortSignal.timeout(config.discoveryTimeout), redirect: 'error' });
      if (!response.ok) throw new Error('Steam request failed');
      // Bound the decoded body, including responses without Content-Length.
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 16000000) throw new Error('Steam response too large');
        chunks.push(Buffer.from(chunk));
      }
      const rows = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.response?.servers;
      if (!Array.isArray(rows)) throw new Error('Invalid Steam response');
      const servers = [];
      for (const raw of rows.slice(0, config.discoveryLimit)) {
        if (Number(raw.appid) !== 10 || (raw.gamedir && raw.gamedir !== 'cstrike')) continue;
        try {
          servers.push({ ...metadata(raw), ...parseAddress(raw.addr), discoverySources: [source],
            ...(typeof raw.gametype === 'string' ? { tags: cleanText(raw.gametype) } : {}),
            ...(typeof raw.description === 'string' ? { description: cleanText(raw.description) } : {}) });
        } catch { /* reject non-public/invalid endpoints */ }
      }
      return { servers, truncated: rows.length >= config.discoveryLimit };
    });
    const good = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const merged = new Map();
    for (const row of good.flatMap(result => result.servers)) {
      const previous = merged.get(row.id);
      merged.set(row.id, { ...previous, ...row,
        discoverySources: [...new Set([...(previous?.discoverySources || []), ...row.discoverySources])] });
    }
    return { servers: [...merged.values()], partial: good.length !== results.length || good.some(r => r.truncated), successfulRequests: good.length, disabled: false };
  };
}
