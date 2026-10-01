import { steamDiscovery } from './discovery.js';
import { masterDiscovery } from './master-discovery.js';
import { parseAddress } from '../utils/address.js';

export function combinedDiscovery(config, rules, {
  web = steamDiscovery(config, rules), master = masterDiscovery(config, rules)
} = {}) {
  return async () => {
    const results = await Promise.allSettled([Promise.resolve().then(web), Promise.resolve().then(master)]);
    const servers = new Map(); let successfulRequests = 0; let partial = false; let disabled = true;
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') { partial = true; disabled = false; continue; }
      const source = result.value;
      partial ||= source.partial; disabled &&= source.disabled; successfulRequests += source.successfulRequests;
      for (const raw of source.servers) {
        let address;
        try { address = parseAddress(raw.id); } catch { continue; }
        const previous = servers.get(address.id);
        // Master data is endpoints/provenance only, never public metadata or theme evidence.
        const row = index === 0 ? { ...raw, ...address, candidateOnly: false } : { ...address, candidateOnly: true };
        servers.set(address.id, { ...row, ...previous,
          discoverySources: [...new Set([...(previous?.discoverySources || []), ...(raw.discoverySources || []),
            index === 0 ? 'web-api' : 'master-udp'])] });
      }
    }
    return { servers: [...servers.values()], partial, successfulRequests, disabled };
  };
}
