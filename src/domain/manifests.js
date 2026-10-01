import { cleanText } from './server.js';

const normalized = value => typeof value === 'string' && value.length <= 200
  ? cleanText(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim() : null;
const count = value => Number.isInteger(value) && value >= 0 && value <= 65535;
const optional = value => value == null ? null : typeof value === 'string' ? normalized(value) : value;

// Only this complete live observation supplies evidence; never merge discovery or cached fields.
export function liveManifestFingerprint(raw) {
  const info = raw?.raw;
  const name = normalized(raw?.name); const map = normalized(raw?.map);
  const folder = normalized(info?.folder); const game = normalized(info?.game);
  const version = normalized(raw?.version);
  const players = raw?.numplayers ?? raw?.players;
  const maxPlayers = raw?.maxplayers ?? raw?.maxPlayers ?? raw?.max_players;
  const bots = info?.numbots ?? (typeof raw?.bots === 'number' ? raw.bots : null);
  if (!name || !map || !folder || !game || !version || !count(players) ||
    !count(maxPlayers) || maxPlayers === 0 || (bots !== null && !count(bots)) ||
    typeof raw?.password !== 'boolean' || !Number.isInteger(info?.protocol) ||
    info.protocol < 0 || info.protocol > 255) return null;
  // Legacy GoldSrc INFO omits appId; absence stays distinct from a measured value.
  if (info.appId != null && (!Number.isInteger(info.appId) || info.appId < 0 || info.appId > 65535)) return null;
  const tags = info.tags ?? null;
  if (tags !== null && (!Array.isArray(tags) || tags.length > 20 || tags.some(tag => normalized(tag) === null))) return null;
  const fields = ['modlink', 'moddownload', 'modversion', 'modsize', 'modtype', 'moddll',
    'ismod', 'secure', 'listentype', 'environment'];
  if (fields.some(field => info[field] != null &&
    (typeof info[field] === 'string' ? normalized(info[field]) === null :
      typeof info[field] !== 'boolean' && !Number.isFinite(info[field])))) return null;
  return JSON.stringify([name, map, players, maxPlayers, bots, raw.password, folder, game,
    info.protocol, info.appId ?? null, version, tags?.map(normalized).sort() ?? null,
    ...fields.map(field => optional(info[field]))]);
}

export function filterMirroredManifests(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (row.stale || row.status !== 'online' || row.misses || !row.liveManifestFingerprint) continue;
    const ips = groups.get(row.liveManifestFingerprint) ?? new Set();
    ips.add(row.ip); groups.set(row.liveManifestFingerprint, ips);
  }
  // Remove every matching member, never a representative. Keep internal records untouched.
  return rows.filter(row => !(groups.get(row.liveManifestFingerprint)?.size >= 3))
    .map(({ liveManifestFingerprint, ...row }) => row);
}
