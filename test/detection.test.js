import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CURRENT_TERM_LIMIT, DETECTION_VERSION, migrateDetection, serializeDetection, validateDetection } from '../src/config/detection.js';
import { loadDetection } from '../src/config/index.js';

const legacy = { strong: ['christmas', 'xmas', 'santa', 'noel', 'weihnacht', 'swieta'],
  weak: ['winter', 'snow', 'snowy'], include: [], exclude: [] };
const fresh = JSON.parse(await readFile(new URL('../config/detection.json', import.meta.url), 'utf8'));

test('untouched legacy defaults migrate to fresh-install semantics', () => {
  const { config, changed } = migrateDetection(legacy);
  assert.equal(changed, true); assert.equal(config.version, DETECTION_VERSION);
  for (const field of ['strong', 'related', 'weak']) assert.deepEqual(new Set(config[field]), new Set(fresh[field]));
  assert.deepEqual(config.include, fresh.include); assert.deepEqual(config.exclude, fresh.exclude);
  assert.equal(validateDetection(config), DETECTION_VERSION);
  assert.equal(serializeDetection(config), serializeDetection(migrateDetection(legacy).config));
});
test('legacy custom terms and exact include/exclude strings survive without normalized duplicates', () => {
  const input = { ...legacy, strong: [...legacy.strong, 'mychristmasserver', 'X_MAS'],
    weak: [...legacy.weak, 'mywinterterm'], include: ['8.8.8.8:27015'], exclude: ['1.1.1.1:27016'] };
  const { config } = migrateDetection(input);
  assert.ok(config.strong.includes('mychristmasserver'));
  assert.ok(config.weak.includes('mywinterterm'));
  assert.equal(config.strong.includes('santa'), false);
  assert.ok(config.related.includes('santa'));
  assert.equal(config.strong.includes('X_MAS'), false);
  assert.deepEqual(config.include, input.include); assert.deepEqual(config.exclude, input.exclude);
});
test('transitional unversioned related terms also migrate without losing custom entries', () => {
  const input = { ...legacy, related: ['myholidayterm', 'santa'] };
  const { config } = migrateDetection(input);
  assert.ok(config.related.includes('myholidayterm'));
  assert.equal(config.related.filter(term => term === 'santa').length, 1);
  assert.equal(config.version, DETECTION_VERSION);
});
test('maximum-size legacy term arrays migrate without dropping custom terms', () => {
  const terms = prefix => Array.from({ length: 1000 }, (_, index) => `${prefix}${index}`);
  const strong = terms('customstrong');
  const related = terms('customrelated');
  const weak = terms('customweak');
  strong[0] = 'santa';
  const { config } = migrateDetection({ strong, related, weak, include: [], exclude: [] });
  for (const term of strong.slice(1)) assert.ok(config.strong.includes(term));
  for (const term of related) assert.ok(config.related.includes(term));
  for (const term of weak) assert.ok(config.weak.includes(term));
  assert.ok(config.strong.includes('weihnachten'));
  assert.ok(config.related.includes('santa'));
  assert.ok(config.related.includes('jinglebells'));
  for (const term of ['holiday', 'ice', 'frozen']) assert.ok(config.weak.includes(term));
  assert.equal(config.weak.length, CURRENT_TERM_LIMIT);
  assert.equal(validateDetection(config), DETECTION_VERSION);
});
test('normalized duplicates and already-present defaults do not consume migration capacity', () => {
  const weak = Array.from({ length: 998 }, (_, index) => `operatorweak${index}`);
  weak.push('HOLIDAY', 'ice');
  const { config } = migrateDetection({ ...legacy, weak, strong: [...legacy.strong, 'X_MAS'] });
  assert.equal(config.strong.filter(term => /^x[_-]?mas$/i.test(term)).length, 1);
  assert.ok(config.weak.includes('HOLIDAY'));
  assert.equal(config.weak.includes('holiday'), false);
  assert.equal(config.weak.length, 1001);
  assert.equal(validateDetection(config), DETECTION_VERSION);
});
test('current schema accepts migration headroom but rejects entries beyond it', () => {
  const weak = Array.from({ length: CURRENT_TERM_LIMIT }, (_, index) => `weak${index}`);
  assert.equal(validateDetection({ ...fresh, weak }), DETECTION_VERSION);
  assert.throws(() => validateDetection({ ...fresh, weak: [...weak, 'extra'] }), /Invalid detection weak/);
});
test('current configuration migration is a no-op and leaves source untouched', () => {
  const input = structuredClone(fresh); const before = JSON.stringify(input);
  assert.deepEqual(migrateDetection(input), { config: input, changed: false });
  assert.equal(JSON.stringify(input), before);
});
test('invalid legacy, unknown keys, and unsupported versions fail explicitly', () => {
  for (const input of [{ ...legacy, weak: [''] }, { ...legacy, include: ['127.0.0.1:27015'] },
    { ...legacy, extra: true }, { ...fresh, extra: true }, { ...legacy, version: null },
    { ...fresh, version: 3 }, { ...fresh, version: '2' },
    { ...fresh, related: [...fresh.related, 'SANTA'] }]) assert.throws(() => migrateDetection(input));
  assert.throws(() => migrateDetection({ ...legacy, version: 1, related: [''] }), /Invalid detection related/);
});
test('runtime loader accepts legacy in memory without rewriting and rejects future schema', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'christmasdust-detection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'detection.json'); const bytes = serializeDetection(legacy);
  await writeFile(path, bytes);
  const loaded = await loadDetection(path);
  assert.equal(loaded.version, DETECTION_VERSION);
  assert.ok(loaded.strong.includes('weihnachten'));
  assert.equal(await readFile(path, 'utf8'), bytes);
  await writeFile(path, serializeDetection({ ...fresh, version: 99 }));
  await assert.rejects(loadDetection(path), /Unsupported detection version/);
});
