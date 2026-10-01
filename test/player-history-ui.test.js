import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { playerSparkline, createHistoryPoller, HISTORY_REFRESH_MS } from '../public/js/player-history.js';
import { serverCard } from '../public/js/render.js';

const document = {
  createElement: tag => ({ tag, children: [], attributes: {}, textContent: '',
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {}, append(...children) { this.children.push(...children); } }),
  createElementNS(ns, tag) { const node = this.createElement(tag); node.ns = ns; return node; }
};
const points = () => Array(48).fill(null);
function nodes(root) { return [root, ...root.children.flatMap(nodes)]; }

test('native SVG splits null gaps, renders measured zero at baseline and scales to capacity', () => {
  const history = points(); history.splice(0, 6, 0, 16, null, 32, 0, null);
  const svg = playerSparkline(document, history, 32);
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.attributes.role, 'img');
  assert.equal(svg.attributes['aria-label'], '24 hour player history, average 12, peak 32');
  assert.equal(svg.children[0].textContent, svg.attributes['aria-label']);
  const paths = svg.children.filter(node => node.tag === 'path');
  assert.equal(paths.length, 2);
  assert.equal(paths[0].attributes.d, 'M1.00,23.00 L2.23,12.00');
  assert.equal(paths[1].attributes.d, 'M4.70,1.00 L5.94,23.00');
  const zeros = points(); zeros[0] = zeros[1] = 0;
  assert.equal(playerSparkline(document, zeros, 32).children[1].attributes.d, 'M1.00,23.00 L2.23,23.00');
  const low = points(); low[0] = 1; low[1] = 2;
  assert.match(playerSparkline(document, low, 32).children[1].attributes.d, /22.31.*21.63/);
  assert.equal(playerSparkline(document, points(), 32), null);
  low[1] = null; assert.equal(playerSparkline(document, low, 32), null);
  assert.equal(playerSparkline(document, ['<script>'], 32), null);
});

test('sparkline and count share the same population row with existing open slots below', () => {
  const history = points(); history[0] = 0; history[1] = 18;
  const server = { id: '8.8.8.8:27015', name: '<img onerror=alert(1)>', players: 18, maxPlayers: 32,
    status: 'online', classification: { confidence: 'high' } };
  const card = serverCard(document, server, { history });
  const population = nodes(card).find(node => node.className === 'population');
  assert.equal(population.children[0].className, 'population-top');
  assert.deepEqual(population.children[0].children.map(node => node.tag), ['strong', 'svg']);
  assert.equal(population.children[1].textContent, '14 open slots');
  assert.equal(nodes(card).some(node => node.tag === 'img'), false);
  const empty = nodes(serverCard(document, server, {})).find(node => node.className === 'population');
  assert.equal(empty.children.length, population.children.length);
});

test('history polling is independent, throttled to five minutes, pauses hidden and retries stale visibility', async () => {
  let time = 0, hidden = false, calls = 0, updates = 0, fail = false;
  const pending = [];
  const poll = createHistoryPoller({ now: () => time, isHidden: () => hidden,
    fetchHistory: async (url, options) => {
      calls++; assert.equal(url, '/api/player-history'); assert.equal(options.cache, 'no-store');
      await new Promise(resolve => pending.push(resolve));
      return { ok: !fail, json: async () => ({ startAt: 0, bucketMs: 1800000, histories: { '8.8.8.8:27015': points() } }) };
    }, onHistory: () => { updates++; } });
  let request = poll(); await poll(); assert.equal(calls, 1);
  pending.shift()(); await request; assert.equal(updates, 1);
  for (let i = 0; i < 9; i++) { time += 30000; await poll(); }
  assert.equal(calls, 1);
  time = HISTORY_REFRESH_MS; hidden = true; await poll(); assert.equal(calls, 1);
  hidden = false; request = poll(); pending.shift()(); await request; assert.equal(calls, 2);
  time += HISTORY_REFRESH_MS; fail = true; request = poll(); pending.shift()(); await request;
  assert.equal(calls, 3); assert.equal(updates, 2);
  time += HISTORY_REFRESH_MS; fail = false; request = poll(); pending.shift()(); await request;
  assert.equal(updates, 3);
});

test('CSS keeps charts inside the existing count line at desktop and mobile sizes with safe rendering', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/js/player-history.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(css, /\.population-top\s*\{[^}]*display:flex;[^}]*align-items:center;[^}]*flex-wrap:nowrap;[^}]*height:30px;/);
  assert.match(css, /\.player-sparkline\s*\{[^}]*width:60px;[^}]*height:24px;/);
  assert.match(css, /@media\(max-width:640px\)[\s\S]*\.player-sparkline\s*\{[^}]*width:54px;[^}]*height:22px;/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML/);
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.4.0'); assert.equal(lock.version, pkg.version); assert.equal(lock.packages[''].version, pkg.version);
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['express', 'gamedig', 'helmet', 'maxmind', 'proxy-addr']);
  assert.match(app, /void pollHistory\(\); setInterval\(pollHistory, HISTORY_REFRESH_MS\)/);
  assert.match(app, /visibilitychange[\s\S]*void pollHistory\(\)/);
  assert.doesNotMatch(app.slice(app.indexOf('async function poll()'), app.indexOf("$('filters').addEventListener")), /pollHistory|player-history/);
});
