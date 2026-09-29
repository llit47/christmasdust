import { rankServers } from './ranking.js';
import { serverCard, element } from './render.js';
const $ = id => document.getElementById(id);
let snapshot = null; let location = null; let favoriteIds = new Set(); let loading = false; let toastTimer;
try { const saved = JSON.parse(localStorage.getItem('christmasdust.favorites') || '[]'); if (Array.isArray(saved)) favoriteIds = new Set(saved.filter(v => typeof v === 'string').slice(0, 5000)); } catch { /* Storage is optional. */ }
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3000); }
function toggleFavorite(id) {
  if (favoriteIds.has(id)) favoriteIds.delete(id); else favoriteIds.add(id);
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
  const query = $('search').value.trim().toLowerCase();
  const rows = snapshot.servers.filter(row => {
    return (!query || `${row.name} ${row.map} ${row.id}`.toLowerCase().includes(query)) &&
      (!$('country').value || row.countryCode === $('country').value) && (!$('map').value || row.map === $('map').value) &&
      (!$('confidence').value || row.classification.confidence === $('confidence').value) &&
      (!$('slots').checked || (row.status === 'online' && !row.stale && row.maxPlayers > row.players && !row.password)) &&
      (!$('favorites').checked || favoriteIds.has(row.id)) && (!$('online').checked || (row.status === 'online' && !row.stale));
  });
  const sorted = rankServers(rows, { countryCode: snapshot.visitor.countryCode, location, sort: $('sort').value });
  $('count').textContent = `${sorted.length} servers · ${sorted.filter(r => r.status === 'online' && !r.stale).reduce((sum, r) => sum + r.players, 0)} players online`;
  // Defer replacement while a card is focused to preserve keyboard position and open details during polling.
  $('servers').replaceChildren(...sorted.map(row => serverCard(document, row, { location, favorite: favoriteIds.has(row.id), toggleFavorite, copy })));
  if (!sorted.length) $('servers').append(element(document, 'p', snapshot.servers.length ? 'No servers match these filters. Try a broader search.' : 'No winter servers in the snapshot yet. Discovery may be warming up, or the operator may need to configure discovery or curated servers.', 'empty'));
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
    options('country', [...new Map(snapshot.servers.filter(s => s.countryCode).map(s => [s.countryCode, s.country || s.countryCode]))].sort((a, b) => a[1].localeCompare(b[1])), 'All countries');
    options('map', [...new Set(snapshot.servers.map(s => s.map).filter(Boolean))].sort().map(s => [s, s]), 'All maps');
    const messages = [];
    if (snapshot.meta.stale) messages.push('The snapshot is stale. Last known details are shown; availability may have changed.');
    else if (snapshot.meta.degraded) messages.push('Some servers or discovery sources did not respond. Last known details are retained.');
    if (snapshot.meta.discoveryDisabled && !snapshot.servers.length) messages.push('Discovery is not configured. The operator can add a Steam API key or curated servers.');
    $('status').textContent = messages.join(' ');
    $('version').textContent = `v${snapshot.version}`;
    if (!location) $('location-status').textContent = snapshot.visitor.countryCode ? `Servers in ${snapshot.visitor.countryCode} are preferred. Use your location for approximate distance; coordinates stay in this browser.` : 'Choose a country to filter, or use your location for approximate distance. Coordinates stay in this browser.';
    if (!$('servers').contains(document.activeElement) && !$('servers').querySelector('details[open]')) render();
  } catch {
    if (snapshot) { snapshot.servers = snapshot.servers.map(row => ({ ...row, stale: true })); if (!$('servers').contains(document.activeElement)) render(); }
    $('status').textContent = 'Could not reach the snapshot service. Retaining your last view; retrying automatically.'; }
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
