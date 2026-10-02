import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PlayerStatsStore, SAMPLE_MS, SAMPLE_BATCH_SIZE, HISTORY_MS, RETENTION_MS } from '../src/storage/player-stats.js';

const a = '8.8.8.8:27015', b = '1.1.1.1:27015';
const now = 100 * 86400000 + 1200000;
function store(t) { const stats = new PlayerStatsStore(':memory:'); t.after(() => stats.close()); return stats; }

test('aligned five-minute samples keep the first measurement, including zero, without repeated writes', t => {
  const stats = store(t);
  stats.record(a, 0, SAMPLE_MS + 1); stats.record(a, 10, 2 * SAMPLE_MS - 1);
  stats.record(a, 20, 2 * SAMPLE_MS); stats.record(b, 8, 2 * SAMPLE_MS);
  const rows = stats.db.prepare('SELECT * FROM player_samples ORDER BY bucket_at, server_id').all().map(row => ({ ...row }));
  assert.deepEqual(rows, [{ server_id: a, bucket_at: SAMPLE_MS, players: 0 },
    { server_id: b, bucket_at: 2 * SAMPLE_MS, players: 8 }, { server_id: a, bucket_at: 2 * SAMPLE_MS, players: 20 }]);
  let writes = 0; const insert = stats.insert;
  stats.insert = { run: (...args) => { writes++; return insert.run(...args); } };
  stats.record(a, 30, 2 * SAMPLE_MS + 1); assert.equal(writes, 0);
  stats.record(a, 4, 3 * SAMPLE_MS); assert.equal(writes, 1);
  assert.equal(stats.sampled.size, 1); // Old endpoint cache disappears at the next bucket.
  for (const count of [undefined, null, NaN, -1, 1.5, 65536]) assert.throws(() => stats.record(a, count, now));
  assert.throws(() => stats.record('127.0.0.1:27015', 3, now));
});

test('history averages measured samples into 48 half hours, preserves zero and exposes explicit gaps', t => {
  const stats = store(t);
  const { startAt } = stats.history([a], now);
  stats.record(a, 100, startAt - SAMPLE_MS); // Outside the window.
  stats.record(a, 0, startAt); stats.record(a, 12, startAt + SAMPLE_MS);
  stats.record(a, 0, startAt + 2 * HISTORY_MS);
  stats.record(a, 9, now); stats.record(b, 22, now);
  const data = stats.history([a, a, b], now);
  assert.equal(data.startAt % HISTORY_MS, 0); assert.equal(data.bucketMs, HISTORY_MS);
  assert.equal(data.startAt + 48 * HISTORY_MS, Math.floor(now / HISTORY_MS) * HISTORY_MS + HISTORY_MS);
  assert.equal(data.histories[a].length, 48);
  assert.deepEqual(data.histories[a].slice(0, 4), [6, null, 0, null]);
  assert.equal(data.histories[a][47], 9); assert.equal(data.histories[b][47], 22);
  assert.ok(data.histories[b].slice(0, 47).every(value => value === null));
  let reads = 0; const read = stats.read;
  stats.read = { all: (...args) => { reads++; return read.all(...args); } };
  assert.deepEqual(stats.history([b, a], now), data); assert.equal(reads, 1);
  assert.deepEqual(stats.history([], now).histories, {}); assert.equal(reads, 1);
});

test('cleanup is periodic, bounded and preserves seven days including the boundary', t => {
  const stats = store(t), cutoff = now - RETENTION_MS;
  stats.record(a, 1, cutoff - SAMPLE_MS); stats.record(a, 0, cutoff); stats.record(b, 2, now);
  stats.prune(now);
  assert.deepEqual(stats.db.prepare('SELECT bucket_at FROM player_samples ORDER BY bucket_at').all().map(row => row.bucket_at),
    [Math.floor(cutoff / SAMPLE_MS) * SAMPLE_MS, Math.floor(now / SAMPLE_MS) * SAMPLE_MS]);
  let cleanups = 0; const cleanup = stats.cleanup;
  stats.cleanup = { run: (...args) => { cleanups++; return cleanup.run(...args); } };
  stats.prune(now + 1); assert.equal(cleanups, 0);
  stats.prune(now + SAMPLE_MS); assert.equal(cleanups, 1);
  stats.db.exec(`WITH RECURSIVE counts(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counts WHERE n<10001)
    INSERT INTO player_samples SELECT '8.8.8.8:' || n, 0, 1 FROM counts`);
  stats.prune(now + 2 * SAMPLE_MS);
  assert.equal(stats.db.prepare('SELECT COUNT(*) AS n FROM player_samples WHERE bucket_at=0').get().n, 1);
});

test('history persists after close/reopen, uniqueness survives restart and files have ratings-style permissions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'christmasdust-stats-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested/player-stats.sqlite');
  let stats = new PlayerStatsStore(path); stats.record(a, 0, now); stats.close();
  stats = new PlayerStatsStore(path); t.after(() => stats.close());
  stats.record(a, 22, now + 1); stats.record(a, 12, now + SAMPLE_MS);
  assert.equal(stats.db.prepare('SELECT COUNT(*) AS n FROM player_samples').get().n, 2);
  assert.equal(stats.history([a], now + SAMPLE_MS).histories[a][47], 6);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, 'nested'))).mode & 0o777, 0o750);
});

test('sample writes use bounded transactions, preserving first samples and avoiding repeat transactions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'christmasdust-stats-batch-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const stats = new PlayerStatsStore(join(dir, 'stats.sqlite')); t.after(() => stats.close());
  const observer = new PlayerStatsStore(join(dir, 'stats.sqlite')); t.after(() => observer.close());
  const samples = Array.from({ length: SAMPLE_BATCH_SIZE * 2 + 3 }, (_, index) =>
    ({ id: `8.8.8.8:${27015 + index}`, players: index % 33, timestamp: now }));
  const commands = [], visibleCounts = [];
  const exec = stats.db.exec.bind(stats.db), insert = stats.insert;
  stats.db.exec = sql => { commands.push(sql); return exec(sql); };
  stats.insert = { run: (...args) => {
    visibleCounts.push(observer.db.prepare('SELECT COUNT(*) AS n FROM player_samples').get().n);
    return insert.run(...args);
  } };
  stats.recordMany([...samples, { ...samples[0], players: 32 }]);
  assert.deepEqual(commands, Array(3).fill(['BEGIN IMMEDIATE', 'COMMIT']).flat());
  assert.deepEqual(visibleCounts, samples.map((_, index) => Math.floor(index / SAMPLE_BATCH_SIZE) * SAMPLE_BATCH_SIZE));
  assert.equal(observer.db.prepare('SELECT COUNT(*) AS n FROM player_samples').get().n, samples.length);
  assert.equal(observer.db.prepare('SELECT players FROM player_samples WHERE server_id=?').get(samples[0].id).players, 0);
  stats.recordMany(samples.map(sample => ({ ...sample, players: 10 })));
  assert.equal(commands.length, 6); assert.equal(visibleCounts.length, samples.length);
});

test('insert and commit failures roll back samples without poisoning deduplication or later retries', t => {
  for (const failure of ['insert', 'commit']) {
    const stats = store(t), insert = stats.insert, exec = stats.db.exec.bind(stats.db);
    const samples = [{ id: a, players: 0, timestamp: now }, { id: b, players: 12, timestamp: now }];
    if (failure === 'insert') stats.insert = { run: (...args) => {
      if (args[0] === b) throw Error('Insert failure');
      return insert.run(...args);
    } };
    else stats.db.exec = sql => { if (sql === 'COMMIT') throw Error('Commit failure'); return exec(sql); };
    assert.throws(() => stats.recordMany(samples), /failure/);
    assert.equal(stats.db.prepare('SELECT COUNT(*) AS n FROM player_samples').get().n, 0);
    assert.equal(stats.sampled.size, 0);
    stats.insert = insert; stats.db.exec = exec;
    stats.recordMany(samples);
    assert.deepEqual(stats.db.prepare('SELECT players FROM player_samples ORDER BY server_id').all().map(row => row.players), [12, 0]);
  }
});

test('later batch failures preserve earlier commits and retry only uncommitted samples', t => {
  const stats = store(t), insert = stats.insert;
  const samples = Array.from({ length: SAMPLE_BATCH_SIZE + 1 }, (_, index) =>
    ({ id: `8.8.8.8:${27015 + index}`, players: index % 33, timestamp: now }));
  stats.insert = { run: (...args) => {
    if (args[0] === samples.at(-1).id) throw Error('Later batch failure');
    return insert.run(...args);
  } };
  assert.throws(() => stats.recordMany(samples), /Later batch failure/);
  assert.equal(stats.db.prepare('SELECT COUNT(*) AS n FROM player_samples').get().n, SAMPLE_BATCH_SIZE);
  let retries = 0;
  stats.insert = { run: (...args) => { retries++; return insert.run(...args); } };
  stats.recordMany(samples);
  assert.equal(retries, 1);
  assert.equal(stats.db.prepare('SELECT COUNT(*) AS n FROM player_samples').get().n, samples.length);
});
