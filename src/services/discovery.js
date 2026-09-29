import { mapLimit } from '../utils/concurrency.js';
import { parseAddress, deduplicate } from '../utils/address.js';
import { metadata, cleanText } from '../domain/server.js';
// Public Steam Web API. Fixed origin; neither callers nor server metadata choose URLs.
export function steamDiscovery(config, fetcher = fetch) {
  return async () => {
    if (config.discoveryMode === 'seeds' || !config.steamKey) return { servers: [], disabled: true, partial: false, successfulRequests: 0 };
    const results = await mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 2, async region => {
      const url = new URL('https://api.steampowered.com/IGameServersService/GetServerList/v1/');
      url.search = new URLSearchParams({ key: config.steamKey, filter: `\\appid\\10\\gamedir\\cstrike\\region\\${region}`, limit: String(config.discoveryLimit) });
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
        try { servers.push({ ...metadata(raw), ...parseAddress(raw.addr), tags: cleanText(raw.gametype) }); } catch { /* reject non-public/invalid endpoints */ }
      }
      return { servers, truncated: rows.length >= config.discoveryLimit };
    });
    const good = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    return { servers: deduplicate(good.flatMap(r => r.servers)), partial: good.length !== results.length || good.some(r => r.truncated), successfulRequests: good.length, disabled: false };
  };
}
