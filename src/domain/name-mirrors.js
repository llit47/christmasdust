import { classify } from './classify.js';
import { cleanText } from './server.js';

const normalizedName = value => cleanText(value).normalize('NFKC').toLowerCase()
  .replace(/\p{Cf}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const latency = row => Number.isFinite(row.backendQueryMs) && row.backendQueryMs >= 0 ? row.backendQueryMs : Infinity;
const compare = (a, b) => (a.misses ?? 0) - (b.misses ?? 0) || latency(a) - latency(b) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// A visibility filter only: preserve the endpoint records for monitoring and persistence.
export function filterSameNameMirrors(rows, rules) {
  const groups = new Map();
  for (const row of rows) {
    if (row.stale || row.status !== 'online' || row.curated || row.classification?.confidence === 'curated') continue;
    // Reuse current map classification, including operator terms and token normalization.
    if (classify({ map: row.map }, rules).confidence === 'high') continue;
    const name = normalizedName(row.name);
    if (!name) continue;
    const group = groups.get(name) ?? { ips: new Set(), members: [] };
    group.ips.add(row.ip); group.members.push(row); groups.set(name, group);
  }
  const suppressed = new Set();
  for (const { ips, members } of groups.values()) {
    if (ips.size < 5) continue;
    // Every eligible member is fresh/responding; use health and a stable endpoint tie-breaker.
    const representative = members.reduce((best, row) => compare(row, best) < 0 ? row : best);
    for (const row of members) if (row.id !== representative.id) suppressed.add(row.id);
  }
  return rows.filter(row => !suppressed.has(row.id));
}
