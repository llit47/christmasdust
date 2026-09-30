import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, loadDetection } from '../src/config/index.js';
import { parseAddress, deduplicate } from '../src/utils/address.js';
import { classify } from '../src/domain/classify.js';
import { mapLimit } from '../src/utils/concurrency.js';
import { haversine, rankServers } from '../public/js/ranking.js';
import { element, connection } from '../public/js/render.js';
import { countryOptions, countryFilterState, filterServers } from '../public/js/filters.js';
import { metadata } from '../src/domain/server.js';
const rules = await loadDetection(new URL('../config/detection.json', import.meta.url));
test('Steam and GameDig player capacities keep their source field shapes', () => {
  const { players, maxPlayers } = metadata({ players: 12, max_players: 32 });
  assert.deepEqual({ players, maxPlayers }, { players: 12, maxPlayers: 32 });
  assert.equal(metadata({ numplayers: 4, maxplayers: 16 }).maxPlayers, 16);
  assert.equal(metadata({ numplayers: 4, maxPlayers: 24 }).maxPlayers, 24);
});
test('configuration defaults and strict validation', () => {
  assert.equal(readConfig({}).liveInterval, 45000);
  assert.equal(readConfig({}).port, 3001);
  for (const env of [{ PORT: '30oops' }, { PORT: '' }, { NODE_ENV: 'prod' }, { QUERY_CONCURRENCY: '0' }, { DISCOVERY_MODE: 'steam' }, { ADMIN_TOKEN: 'short' }, { TRUST_CF_COUNTRY: 'yes' }, { TRUST_CF_COUNTRY: 'true' }, { TRUSTED_PROXIES: 'true' }, { TRUSTED_PROXIES: '1.1.1.1/33' }, { HOST: 'localhost' }, { STEAM_API_KEY: 'oops' }, { STALE_AFTER_MS: '10000' }]) assert.throws(() => readConfig(env));
  assert.equal(readConfig({ TRUSTED_PROXIES: '127.0.0.1/32', TRUST_CF_COUNTRY: 'true' }).trustCf, true);
});
test('address normalization, invalid endpoints and private network denial', () => {
  assert.deepEqual(parseAddress('8.8.8.8:00080'), { id: '8.8.8.8:80', ip: '8.8.8.8', port: 80 });
  assert.deepEqual(parseAddress('192.0.1.1:27015'), { id: '192.0.1.1:27015', ip: '192.0.1.1', port: 27015 });
  for (const value of ['localhost:27015', '[::1]:27015', '127.0.0.1:27015', '10.1.1.1:2', '169.254.169.254:80', '100.64.1.1:80', '192.0.0.1:27015', '192.0.2.1:27015', '192.168.1.1:2', '172.31.1.1:2', '0.0.0.0:2', '224.0.0.1:2', '240.0.0.1:27015', '8.8.8.8:0', '8.8.8.8:65536', '8.8.8.8:80/path', '8.8.8.8:80\n', '008.8.8.8:80']) assert.throws(() => parseAddress(value), value);
});
test('explainable multilingual confidence and curation', () => {
  for (const name of ['Christmas', 'XMAS', 'Święta', 'Noël', 'Weihnachten']) assert.equal(classify({ name }, rules).confidence, 'high');
  assert.equal(classify({ map: 'de_snow' }, rules).confidence, 'none');
  assert.equal(classify({ name: 'classic dust' }, rules).confidence, 'none');
  assert.equal(classify({}, rules, true).confidence, 'curated');
  assert.deepEqual(classify({ map: 'de_xmas' }, rules).reasons, ['map: xmas']);
});
test('explicit names and vetted maps provide strong Christmas evidence', () => {
  const name = classify({ name: '-= Christmas Dust 2 =-', map: 'de_dust2' }, rules);
  assert.equal(name.confidence, 'high'); assert.ok(name.score >= 7);
  const map = classify({ name: 'Public CS Server #4', map: 'de_dust2_xmas' }, rules);
  assert.equal(map.confidence, 'high');
  assert.equal(map.score, 12);
  assert.ok(map.signals.some(signal => signal.kind === 'known-strong-map'));
  assert.equal(classify({ name: 'Public', map: 'custom_xmas_2026' }, rules).confidence, 'high');
});
test('probable map needs corroboration and generic snow cannot qualify alone', () => {
  const probable = classify({ name: 'Winter Holiday Server', map: 'deathrun_jinglebells' }, rules);
  assert.equal(probable.confidence, 'probable');
  assert.ok(probable.signals.some(signal => signal.kind === 'known-probable-map'));
  assert.equal(classify({ name: 'Public', map: 'deathrun_jinglebells' }, rules).confidence, 'none');
  assert.equal(classify({ name: 'Not Winter', map: 'deathrun_jinglebells' }, rules).confidence, 'none');
  assert.equal(classify({ name: 'No Santa', map: 'deathrun_jinglebells' }, rules).confidence, 'none');
  assert.equal(classify({ name: 'Public Deathmatch', map: 'fy_snow' }, rules).confidence, 'none');
  assert.equal(classify({ name: 'Snow Arena 24/7', map: 'de_dust2' }, rules).confidence, 'none');
  assert.equal(classify({ name: 'No Christmas', map: 'fy_snow' }, rules).confidence, 'none');
  assert.equal(classify({ name: 'Public', map: 'de_dust2', discoverySources: ['name:christmas'] }, rules).confidence, 'none');
  assert.equal(classify({ name: 'Snow Arena', map: 'fy_snow', tags: 'winter', description: 'holiday',
    discoverySources: ['name:christmas'] }, rules).confidence, 'none');
  assert.equal(classify({ name: 'Public', map: 'de_dust2', description: 'Christmas event' }, rules).confidence, 'high');
});
test('Christmas tokens tolerate separators but reject unrelated substrings', () => {
  for (const name of ['xmas', 'x-mas', 'x_mas', '[XMAS]', 'christmas_2026'])
    assert.equal(classify({ name, map: 'de_dust2' }, rules).confidence, 'high', name);
  for (const name of ['xmassive', 'santamonica', 'snowmobile'])
    assert.equal(classify({ name, map: 'de_dust2' }, rules).confidence, 'none', name);
});
test('map catalog is unique and rejects invalid entries', async t => {
  const catalog = [...rules.maps.strong, ...rules.maps.probable];
  assert.equal(new Set(catalog).size, catalog.length);
  const directory = await mkdtemp(join(tmpdir(), 'christmasdust-maps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'maps.json');
  await writeFile(path, JSON.stringify({ strong: ['de_xmas'], probable: ['de_xmas'] }));
  await assert.rejects(loadDetection(new URL('../config/detection.json', import.meta.url), path), /catalog probable/);
  await writeFile(path, JSON.stringify({ strong: ['fy_snow\\map\\evil'], probable: [] }));
  await assert.rejects(loadDetection(new URL('../config/detection.json', import.meta.url), path), /catalog strong/);
});
test('deduplication retains latest metadata', () => assert.deepEqual(deduplicate([{ id: 'a', n: 1 }, { id: 'a', n: 2 }, { id: 'b' }]), [{ id: 'a', n: 2 }, { id: 'b' }]));
test('bounded concurrency isolates failures', async () => {
  let active = 0; let peak = 0;
  const result = await mapLimit([0, 1, 2, 3, 4], 2, async i => {
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; if (i === 2) throw Error(); return i;
  });
  assert.equal(peak, 2); assert.equal(result[2].status, 'rejected'); assert.equal(result[4].value, 4);
});
test('Haversine and recommendations separate distance from population', () => {
  const london = { latitude: 51.5074, longitude: -0.1278 }; const paris = { latitude: 48.8566, longitude: 2.3522 };
  assert.ok(Math.abs(haversine(london, paris) - 343.56) < 1); assert.equal(haversine(london, london), 0); assert.equal(haversine(null, paris), Infinity);
  const rows = [{ id: 'a', countryCode: 'FR', ...paris, players: 20 }, { id: 'b', countryCode: 'GB', latitude: 55, longitude: 0, players: 2 }, { id: 'c', countryCode: 'GB', ...london, players: 1 }];
  assert.deepEqual(rankServers(rows, { countryCode: 'GB', location: london }).map(s => s.id), ['c', 'b', 'a']);
  assert.equal(rankServers(rows, { sort: 'players' })[0].id, 'a');
  assert.equal(rankServers(rows, { location: paris, sort: 'proximity' })[0].id, 'a');
});
test('recommended ranking prefers Christmas relevance before country and proximity', () => {
  const probable = { id: 'a', countryCode: 'GB', classification: { confidence: 'probable', score: 7 } };
  const high = { id: 'b', countryCode: 'FR', classification: { confidence: 'high', score: 9 } };
  const curated = { id: 'c', countryCode: 'GB', classification: { confidence: 'curated', score: 0 } };
  assert.deepEqual(rankServers([probable, curated, high], { countryCode: 'GB' }).map(row => row.id), ['b', 'c', 'a']);
});
test('country options and country filtering use located servers without dropping other filters', () => {
  const rows = [
    { id: 'a', name: 'Christmas DE', map: 'de_xmas', countryCode: 'DE', country: 'Germany', players: 0, classification: { confidence: 'high' } },
    { id: 'b', name: 'Christmas US', map: 'de_xmas', countryCode: 'US', country: 'United States', players: 3, classification: { confidence: 'high' } },
    { id: 'c', name: 'Christmas unknown', map: 'de_xmas', countryCode: null, players: 4, classification: { confidence: 'high' } }
  ];
  assert.deepEqual(countryOptions(rows), [['DE', 'Germany'], ['US', 'United States']]);
  assert.deepEqual(countryFilterState(rows, false), { choices: [], disabled: true,
    message: 'Server country filtering unavailable: GeoIP is not configured.' });
  assert.equal(countryFilterState(rows, true).disabled, false);
  assert.deepEqual(filterServers(rows, { search: '', country: 'DE', map: '', confidence: '', slots: false,
    favorites: false, online: false, hideEmpty: false }, new Set()).map(row => row.id), ['a']);
});
test('Hide empty servers is frontend-only and unchecking restores zero-player rows', () => {
  const rows = [{ id: 'empty', players: 0 }, { id: 'occupied', players: 2 }];
  const filters = { search: '', country: '', map: '', confidence: '', slots: false,
    favorites: false, online: false, hideEmpty: true };
  assert.deepEqual(filterServers(rows, filters, new Set()).map(row => row.id), ['occupied']);
  filters.hideEmpty = false;
  assert.deepEqual(filterServers(rows, filters, new Set()).map(row => row.id), ['empty', 'occupied']);
  assert.equal(rows[0].players, 0);
});
test('stale servers are absent from frontend results, counts and country choices', () => {
  const rows = [
    { id: 'stale', name: 'Christmas stale', map: 'de_xmas', countryCode: 'DE', country: 'Germany', players: 24, status: 'online', stale: true, classification: { confidence: 'high' } },
    { id: 'fresh', name: 'Christmas fresh', map: 'de_dust2', countryCode: 'US', country: 'United States', players: 3, status: 'online', stale: false, classification: { confidence: 'high' } }
  ];
  const filters = { search: '', country: '', map: '', confidence: '', slots: false,
    favorites: false, online: false, hideEmpty: false };
  const visible = filterServers(rows, filters, new Set());
  assert.deepEqual(visible.map(row => row.id), ['fresh']);
  assert.equal(visible.length, 1);
  assert.equal(visible.reduce((sum, row) => sum + row.players, 0), 3);
  assert.deepEqual(countryOptions(rows), [['US', 'United States']]);
  filters.online = true;
  assert.deepEqual(filterServers(rows, filters, new Set()).map(row => row.id), ['fresh']);
  filters.online = false; filters.search = 'stale';
  assert.deepEqual(filterServers(rows, filters, new Set()), []);
  assert.equal(rows[0].stale, true);
});
test('external strings are assigned as text and cannot become links', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const document = { createElement: tag => ({ tag, set innerHTML(_) { throw Error('unsafe'); } }) };
  assert.equal(element(document, 'h3', hostile).textContent, hostile);
  assert.equal(connection('8.8.8.8:27015').command, 'connect 8.8.8.8:27015');
  assert.throws(() => connection('javascript:alert(1)')); assert.throws(() => connection('8.8.8.8:0'));
});
