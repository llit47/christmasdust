import { isFavorite } from './favorites.js';
import { isHidden } from './hidden.js';

export function countryOptions(servers) {
  return [...new Map(servers.filter(row => row.stale !== true && /^[A-Z]{2}$/.test(row.countryCode ?? ''))
    .map(row => [row.countryCode, row.country || row.countryCode]))]
    .sort((a, b) => a[1].localeCompare(b[1]));
}

export function countryFilterState(servers, configured) {
  const choices = configured ? countryOptions(servers) : [];
  return { choices, disabled: choices.length === 0, message: choices.length ? '' : configured
    ? 'No server countries in this snapshot yet.' : 'Server country filtering unavailable: GeoIP is not configured.' };
}

export function filterServers(servers, filters, favoriteIds, hiddenIds = new Set()) {
  const query = filters.search.trim().toLowerCase();
  return servers.filter(row =>
    row.status === 'online' &&
    row.stale !== true &&
    !isHidden(row, hiddenIds) &&
    (!query || `${row.name} ${row.map} ${row.id}`.toLowerCase().includes(query)) &&
    (!filters.country || row.countryCode === filters.country) &&
    (!filters.map || row.map === filters.map) &&
    (!filters.confidence || row.classification.confidence === filters.confidence) &&
    (!filters.slots || (row.status === 'online' && !row.stale && row.maxPlayers > row.players && !row.password)) &&
    (!filters.favorites || isFavorite(row, favoriteIds)) &&
    (!filters.hideEmpty || row.players !== 0));
}
