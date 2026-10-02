import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseAddress } from '../utils/address.js';

export const SAMPLE_MS = 300000;
export const HISTORY_MS = 1800000;
export const HISTORY_POINTS = 48;
export const RETENTION_MS = 7 * 86400000;
export const SAMPLE_BATCH_SIZE = 128;

export class PlayerStatsStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    this.db = new DatabaseSync(path);
    try {
      if (path !== ':memory:') chmodSync(path, 0o600);
      this.db.exec(`PRAGMA busy_timeout = 100;
        CREATE TABLE IF NOT EXISTS player_samples (
          server_id TEXT NOT NULL, bucket_at INTEGER NOT NULL,
          players INTEGER NOT NULL CHECK(players BETWEEN 0 AND 65535),
          PRIMARY KEY(server_id, bucket_at)
        );
        CREATE INDEX IF NOT EXISTS player_samples_time ON player_samples(bucket_at);`);
      this.insert = this.db.prepare('INSERT OR IGNORE INTO player_samples VALUES (?, ?, ?)');
      this.cleanup = this.db.prepare(`DELETE FROM player_samples WHERE rowid IN (
        SELECT rowid FROM player_samples WHERE bucket_at < ? ORDER BY bucket_at LIMIT 10000)`);
      this.read = this.db.prepare(`SELECT server_id, CAST((bucket_at - ?) / ? AS INTEGER) AS point,
        AVG(players) AS players FROM player_samples
        WHERE server_id IN (SELECT value FROM json_each(?)) AND bucket_at >= ? AND bucket_at < ?
        GROUP BY server_id, point ORDER BY server_id, point`);
    } catch (error) { this.db.close(); throw error; }
    this.sampleBucket = null; this.sampled = new Set(); this.lastPruneAt = -Infinity;
  }
  record(id, players, timestamp = Date.now()) {
    this.recordMany([{ id, players, timestamp }]);
  }
  recordMany(samples) {
    const pending = [], seen = new Set();
    for (const { id, players, timestamp } of samples) {
      if (!Number.isInteger(players) || players < 0 || players > 65535 ||
        !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid player sample');
      const serverId = parseAddress(id).id;
      const bucket = Math.floor(timestamp / SAMPLE_MS) * SAMPLE_MS;
      const key = `${serverId}@${bucket}`;
      if ((bucket === this.sampleBucket && this.sampled.has(serverId)) || seen.has(key)) continue;
      seen.add(key); pending.push([serverId, bucket, players]);
    }
    for (let offset = 0; offset < pending.length; offset += SAMPLE_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + SAMPLE_BATCH_SIZE);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const sample of batch) this.insert.run(...sample);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch { /* SQLite may have already rolled back. */ }
        throw error;
      }
      // Cache only committed samples, so a rolled-back batch remains retryable.
      for (const [serverId, bucket] of batch) {
        if (bucket !== this.sampleBucket) { this.sampleBucket = bucket; this.sampled.clear(); }
        this.sampled.add(serverId);
      }
    }
  }
  prune(now = Date.now()) {
    if (now - this.lastPruneAt < SAMPLE_MS) return;
    this.cleanup.run(now - RETENTION_MS);
    this.lastPruneAt = now;
  }
  history(ids, now = Date.now()) {
    // Include the current partial half hour so a new measurement appears promptly.
    const endAt = (Math.floor(now / HISTORY_MS) + 1) * HISTORY_MS;
    const startAt = endAt - HISTORY_POINTS * HISTORY_MS;
    const endpoints = [...new Set(ids.map(id => parseAddress(id).id))].sort().slice(0, 5000);
    const histories = Object.fromEntries(endpoints.map(id => [id, Array(HISTORY_POINTS).fill(null)]));
    if (endpoints.length) {
      for (const row of this.read.all(startAt, HISTORY_MS, JSON.stringify(endpoints), startAt, endAt))
        histories[row.server_id][row.point] = row.players;
    }
    return { startAt, bucketMs: HISTORY_MS, histories };
  }
  close() { this.db.close(); }
}
