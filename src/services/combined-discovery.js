import { steamDiscovery } from './discovery.js';
import { parseAddress } from '../utils/address.js';

// Keep the adapter boundary for endpoint validation, provenance and coverage.
// Legacy Master UDP is isolated from runtime discovery, including auto mode.
export function combinedDiscovery(config, rules, { web = steamDiscovery(config, rules) } = {}) {
  return async () => {
    let source;
    try { source = await web(); }
    catch { return { servers: [], partial: true, successfulRequests: 0, disabled: false, coverage: {} }; }
    const servers = new Map();
    for (const raw of source.servers) {
      let address;
      try { address = parseAddress(raw.id); } catch { continue; }
      const previous = servers.get(address.id);
      const discoverySources = [...new Set([...(previous?.discoverySources || []), ...(raw.discoverySources || []), 'web-api'])];
      servers.set(address.id, { ...previous, ...raw, ...address, discoverySources,
        candidateOnly: discoverySources.some(value => value.startsWith('name:') || value.startsWith('map:')) });
    }
    // A failed/unavailable pass preserves the monitor's last-good Steam counter.
    const coverage = source.disabled || source.successfulRequests > 0 ? { steamEndpoints: servers.size } : {};
    return { ...source, servers: [...servers.values()], coverage };
  };
}
