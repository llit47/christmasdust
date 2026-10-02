import { isFavorite } from './favorites.js';

export function coordinates(value) {
  return value && Number.isFinite(value.latitude) && Number.isFinite(value.longitude) && Math.abs(value.latitude) <= 90 && Math.abs(value.longitude) <= 180;
}
export function haversine(a, b) {
  if (!coordinates(a) || !coordinates(b)) return Infinity;
  const radians = degrees => degrees * Math.PI / 180;
  const h = Math.sin(radians(b.latitude - a.latitude) / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(radians(b.longitude - a.longitude) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}
export function rankServers(servers, { countryCode, location, sort = 'recommended', favoriteIds = new Set(), includeRatings = true } = {}) {
  const distance = row => haversine(location, row);
  const difference = (a, b) => a === b ? 0 : a < b ? -1 : 1;
  const available = row => row.status === 'online' && !row.stale && row.players < row.maxPlayers && !row.password;
  const relevance = row => ({ high: 3, curated: 2, probable: 1 })[row.classification?.confidence] || 0;
  const rating = row => {
    if (!includeRatings) return 0;
    const up = row.ratings?.up ?? 0;
    const down = row.ratings?.down ?? 0;
    return (up - down) / (up + down + 5);
  };
  return [...servers].sort((a, b) => {
    const favoritePriority = Number(available(b) && isFavorite(b, favoriteIds)) - Number(available(a) && isFavorite(a, favoriteIds));
    if (favoritePriority) return favoritePriority;
    if (sort === 'players') return b.players - a.players || a.id.localeCompare(b.id);
    if (sort === 'proximity') return difference(distance(a), distance(b)) || a.id.localeCompare(b.id);
    return relevance(b) - relevance(a) || (b.classification?.score || 0) - (a.classification?.score || 0) || rating(b) - rating(a) ||
      Number(Boolean(countryCode) && b.countryCode === countryCode) - Number(Boolean(countryCode) && a.countryCode === countryCode) ||
      difference(distance(a), distance(b)) || Number(b.status === 'online' && !b.stale) - Number(a.status === 'online' && !a.stale) ||
      Number(available(b)) - Number(available(a)) || b.players - a.players || a.id.localeCompare(b.id);
  });
}
