import { steamDiscovery } from './discovery.js';
import { masterDiscovery } from './master-discovery.js';
import { parseAddress } from '../utils/address.js';

export function combinedDiscovery(config, rules, {
  web = steamDiscovery(config, rules), master = masterDiscovery(config, rules)
} = {}) {
  return async () => {
    const results = await Promise.allSettled([Promise.resolve().then(web), Promise.resolve().then(master)]);
    const servers = new Map(); let successfulRequests = 0; let partial = false; let disabled = true; let samplingSkipped = false;
    const coverage = { steamEndpoints: 0, masterRegionalEndpoints: 0, masterMapEndpoints: 0 };
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') { partial = true; disabled = false; continue; }
      const source = result.value;
      samplingSkipped ||= source.samplingSkipped === true;
      partial ||= source.partial; disabled &&= source.disabled; successfulRequests += source.successfulRequests;
      const returned = new Set(); const regional = new Set(); const maps = new Set();
      for (const raw of source.servers) {
        let address;
        try { address = parseAddress(raw.id); } catch { continue; }
        returned.add(address.id);
        if (raw.discoverySources?.includes('master:regional')) regional.add(address.id);
        if (raw.discoverySources?.some(value => value.startsWith('master:map:'))) maps.add(address.id);
        const previous = servers.get(address.id);
        // Master data is endpoints/provenance only, never public metadata or theme evidence.
        const row = index === 0 ? { ...raw, ...address, candidateOnly: raw.discoverySources?.some(value =>
          value.startsWith('name:') || value.startsWith('map:')) === true } : { ...address, candidateOnly: true };
        servers.set(address.id, { ...row, ...previous,
          discoverySources: [...new Set([...(previous?.discoverySources || []), ...(raw.discoverySources || []),
            index === 0 ? 'web-api' : 'master-udp'])] });
      }
      if (index === 0) coverage.steamEndpoints = returned.size;
      else {
        coverage.masterRegionalEndpoints = source.coverage?.masterRegionalEndpoints ?? regional.size;
        coverage.masterMapEndpoints = source.coverage?.masterMapEndpoints ?? maps.size;
      }
    }
    // Give targeted samples first admission to the bounded pending pool, ahead of
    // anonymous regional samples; all sources still pass the unchanged classifier.
    const targeted = row => row.discoverySources.some(value => value.startsWith('name:') ||
      value.startsWith('map:') || value.startsWith('master:map:'));
    return { servers: [...servers.values()].sort((a, b) => Number(targeted(b)) - Number(targeted(a))),
      partial, successfulRequests, disabled, samplingSkipped, coverage };
  };
}
