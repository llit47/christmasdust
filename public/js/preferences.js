export const preferencesKey = 'christmasdust.preferences.v1';

const defaults = { search: '', country: '', map: '', confidence: '', sort: 'recommended',
  slots: false, hideEmpty: false, favorites: false };
const select = (value, allowed) => allowed.includes(value) ? value : '';
const normalize = value => ({
  search: typeof value?.search === 'string' ? value.search.slice(0, 200) : '',
  country: typeof value?.country === 'string' && /^[A-Z]{2}$/.test(value.country) ? value.country : '',
  map: typeof value?.map === 'string' ? value.map.slice(0, 200) : '',
  confidence: select(value?.confidence, ['', 'high', 'probable', 'curated']),
  sort: select(value?.sort, ['recommended', 'players', 'proximity']) || 'recommended',
  slots: value?.slots === true, hideEmpty: value?.hideEmpty === true, favorites: value?.favorites === true
});

export function readPreferences(storage) {
  try {
    const text = storage.getItem(preferencesKey);
    if (!text || text.length > 4096) return { ...defaults };
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults };
    return normalize(value);
  } catch { return { ...defaults }; }
}

export function writePreferences(storage, value) {
  try { storage.setItem(preferencesKey, JSON.stringify(normalize(value))); return true; }
  catch { return false; }
}

export function availableChoice(saved, options) {
  return options.some(([value]) => value === saved) ? saved : '';
}

export function restoredSort(saved, location) {
  return saved === 'proximity' && !location ? 'recommended' : saved;
}
