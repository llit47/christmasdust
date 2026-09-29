import { mapLimit } from '../utils/concurrency.js';
import { parseAddress } from '../utils/address.js';
import { metadata, cleanText } from '../domain/server.js';
// name_match supports wildcards. Restrict configured terms to literal ASCII words
// so they cannot add filter operators or broaden a request with their own '*'.
export function targetedTerms(rules) {
  return [...new Set([...rules.strong, ...rules.weak]
    .map(term => term.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim())
    .filter(term => /^[a-z0-9]{4,32}$/.test(term)))].slice(0, 8);
}
// Public Steam Web API. Fixed origin; neither callers nor server metadata choose URLs.
export function steamDiscovery(config, rules, fetcher = fetch) {
  return async () => {
    if (config.discoveryMode === 'seeds' || !config.steamKey) return { servers: [], disabled: true, partial: false, successfulRequests: 0 };
    const requests = [
      ...Array.from({ length: 8 }, (_, region) => `\\appid\\10\\gamedir\\cstrike\\region\\${region}`),
      ...targetedTerms(rules).map(term => `\\appid\\10\\gamedir\\cstrike\\name_match\\*${term}*`)
    ];
    const results = await mapLimit(requests, 2, async filter => {
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
          servers.push({ ...metadata(raw), ...parseAddress(raw.addr),
            ...(typeof raw.gametype === 'string' ? { tags: cleanText(raw.gametype) } : {}) });
        } catch { /* reject non-public/invalid endpoints */ }
      }
      return { servers, truncated: rows.length >= config.discoveryLimit };
    });
    const good = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const merged = new Map();
    for (const row of good.flatMap(result => result.servers)) merged.set(row.id, { ...merged.get(row.id), ...row });
    return { servers: [...merged.values()], partial: good.length !== results.length || good.some(r => r.truncated), successfulRequests: good.length, disabled: false };
  };
}
