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
  return { document, list, order, button, setFailure: () => { fail = true; },
    holdVote: () => { heldVote = new Promise(resolve => { releaseVote = resolve; }); },
    releaseVote: () => { releaseVote(); heldVote = null; }, voteReads: () => voteReads,
    snapshotReads: () => snapshotReads,
    poll: async next => { snapshot = next; document.listeners.visibilitychange(); await delay(0); },
    leave: async target => { document.activeElement = target; document.listeners.focusout(); await delay(5); } };
}

test('partial ratings snapshot ignores fallback zeros in Recommended and resumes ratings on recovery', async () => {
  const [first, second, favorite] = ['8.8.8.8:27015', '9.9.9.9:27015', '4.4.4.4:27015'];
  const rows = [first, second, favorite].map((id, index) => ({ id, name: id, map: 'de_xmas',
    players: index === 0 ? 8 : 1, maxPlayers: 32, status: 'online', stale: false,
    classification: { confidence: 'high', score: index === 2 ? 1 : 12 },
    ratings: { up: 0, down: index === 0 ? 1 : 10, vote: null } }));
  const snapshot = { servers: rows, visitor: {}, meta: { ratingsPartial: false }, version: 'test' };
  const ui = await fixture('recommended', { initialSnapshot: snapshot, favoriteIds: [favorite] });
  assert.deepEqual(ui.order(), [favorite, first, second]);

  const partial = structuredClone(snapshot);
  partial.meta.ratingsPartial = true;
  // The first read succeeded with a negative rating; the rest fell back to zeros.
  for (const row of partial.servers.slice(1)) row.ratings = { up: 0, down: 0, vote: null };
  assert.deepEqual(dependencies.rankServers(partial.servers, { favoriteIds: new Set([favorite]) }).map(row => row.id),
    [favorite, second, first]); // Without the flag, fallback zeros incorrectly promote the second server.
  await ui.poll(partial);
  assert.deepEqual(ui.order(), [favorite, first, second]);

  const recovered = structuredClone(snapshot);
  recovered.servers[1].ratings = { up: 2, down: 0, vote: null };
  await ui.poll(recovered);
  assert.deepEqual(ui.order(), [favorite, second, first]);
  assert.equal(ui.snapshotReads(), 3);
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
