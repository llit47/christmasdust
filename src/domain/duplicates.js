import { rankServers } from '../../public/js/ranking.js';
import { cleanText } from './server.js';

const normalized = value => cleanText(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const optional = value => typeof value === 'string' ? normalized(value) : value ?? null;
export function usableServerIdentity(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{14,19}$/.test(value)) return false;
  return BigInt(value) > 1n && BigInt(value) <= 18446744073709551615n;
}

// Complete live A2S_INFO metadata and a shared usable server ID are required.
// GoldSrc can supply that ID through getchallenge steam when INFO omits it.
export function a2sFingerprint(raw) {
  const info = raw?.raw;
  const steamId = usableServerIdentity(info?.steamid) ? info.steamid : raw?.serverIdentity;
  const name = normalized(raw?.name);
  const map = normalized(raw?.map);
  const folder = normalized(info?.folder);
  const game = normalized(info?.game);
  const maxPlayers = raw?.maxplayers ?? raw?.maxPlayers ?? raw?.max_players;
  if (!usableServerIdentity(steamId) || !name || !map || !folder || !game ||
    !Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > 65535 ||
    !Number.isInteger(info?.protocol) || info.protocol < 0 || info.protocol > 255) return null;
  const tags = info.tags === undefined ? null : info.tags;
  if (tags !== null && (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => typeof tag !== 'string'))) return null;
  return JSON.stringify([steamId, name, map, maxPlayers, folder, game, info.protocol,
    info.appId ?? null, optional(raw.version), tags?.map(normalized).sort() ?? null,
    optional(info.modlink), optional(info.moddownload), info.modversion ?? null,
    info.ismod ?? null, info.secure ?? null, optional(info.listentype), optional(info.environment),
    typeof raw.password === 'boolean' ? raw.password : null]);
}

export function groupDuplicates(rows) {
  const groups = new Map();
  for (const row of rows) {
    // An old fingerprint is insufficient after its A2S observation goes stale.
    const key = !row.stale && row.a2sFingerprint ? row.a2sFingerprint : `endpoint:${row.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const visible = [];
  for (const group of groups.values()) {
    // Public ratings must not influence the backend endpoint representative.
    const chosen = rankServers(group, { includeRatings: false })[0];
    const { a2sFingerprint, ...publicRow } = chosen;
    visible.push({ ...publicRow, duplicateCount: group.length - 1,
      duplicateEndpoints: group.filter(row => row.id !== chosen.id).map(row => row.id).sort() });
  }
  return visible;
}
