import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const source = await readFile(new URL('../public/js/app.js', import.meta.url), 'utf8');
const dependencies = {};
for (const match of source.matchAll(/^import \{ ([^}]+) \} from '([^']+)';$/gm)) {
  const module = await import(new URL(`../public/js/${match[2]}`, import.meta.url));
  for (const name of match[1].split(', ')) dependencies[name] = module[name];
}
const nodes = root => [root, ...root.children.flatMap(nodes)];

async function fixture(sort = 'recommended', { initialSnapshot, favoriteIds = [] } = {}) {
  const elements = new Map();
  const document = { hidden: false, listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, this.createElement('div'));
      return elements.get(id);
    },
    createElement(tag) {
      return { tag, children: [], listeners: {}, attributes: {}, value: '', checked: false, rebuilds: 0,
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, callback) { this.listeners[name] = callback; },
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; this.rebuilds++; },
        get firstChild() { return this.children[0]; },
        contains(node) { return nodes(this).includes(node); },
        focus() { document.activeElement = this; },
        set disabled(value) {
          this.isDisabled = value;
          if (value && document.activeElement === this) {
            document.activeElement = document.body;
            document.listeners.focusout?.();
          }
        },
        get disabled() { return this.isDisabled; }
      };
    }
  };
  document.body = document.createElement('body'); document.activeElement = document.body;
  const rows = ['8.8.8.8:27015', '9.9.9.9:27015'].map(id => ({ id, name: id, map: 'de_xmas',
    players: 1, maxPlayers: 32, status: 'online', stale: false, classification: { confidence: 'high', score: 12 } }));
  let snapshot = initialSnapshot ?? { servers: rows, visitor: {}, meta: {}, version: 'test' };
  let fail = false, snapshotReads = 0, voteReads = 0, heldVote, releaseVote;
  runInNewContext(source.replace(/^import .*;\n/gm, ''), {
    ...dependencies, document, navigator: {}, AbortSignal,
    localStorage: { getItem: key => key.endsWith('preferences') ? JSON.stringify({ sort }) : key.endsWith('favorites') ? JSON.stringify(favoriteIds) : null, setItem() {} },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    fetch: async path => {
      if (path === '/api/player-history') return { ok: false };
      if (path === '/api/ratings') {
        voteReads++;
        if (heldVote) await heldVote;
        return { ok: !fail, status: fail ? 500 : 200,
          json: async () => ({ ratings: { up: 1, down: 0, vote: 1 } }) };
      }
      snapshotReads++;
      return { ok: true, json: async () => structuredClone(snapshot) };
    }
  });
  await delay(0);
  const list = document.getElementById('servers');
  const order = () => list.children.map(card => nodes(card).find(node => node.tag === 'h3').textContent);
  const button = nodes(list.children[1]).find(node => node.textContent === '👍 0');
  const counts = id => nodes(list.children.find(card => nodes(card).some(node => node.tag === 'h3' && node.textContent === id)))
    .filter(node => node.tag === 'button' && /^[👍👎]/u.test(node.textContent ?? '')).map(node => node.textContent);
  return { document, list, order, counts, button, setFailure: () => { fail = true; },
    holdVote: () => { heldVote = new Promise(resolve => { releaseVote = resolve; }); },
    releaseVote: () => { releaseVote(); heldVote = null; }, voteReads: () => voteReads,
    snapshotReads: () => snapshotReads,
    poll: async next => { snapshot = next; document.listeners.visibilitychange(); await delay(0); },
    leave: async target => { document.activeElement = target; document.listeners.focusout(); await delay(5); } };
}

const ratingSnapshot = (totals, ratingsPartial = false) => ({
  servers: totals.map((ratings, index) => ({ id: `8.8.8.${index + 1}:27015`, name: `8.8.8.${index + 1}:27015`,
    map: 'de_xmas', players: 8 - index, maxPlayers: 32, status: 'online', stale: false,
    classification: { confidence: 'high', score: 12 }, ratings })),
  visitor: {}, meta: { ratingsPartial }, version: 'test'
});
const totals = (up, down = 0) => ({ up, down, vote: null });

test('A/B successful reads still rank by ratings when C fails; zeros and unavailable remain distinct', async () => {
  const partial = ratingSnapshot([totals(0, 2), totals(3), null], true);
  const [a, b, c] = partial.servers.map(row => row.id);
  const ui = await fixture('recommended', { initialSnapshot: partial });
  // B beats A despite fewer players; unavailable C is neutral.
  assert.deepEqual(ui.order(), [b, c, a]);
  assert.deepEqual(ui.counts(c), ['👍 —', '👎 —']);
  // A fresh successful zero total replaces B's positive rating during another partial poll.
  await ui.poll(ratingSnapshot([totals(0, 2), totals(0), null], true));
  assert.deepEqual(ui.order(), [b, c, a]);
  assert.deepEqual(ui.counts(b), ['👍 0', '👎 0']);
  assert.deepEqual(ui.counts(c), ['👍 —', '👎 —']);
});

test('failed/skipped reads retain last-good snapshot ratings and recovery replaces them', async () => {
  const initial = ratingSnapshot([totals(1), totals(0), totals(10), totals(0, 10), totals(0)]);
  const [a, b, c, d, favorite] = initial.servers.map(row => row.id);
  const ui = await fixture('recommended', { initialSnapshot: initial, favoriteIds: [favorite] });
  assert.deepEqual(ui.order(), [favorite, c, a, b, d]);

  const partial = ratingSnapshot([totals(6), totals(0), null, null, null, null], true);
  const newcomer = partial.servers[5].id;
  await ui.poll(partial);
  assert.deepEqual(ui.order(), [favorite, c, a, b, newcomer, d]);
  assert.deepEqual(ui.counts(a), ['👍 6', '👎 0']);
  assert.deepEqual(ui.counts(c), ['👍 10', '👎 0']);
  assert.deepEqual(ui.counts(d), ['👍 0', '👎 10']);
  assert.deepEqual(ui.counts(b), ['👍 0', '👎 0']);
  assert.deepEqual(ui.counts(newcomer), ['👍 —', '👎 —']);
  // A second partial poll must preserve the values already carried into the snapshot.
  await ui.poll(partial);
  assert.deepEqual(ui.order(), [favorite, c, a, b, newcomer, d]);

  const recovered = ratingSnapshot([totals(6), totals(0), totals(0, 20), totals(20), totals(0), totals(0)]);
  await ui.poll(recovered);
  assert.deepEqual(ui.order(), [favorite, d, a, b, newcomer, c]);
  assert.deepEqual(ui.counts(c), ['👍 0', '👎 20']);
  assert.deepEqual(ui.counts(d), ['👍 20', '👎 0']);
  assert.deepEqual(ui.counts(newcomer), ['👍 0', '👎 0']);
  assert.equal(ui.snapshotReads(), 4);
});

test('successful Recommended vote re-sorts once on focus exit without polling or replacing the focused button', async () => {
  const ui = await fixture();
  const initialOrder = ui.order(); const rebuilds = ui.list.rebuilds;
  ui.button.focus();
  await ui.button.listeners.click();
  assert.equal(ui.document.activeElement, ui.button);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.button.textContent, '👍 1');
  assert.deepEqual(ui.order(), initialOrder);
  assert.equal(ui.list.rebuilds, rebuilds);
  // Moving between controls inside a card still preserves the interaction.
  await ui.leave(nodes(ui.list.children[1]).find(node => node.textContent === '👎 0'));
  assert.equal(ui.list.rebuilds, rebuilds);
  await ui.leave(ui.document.body);
  assert.deepEqual(ui.order(), [...initialOrder].reverse());
  assert.equal(ui.list.rebuilds, rebuilds + 1);
  await ui.leave(ui.document.body);
  assert.equal(ui.list.rebuilds, rebuilds + 1);
  assert.equal(ui.snapshotReads(), 1);
});

test('successful Recommended vote re-sorts immediately when focus has already left', async () => {
  const ui = await fixture(); const initialOrder = ui.order();
  await ui.button.listeners.click();
  assert.deepEqual(ui.order(), [...initialOrder].reverse());
  assert.equal(ui.snapshotReads(), 1);
});

test('another vote while a re-sort is pending keeps focus and blocks repeated submissions', async () => {
  const ui = await fixture(); const rebuilds = ui.list.rebuilds;
  ui.button.focus(); await ui.button.listeners.click();
  ui.holdVote();
  const mutation = ui.button.listeners.click();
  await ui.button.listeners.click();
  await delay(5);
  assert.equal(ui.document.activeElement, ui.button);
  assert.equal(ui.button.attributes['aria-disabled'], 'true');
  assert.equal(ui.voteReads(), 2);
  assert.equal(ui.list.rebuilds, rebuilds);
  ui.releaseVote(); await mutation;
  await ui.leave(ui.document.body);
  assert.equal(ui.list.rebuilds, rebuilds + 1);
});

test('failed vote does not re-render or queue a re-sort on focus exit', async () => {
  const ui = await fixture(); const initialOrder = ui.order(); const rebuilds = ui.list.rebuilds;
  ui.setFailure(); ui.button.focus();
  await ui.button.listeners.click();
  assert.equal(ui.button.textContent, '👍 0');
  assert.equal(ui.document.activeElement, ui.button);
  await ui.leave(ui.document.body);
  assert.deepEqual(ui.order(), initialOrder);
  assert.equal(ui.list.rebuilds, rebuilds);
});

for (const sort of ['players', 'proximity']) {
  test(`${sort}: successful rating changes do not re-render the list`, async () => {
    const ui = await fixture(sort);
    // Proximity is normally restored to Recommended without a location.
    ui.document.getElementById('sort').value = sort;
    const rebuilds = ui.list.rebuilds; const initialOrder = ui.order();
    ui.button.focus(); await ui.button.listeners.click();
    await ui.leave(ui.document.body);
    assert.deepEqual(ui.order(), initialOrder);
    assert.equal(ui.list.rebuilds, rebuilds);
  });
}
