export const cleanText = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : '';
const count = value => Number.isFinite(value) ? Math.max(0, Math.min(65535, Math.floor(value))) : 0;
export function metadata(raw) {
  return { name: cleanText(raw.name), map: cleanText(raw.map), players: count(raw.numplayers ?? raw.players),
    maxPlayers: count(raw.maxplayers ?? raw.maxPlayers ?? raw.max_players), bots: Number.isFinite(raw.raw?.numbots) ? count(raw.raw.numbots) : typeof raw.bots === 'number' ? count(raw.bots) : Array.isArray(raw.bots) && raw.bots.length ? raw.bots.length : null,
    password: Boolean(raw.password), backendQueryMs: Number.isFinite(raw.ping) ? Math.max(0, Math.round(raw.ping)) : null };
}
// A successful GameDig response may omit fields. Only merge values it actually measured.
export function liveMetadata(raw) {
  const values = metadata(raw);
  const result = {};
  for (const field of ['name', 'map']) if (values[field].trim()) result[field] = values[field];
  if (Number.isFinite(raw.numplayers ?? raw.players)) result.players = values.players;
  if (Number.isFinite(raw.maxplayers ?? raw.maxPlayers ?? raw.max_players)) result.maxPlayers = values.maxPlayers;
  if (Number.isFinite(raw.raw?.numbots) || Number.isFinite(raw.bots) || (Array.isArray(raw.bots) && raw.bots.length)) result.bots = values.bots;
  if (typeof raw.password === 'boolean' || raw.password === 0 || raw.password === 1) result.password = values.password;
  if (Number.isFinite(raw.ping)) result.backendQueryMs = values.backendQueryMs;
  return result;
}
