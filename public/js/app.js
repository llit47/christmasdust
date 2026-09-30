import { rankServers } from './ranking.js';
import { serverCard, element } from './render.js';
import { countryFilterState, filterServers } from './filters.js';
import { isFavorite, toggleServerFavorite } from './favorites.js';
import { applyInitialCountry, snapshotNotice } from './view-state.js';
const $ = id => document.getElementById(id);
let snapshot = null; let location = null; let favoriteIds = new Set(); let loading = false; let toastTimer; let countryDefaultApplied = false;
try { const saved = JSON.parse(localStorage.getItem('christmasdust.favorites') || '[]'); if (Array.isArray(saved)) favoriteIds = new Set(saved.filter(v => typeof v === 'string').slice(0, 5000)); } catch { /* Storage is optional. */ }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000); }
function toggleFavorite(server) {
  toggleServerFavorite(server, favoriteIds);
  try { localStorage.setItem('christmasdust.favorites', JSON.stringify([...favoriteIds])); } catch { toast('Favorites are saved for this session only.'); }
  render();
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
    favorites: $('favorites').checked, online: $('online').checked, hideEmpty: $('hide-empty').checked }, favoriteIds);
  const sorted = rankServers(rows, { countryCode: snapshot.visitor.countryCode, location, sort: $('sort').value });
  $('count').textContent = `${sorted.length} servers · ${sorted.filter(r => r.status === 'online' && !r.stale).reduce((sum, r) => sum + r.players, 0)} players online`;
  // Defer replacement while a card is focused to preserve keyboard position and open details during polling.
  $('servers').replaceChildren(...sorted.map(row => serverCard(document, row, { location, favorite: isFavorite(row, favoriteIds), toggleFavorite, copy })));
  if (!sorted.length) $('servers').append(element(document, 'p', snapshot.servers.length && snapshot.servers.every(row => row.stale === true) ? 'No recently verified servers are available yet.' : snapshot.servers.length ? 'No servers match these filters. Try a broader search.' : 'No winter servers in the snapshot yet. Discovery may be warming up, or the operator may need to configure discovery or curated servers.', 'empty'));
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
    countryDefaultApplied = applyInitialCountry($('country'), snapshot.visitor.countryCode, countries.choices, countryDefaultApplied);
    $('country').disabled = countries.disabled;
    $('country-status').textContent = countries.message;
    options('map', [...new Set(snapshot.servers.filter(s => s.stale !== true).map(s => s.map).filter(Boolean))].sort().map(s => [s, s]), 'All maps');
    $('status').textContent = snapshotNotice(snapshot.meta, snapshot.servers.length > 0);
    $('version').textContent = `v${snapshot.version}`;
    if (!location) $('location-status').textContent = snapshot.visitor.countryCode ? `Servers in ${snapshot.visitor.countryCode} are preferred. Use your location for approximate distance; coordinates stay in this browser.` : $('country').disabled ? 'Server locations are unavailable. Your coordinates stay in this browser if you choose Use my location.' : 'Choose a country to filter, or use your location for approximate distance. Coordinates stay in this browser.';
    if (!$('servers').contains(document.activeElement) && !$('servers').querySelector('details[open]')) render();
  } catch {
    if (snapshot) { snapshot.servers = snapshot.servers.map(row => ({ ...row, stale: true })); if (!$('servers').contains(document.activeElement)) render(); }
    $('status').textContent = 'Could not reach the snapshot service. Waiting for fresh server data; retrying automatically.'; }
  finally { loading = false; }
}
$('filters').addEventListener('submit', event => event.preventDefault());
$('filters').addEventListener('input', render);
$('sort').addEventListener('change', () => { if ($('sort').value === 'proximity' && !location) toast('Use my location to sort by distance.'); });
$('locate').addEventListener('click', () => {
  if (location) { location = null; $('locate').textContent = '◎ Use my location'; $('location-status').textContent = 'Precise location cleared from this page.'; render(); return; }
  if (!navigator.geolocation) { toast('Location is unavailable. Country filtering still works.'); return; }
  $('locate').disabled = true; $('location-status').textContent = 'Waiting for location permission…';
  navigator.geolocation.getCurrentPosition(position => {
    location = { latitude: position.coords.latitude, longitude: position.coords.longitude };
    $('locate').disabled = false; $('locate').textContent = '× Clear my location';
    $('location-status').textContent = 'Approximate distances enabled. Your coordinates stay in this page and disappear when you close or reload it.'; render();
  }, () => { $('locate').disabled = false; $('location-status').textContent = 'Location was unavailable or declined. All server browsing and country filters still work.'; }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
void poll(); setInterval(poll, 30000);
