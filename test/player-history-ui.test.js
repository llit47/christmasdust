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

const marks = svg => svg.children.filter(node => ['path', 'circle'].includes(node.tag));

test('native SVG splits null gaps and keeps measured zero at the fixed capacity baseline', () => {
  const history = points(); history.splice(0, 6, 0, 16, null, 32, 0, null);
  const svg = playerSparkline(document, history, 32);
  assert.equal(svg.ns, 'http://www.w3.org/2000/svg');
  assert.equal(svg.attributes.role, 'img');
  assert.match(svg.attributes['aria-label'], /scale 0 to 32 players; gaps indicate missing samples/);
  assert.equal(svg.children[0].textContent, svg.attributes['aria-label']);
  const paths = marks(svg);
  assert.equal(paths.length, 2);
  assert.equal(paths[0].attributes.d, 'M1.00,23.00 L2.02,12.00');
  assert.equal(paths[1].attributes.d, 'M4.06,1.00 L5.09,23.00');
  const zeros = points(); zeros[0] = zeros[1] = 0;
  assert.equal(marks(playerSparkline(document, zeros, 32))[0].attributes.d, 'M1.00,23.00 L2.02,23.00');
  const low = points(); low[0] = 1; low[1] = 2;
  assert.match(marks(playerSparkline(document, low, 32))[0].attributes.d, /22.31.*21.63/);
  // Changing only capacity changes Y positions; low counts never stretch to the chart top.
  assert.match(marks(playerSparkline(document, low, 64))[0].attributes.d, /22.66.*22.31/);
  assert.deepEqual(svg.children.filter(node => node.tag === 'text').map(node => node.textContent), ['32', '16', '0']);
  assert.deepEqual(svg.children.filter(node => node.tag === 'line').map(node => node.attributes.y1), ['1', '12', '23']);
  assert.deepEqual(playerSparkline(document, low, 33).children.filter(node => node.tag === 'text').map(node => node.textContent),
    ['33', '16.5', '0']);
});

test('single sample and isolated samples render dots without connecting across null gaps', () => {
  for (const value of [0, 16, 32]) {
    const history = points(); history[24] = value;
    const drawn = marks(playerSparkline(document, history, 32));
    assert.equal(drawn.length, 1);
    assert.equal(drawn[0].tag, 'circle');
    assert.equal(drawn[0].attributes.cy, String(23 - value / 32 * 22) + '.00');
  }
  const history = points(); history[0] = 0; history[2] = 16; history[47] = 32;
  const svg = playerSparkline(document, history, 32);
  assert.equal(svg.attributes.viewBox, '0 0 60 24');
  assert.deepEqual(marks(svg).map(node => [node.tag, node.attributes.cx, node.attributes.cy]), [
    ['circle', '1.00', '23.00'], ['circle', '3.04', '12.00'], ['circle', '49.00', '1.00']
  ]);
});

test('singleton dots and contiguous paths coexist without crossing gaps', () => {
  const history = points(); history[0] = 0; history[2] = 16; history[3] = 32; history[47] = 0;
  const drawn = marks(playerSparkline(document, history, 32));
  assert.deepEqual(drawn.map(node => node.tag), ['circle', 'path', 'circle']);
  assert.equal(drawn[1].attributes.d, 'M3.04,12.00 L4.06,1.00');
  assert.equal(drawn[0].attributes.cy, '23.00');
  assert.equal(drawn[2].attributes.cy, '23.00');
});

test('missing, invalid or empty history shows a compact no-data state instead of a line', () => {
  for (const history of [undefined, null, [], points(), ['<script>'], Array(48).fill(NaN)]) {
    const empty = playerSparkline(document, history, 32);
    assert.equal(empty.tag, 'span');
    assert.equal(empty.textContent, 'No data');
    assert.equal(empty.attributes.class, 'player-sparkline player-sparkline-empty');
    assert.equal(empty.attributes['aria-label'], '24 hour player history: no data');
    assert.deepEqual(empty.children, []);
  }
  const history = points(); history[0] = 1;
  // Unknown capacity must not cause a per-server auto-scale.
  for (const capacity of [undefined, 0, NaN]) assert.equal(playerSparkline(document, history, capacity).textContent, 'No data');
});

test('pointer targets show sample times and players/capacity, including zero, but skip missing samples', () => {
  const history = points(); history[0] = 0; history[2] = 16;
  const window = { startAt: Date.UTC(2026, 9, 1, 12), bucketMs: 1800000 };
  const svg = playerSparkline(document, history, 32, window);
  const targets = svg.children.filter(node => node.tag === 'rect');
  assert.equal(targets.length, 2);
  for (const [target, index] of targets.map((target, i) => [target, i * 2])) {
    const time = new Date(window.startAt + index * window.bucketMs).toLocaleString([], {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
    assert.equal(target.children[0].tag, 'title');
    assert.equal(target.children[0].textContent, `${time} · ${history[index]}/32 players (average)`);
    assert.equal(target.attributes.height, '24');
    assert.equal(target.attributes.class, 'sparkline-sample');
  }
  assert.equal(playerSparkline(document, history, 32).children.some(node => node.tag === 'rect'), false);
});

test('sample tooltips round averages to at most one decimal and keep integers clean', () => {
  const history = points();
  history.splice(0, 6, 0, 12, 1 / 3, 12.96, 12.04, 12.25);
  const svg = playerSparkline(document, history, 32, { startAt: 0, bucketMs: 1800000 });
  const tooltips = svg.children.filter(node => node.tag === 'rect').map(node => node.children[0].textContent);
  assert.deepEqual(tooltips.map(text => text.split(' · ')[1]), [
    '0/32 players (average)', '12/32 players (average)', '0.3/32 players (average)',
    '13/32 players (average)', '12/32 players (average)', '12.3/32 players (average)'
  ]);
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

test('oversized reported player counts stay intact beside the chart and open slots remain nonnegative', async () => {
  const history = points(); history[0] = 0; history[1] = 12;
  for (const [players, slots] of [[65535, 0], [0, 32]]) {
    const server = { id: '8.8.8.8:27015', name: 'Christmas', players, maxPlayers: 32,
      status: 'online', classification: { confidence: 'high' } };
    const population = nodes(serverCard(document, server, { history })).find(node => node.className === 'population');
    assert.equal(population.children[0].children[0].textContent, `${players}/32`);
    assert.equal(population.children[0].children[1].tag, 'svg');
    assert.equal(population.children[1].textContent, `${slots} open slots`);
  }
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.population\s*\{[^}]*min-width:0;/);
  assert.match(css, /\.player-sparkline\s*\{[^}]*flex:0 1 60px;[^}]*min-width:0;/);
  assert.match(css, /\.population strong\s*\{[^}]*flex:0 0 auto;[^}]*white-space:nowrap;/);
  assert.match(css, /\.server\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) 125px 235px;/);
  assert.match(css, /@media\(max-width:950px\)[\s\S]*grid-template-columns:minmax\(0,1fr\) 110px 210px;/);
  assert.match(css, /@media\(max-width:640px\)[\s\S]*grid-template-columns:minmax\(0,1fr\) 118px;/);
});

test('history polling is independent, throttled to five minutes, pauses hidden and retries stale visibility', async () => {
  let time = 0, hidden = false, calls = 0, updates = 0, fail = false;
  const pending = [];
  const poll = createHistoryPoller({ now: () => time, isHidden: () => hidden,
    fetchHistory: async (url, options) => {
      calls++; assert.equal(url, '/api/player-history'); assert.equal(options.cache, 'no-store');
      await new Promise(resolve => pending.push(resolve));
      return { ok: !fail, json: async () => ({ startAt: 0, bucketMs: 1800000, histories: { '8.8.8.8:27015': points() } }) };
    }, onHistory: (histories, window) => {
      assert.deepEqual(histories, { '8.8.8.8:27015': points() });
      assert.deepEqual(window, { startAt: 0, bucketMs: 1800000 });
      updates++;
    } });
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
