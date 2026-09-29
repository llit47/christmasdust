import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, loadDetection } from '../src/config/index.js';
import { parseAddress, deduplicate } from '../src/utils/address.js';
import { classify } from '../src/domain/classify.js';
import { mapLimit } from '../src/utils/concurrency.js';
import { haversine, rankServers } from '../public/js/ranking.js';
import { element, connection } from '../public/js/render.js';
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
  for (const value of ['localhost:27015', '[::1]:27015', '127.0.0.1:27015', '10.1.1.1:2', '169.254.169.254:80', '100.64.1.1:80', '192.168.1.1:2', '172.31.1.1:2', '0.0.0.0:2', '224.0.0.1:2', '240.0.0.1:27015', '8.8.8.8:0', '8.8.8.8:65536', '8.8.8.8:80/path', '8.8.8.8:80\n', '008.8.8.8:80']) assert.throws(() => parseAddress(value), value);
});
test('explainable multilingual confidence and curation', () => {
  for (const name of ['Christmas', 'XMAS', 'Święta', 'Noël', 'Weihnachten']) assert.equal(classify({ name }, rules).confidence, 'high');
  assert.equal(classify({ map: 'de_snow' }, rules).confidence, 'probable');
  assert.equal(classify({ name: 'classic dust' }, rules).confidence, 'none');
  assert.equal(classify({}, rules, true).confidence, 'curated');
  assert.deepEqual(classify({ map: 'de_xmas' }, rules).reasons, ['map: xmas']);
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
test('external strings are assigned as text and cannot become links', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const document = { createElement: tag => ({ tag, set innerHTML(_) { throw Error('unsafe'); } }) };
  assert.equal(element(document, 'h3', hostile).textContent, hostile);
  assert.equal(connection('8.8.8.8:27015').command, 'connect 8.8.8.8:27015');
  assert.throws(() => connection('javascript:alert(1)')); assert.throws(() => connection('8.8.8.8:0'));
});
