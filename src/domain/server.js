export const cleanText = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) : '';
const count = value => Number.isFinite(value) ? Math.max(0, Math.min(65535, Math.floor(value))) : 0;
export function metadata(raw) {
  return { name: cleanText(raw.name), map: cleanText(raw.map), players: count(raw.numplayers ?? raw.players),
    maxPlayers: count(raw.maxplayers ?? raw.maxPlayers), bots: count(Array.isArray(raw.bots) ? raw.bots.length : raw.bots),
    password: Boolean(raw.password), backendQueryMs: Number.isFinite(raw.ping) ? Math.max(0, Math.round(raw.ping)) : null };
}
