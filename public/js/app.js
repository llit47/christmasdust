import { createHistoryPoller, HISTORY_REFRESH_MS } from './player-history.js';
import { rankServers } from './ranking.js';
import { serverCard, element } from './render.js';
import { countryFilterState, filterServers } from './filters.js';
import { isFavorite, toggleServerFavorite } from './favorites.js';
import { availableChoice, readPreferences, restoredSort, writePreferences } from './preferences.js';
import { hiddenEntries, hideServer, readHidden, restoreServer, writeHidden } from './hidden.js';
import { lastUpdateLabel, renderWhenUnfocused, setLocationSort, snapshotNotice } from './view-state.js';
const $ = id => document.getElementById(id);
let histories = {};
let snapshot = null; let location = null; let favoriteIds = new Set(); let loading = false; let toastTimer;
let savedPreferences; let hiddenIds = new Set(); let choicesRestored = false;
try { const saved = JSON.parse(localStorage.getItem('christmasdust.favorites') || '[]'); if (Array.isArray(saved)) favoriteIds = new Set(saved.filter(v => typeof v === 'string').slice(0, 5000)); } catch { /* Storage is optional. */ }
try { savedPreferences = readPreferences(localStorage); hiddenIds = readHidden(localStorage); }
catch { savedPreferences = readPreferences({ getItem: () => null }); }
for (const id of ['search', 'confidence', 'sort']) $(id).value = id === 'sort' ? restoredSort(savedPreferences.sort, location) : savedPreferences[id];
for (const id of ['slots', 'hide-empty', 'favorites']) $(id).checked = savedPreferences[id === 'hide-empty' ? 'hideEmpty' : id];
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000); }
function saveControls() {
  const value = { search: $('search').value, country: choicesRestored ? $('country').value : savedPreferences.country,
    map: choicesRestored ? $('map').value : savedPreferences.map, confidence: $('confidence').value,
    sort: $('sort').value, slots: $('slots').checked, hideEmpty: $('hide-empty').checked, favorites: $('favorites').checked };
  try { writePreferences(localStorage, value); } catch { /* Storage is optional. */ }
}
function saveHiddenState() {
  try { if (!writeHidden(localStorage, hiddenIds)) toast('Hidden servers are saved for this session only.'); }
  catch { toast('Hidden servers are saved for this session only.'); }
}
function hide(server) {
  if (!hideServer(server, hiddenIds)) { toast('The hidden server list is full.'); return; }
  saveHiddenState(); render();
}
function renderHidden() {
  if (!snapshot) return;
  const entries = hiddenEntries(snapshot.servers, hiddenIds);
  $('hidden-summary').textContent = `Hidden servers (${entries.length})`;
  if (!$('hidden-section').open) { $('hidden-list').replaceChildren(); return; }
  $('hidden-list').replaceChildren(...entries.map(entry => {
    const row = element(document, 'div', undefined, 'hidden-row');
    const label = element(document, 'span', entry.server ? `${entry.server.name || entry.id} · ${entry.id}` : entry.id);
    const button = element(document, 'button', 'Restore', 'button'); button.type = 'button';
    button.setAttribute('aria-label', `Restore ${entry.server?.name || entry.id}`);
    button.addEventListener('click', () => {
      if (entry.server) restoreServer(entry.server, hiddenIds); else hiddenIds.delete(entry.id);
      saveHiddenState(); render();
    });
    row.append(label, button); return row;
  }));
}
function toggleFavorite(server) {
  toggleServerFavorite(server, favoriteIds);
  try { localStorage.setItem('christmasdust.favorites', JSON.stringify([...favoriteIds])); } catch { toast('Favorites are saved for this session only.'); }
  render();
}
async function rate(server, value) {
  try {
    const response = await fetch('/api/ratings', { method: value === null ? 'DELETE' : 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value === null ? { serverId: server.id } : { serverId: server.id, value }),
      signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Rating cooldown. Try again in a minute.' : 'Could not save your rating. Try again.');
    const result = await response.json();
    for (const row of snapshot.servers) {
      if (row.id === server.id || row.duplicateEndpoints?.includes(server.id)) row.ratings = result.ratings;
    }
    return result.ratings;
  } catch (error) { toast(error.message); return null; }
}
async function copy(command) {
  try { await navigator.clipboard.writeText(command); toast('Connect command copied.'); }
  catch { $('copy-value').value = command; $('copy-dialog').showModal(); $('copy-value').select(); }
}
function options(id, values, label) {
  const select = $(id); const chosen = select.value;
  select.replaceChildren(element(document, 'option', label)); select.firstChild.value = '';
  for (const [value, title] of values) { const option = element(document, 'option', title); option.value = value; select.append(option); }
  select.value = values.some(([value]) => value === chosen) ? chosen : '';
}
function render() {
  if (!snapshot) return;
  const rows = filterServers(snapshot.servers, { search: $('search').value, country: $('country').value,
    map: $('map').value, confidence: $('confidence').value, slots: $('slots').checked,
    favorites: $('favorites').checked, hideEmpty: $('hide-empty').checked }, favoriteIds, hiddenIds);
  const sorted = rankServers(rows, { countryCode: snapshot.visitor.countryCode, location, sort: $('sort').value });
  $('count').textContent = `${sorted.length} servers · ${sorted.filter(r => r.status === 'online' && !r.stale).reduce((sum, r) => sum + r.players, 0)} players online`;
  // Defer replacement while a card is focused to preserve keyboard position during polling.
  $('servers').replaceChildren(...sorted.map(row => serverCard(document, row, { location, favorite: isFavorite(row, favoriteIds), toggleFavorite, hide, copy, rate, history: histories[row.id] })));
  if (!sorted.length) $('servers').append(element(document, 'p', snapshot.servers.length && snapshot.servers.every(row => row.stale === true) ? 'No recently verified servers are available yet.' : snapshot.servers.length ? 'No servers match these filters. Try a broader search.' : 'No winter servers in the snapshot yet. Discovery may be warming up, or the operator may need to configure discovery or curated servers.', 'empty'));
  renderHidden();
}
function renderAfterPoll() {
  renderWhenUnfocused(document.activeElement, [$('servers'), $('hidden-section')], render);
}
async function poll() {
  if (loading || document.hidden) return;
  loading = true;
  try {
    const response = await fetch('/api/servers', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Snapshot unavailable');
    const next = await response.json();
    if (!Array.isArray(next.servers) || !next.meta || !next.visitor) throw new Error('Invalid snapshot');
    snapshot = next;
    const countries = countryFilterState(snapshot.servers, snapshot.meta.serverGeoipConfigured);
    options('country', countries.choices, countries.disabled ? 'Countries unavailable' : 'All countries');
    $('country').disabled = countries.disabled;
    $('country-status').textContent = countries.message;
    const maps = [...new Set(snapshot.servers.filter(s => s.stale !== true).map(s => s.map).filter(Boolean))].sort().map(s => [s, s]);
    options('map', maps, 'All maps');
    if (!choicesRestored) {
      $('country').value = availableChoice(savedPreferences.country, countries.choices);
      $('map').value = availableChoice(savedPreferences.map, maps);
      choicesRestored = true;
    }
    saveControls();
    $('status').textContent = snapshotNotice(snapshot.meta, snapshot.servers.length > 0);
    $('last-update').textContent = lastUpdateLabel(snapshot.meta.lastLiveAt);
    $('version').textContent = `v${snapshot.version}`;
    if (!location) $('location-status').textContent = snapshot.visitor.countryCode ? `Servers in ${snapshot.visitor.countryCode} are preferred. Use your location for approximate distance; coordinates stay in this browser.` : $('country').disabled ? 'Server locations are unavailable. Your coordinates stay in this browser if you choose Use my location.' : 'Choose a country to filter, or use your location for approximate distance. Coordinates stay in this browser.';
    renderAfterPoll();
  } catch {
    if (snapshot) { snapshot.servers = snapshot.servers.map(row => ({ ...row, stale: true })); renderAfterPoll(); }
    $('status').textContent = 'Could not reach the snapshot service. Waiting for fresh server data; retrying automatically.'; }
  finally { loading = false; }
}
$('filters').addEventListener('submit', event => event.preventDefault());
$('filters').addEventListener('input', () => { saveControls(); render(); });
$('hidden-section').addEventListener('toggle', renderHidden);
$('sort').addEventListener('change', () => { if ($('sort').value === 'proximity' && !location) toast('Use my location to sort by distance.'); });
$('locate').addEventListener('click', () => {
  if (location) { location = null; setLocationSort($('sort'), false); saveControls(); $('locate').textContent = '◎ Use my location'; $('location-status').textContent = 'Precise location cleared from this page.'; render(); return; }
  if (!navigator.geolocation) { toast('Location is unavailable. Country filtering still works.'); return; }
  $('locate').disabled = true; $('location-status').textContent = 'Waiting for location permission…';
  navigator.geolocation.getCurrentPosition(position => {
    location = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    setLocationSort($('sort'), true); saveControls();
    $('locate').disabled = false; $('locate').textContent = '× Clear my location';
    $('location-status').textContent = 'Approximate distances enabled. Your coordinates stay in this page and disappear when you close or reload it.'; render();
  }, () => { $('locate').disabled = false; $('location-status').textContent = 'Location was unavailable or declined. All server browsing and country filters still work.'; }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
});
const pollHistory = createHistoryPoller({ fetchHistory: fetch, isHidden: () => document.hidden,
  onHistory: next => { histories = next; renderAfterPoll(); } });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { void poll(); void pollHistory(); }
});
void pollHistory(); setInterval(pollHistory, HISTORY_REFRESH_MS);
void poll(); setInterval(poll, 30000);
