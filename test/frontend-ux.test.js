import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { serverCard } from '../public/js/render.js';
import { filterServers } from '../public/js/filters.js';

test('server cards keep actions and status without rendering Server details', () => {
  const document = { createElement: tag => ({ tag, children: [], listeners: {}, setAttribute() {}, addEventListener(name, callback) { this.listeners[name] = callback; },
    append(...children) { this.children.push(...children); } }) };
  const server = { id: '8.8.8.8:27015', name: 'Christmas Dust', map: 'de_xmas', countryCode: 'PL', country: 'Poland',
    status: 'online', stale: false, players: 4, maxPlayers: 32, password: false, bots: 2,
    backendQueryMs: 42, lastSeenAt: 1000, classification: { confidence: 'high', reasons: ['private reason'] } };
  let hidden;
  const card = serverCard(document, server, { location: null, favorite: false, toggleFavorite() {}, hide(value) { hidden = value; }, copy() {} });
  const nodes = [card];
  for (let i = 0; i < nodes.length; i++) nodes.push(...nodes[i].children);
  const text = nodes.map(node => node.textContent || '').join(' ');
  assert.equal(nodes.some(node => ['details', 'summary'].includes(node.tag)), false);
  for (const visible of ['Christmas Dust', 'de_xmas', 'Poland', 'Online', '4 / 32', 'Connect', 'Copy command', 'Hide'])
    assert.ok(text.includes(visible), visible);
  nodes.find(node => node.textContent === 'Hide').listeners.click();
  assert.equal(hidden, server);
  for (const hidden of ['Server details', 'Last seen', 'Monitor query latency', 'private reason', 'bots'])
    assert.equal(text.includes(hidden), false, hidden);
});

test('Country stays manual and Online only is absent from the frontend', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(html, /<select id="country"[^>]*><option value="">Countries unavailable<\/option>/);
  assert.doesNotMatch(app, /applyInitialCountry|countryDefaultDone/);
  assert.doesNotMatch(html, /id="online"|Online only/);
  assert.doesNotMatch(app, /\$\('online'\)/);
  const rows = [{ id: 'offline', name: 'Xmas', map: 'de_xmas', players: 3, status: 'offline', stale: false,
    classification: { confidence: 'high' } }, { id: 'online', name: 'Xmas', map: 'de_xmas', players: 2,
    status: 'online', stale: false, classification: { confidence: 'high' } }];
  const filters = { search: '', country: '', map: '', confidence: '', slots: false,
    favorites: false, hideEmpty: false };
  assert.deepEqual(filterServers(rows, filters, new Set()), [rows[1]]);
});

test('Hidden servers section is collapsed by default', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<details id="hidden-section"[^>]*><summary id="hidden-summary">Hidden servers \(0\)<\/summary>/);
  assert.doesNotMatch(html, /<details id="hidden-section"[^>]*\bopen\b/);
});
