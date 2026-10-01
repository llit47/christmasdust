import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseAddress } from '../utils/address.js';

export const SAMPLE_MS = 300000;
export const HISTORY_MS = 1800000;
export const HISTORY_POINTS = 48;
export const RETENTION_MS = 7 * 86400000;

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
    if (!Number.isInteger(players) || players < 0 || players > 65535 ||
      !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid player sample');
    const serverId = parseAddress(id).id;
    const bucket = Math.floor(timestamp / SAMPLE_MS) * SAMPLE_MS;
    // Only this bucket's endpoints are cached; this never retains a query registry.
    if (bucket !== this.sampleBucket) { this.sampleBucket = bucket; this.sampled.clear(); }
    if (this.sampled.has(serverId)) return;
    this.insert.run(serverId, bucket, players);
    this.sampled.add(serverId);
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
