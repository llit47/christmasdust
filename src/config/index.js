import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { parseAddress } from '../utils/address.js';
import { migrateDetection } from './detection.js';
export function readConfig(env = process.env) {
  const number = (key, fallback, min, max) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return Number(raw);
  };
  const mode = env.NODE_ENV ?? 'development';
  if (!['production', 'development', 'test'].includes(mode)) throw new Error('Invalid NODE_ENV');
  const host = env.HOST ?? '127.0.0.1';
  if (!isIP(host)) throw new Error('HOST must be a literal IP');
  const discoveryMode = env.DISCOVERY_MODE ?? 'auto';
  if (!['auto', 'steam', 'seeds'].includes(discoveryMode)) throw new Error('Invalid DISCOVERY_MODE');
  const steamKey = env.STEAM_API_KEY ?? '';
  if (steamKey && !/^[a-f\d]{32}$/i.test(steamKey)) throw new Error('STEAM_API_KEY must be 32 hex characters');
  if (discoveryMode === 'steam' && !steamKey) throw new Error('steam discovery requires STEAM_API_KEY');
  const trustedProxies = (env.TRUSTED_PROXIES ?? '').split(',').filter(Boolean).map(s => s.trim());
  for (const entry of trustedProxies) {
    const [ip, prefix, extra] = entry.split('/');
    if (!isIP(ip) || extra || (prefix !== undefined && (!/^\d+$/.test(prefix) || +prefix > (isIP(ip) === 4 ? 32 : 128)))) throw new Error('Invalid TRUSTED_PROXIES IP/CIDR');
  }
  if (!['true', 'false'].includes(env.TRUST_CF_COUNTRY ?? 'false')) throw new Error('TRUST_CF_COUNTRY must be true or false');
  const trustCf = env.TRUST_CF_COUNTRY === 'true';
  if (trustCf && !trustedProxies.length) throw new Error('TRUST_CF_COUNTRY requires TRUSTED_PROXIES');
  const adminToken = env.ADMIN_TOKEN ?? '';
  if (adminToken && (adminToken.length < 32 || /\s/.test(adminToken))) throw new Error('ADMIN_TOKEN must be at least 32 non-whitespace characters');
  const cfg = { mode, host, discoveryMode, steamKey, trustedProxies, trustCf, adminToken,
    port: number('PORT', 3001, 1, 65535), discoveryInterval: number('DISCOVERY_INTERVAL_MS', 600000, 60000, 86400000),
    liveInterval: number('LIVE_INTERVAL_MS', 45000, 10000, 3600000), concurrency: number('QUERY_CONCURRENCY', 8, 1, 32),
    queryTimeout: number('QUERY_TIMEOUT_MS', 5000, 500, 30000), discoveryTimeout: number('DISCOVERY_TIMEOUT_MS', 15000, 1000, 60000),
    discoveryLimit: number('DISCOVERY_LIMIT', 5000, 1, 20000), maxServers: number('MAX_SERVERS', 1000, 1, 5000),
    staleAfter: number('STALE_AFTER_MS', 180000, 10000, 86400000), retention: number('RETENTION_MS', 604800000, 3600000, 2592000000),
    ratingsPath: resolve(env.RATINGS_PATH || './data/ratings.sqlite'),
    snapshotPath: resolve(env.SNAPSHOT_PATH || './data/snapshot.json'), detectionPath: resolve(env.DETECTION_PATH || './config/detection.json'), geoipPath: env.GEOIP_PATH || '' };
  if (cfg.staleAfter < cfg.liveInterval) throw new Error('STALE_AFTER_MS must be >= LIVE_INTERVAL_MS');
  return cfg;
}
export async function loadDetection(path, mapPath = new URL('../../config/christmas-maps.json', import.meta.url)) {
  const { config: value } = migrateDetection(JSON.parse(await readFile(path, 'utf8')));
  const catalog = JSON.parse(await readFile(mapPath, 'utf8'));
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) ||
    Object.keys(catalog).sort().join(',') !== 'probable,strong') throw new Error('Invalid Christmas map catalog keys');
  const names = new Set();
  for (const kind of ['strong', 'probable']) {
    if (!Array.isArray(catalog[kind]) || catalog[kind].length > 100 || catalog[kind].some(name => {
      if (typeof name !== 'string' || !/^[a-z0-9_]{3,32}$/.test(name) || names.has(name)) return true;
      names.add(name); return false;
    })) throw new Error(`Invalid Christmas map catalog ${kind}`);
  }
  return { ...value, related: value.related ?? [], maps: { strong: new Set(catalog.strong), probable: new Set(catalog.probable) },
    include: value.include.map(parseAddress), exclude: new Set(value.exclude.map(v => parseAddress(v).id)) };
}
