import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

export const groupEndpointIds = server => [...new Set([server.id, ...(server.duplicateEndpoints ?? [])])];

export class RatingsStore {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS ratings (
        server_id TEXT NOT NULL, voter_hash TEXT NOT NULL,
        value INTEGER NOT NULL CHECK(value IN (-1, 1)),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(server_id, voter_hash)
      );`);
  }
  totals(ids, voterHash = null) {
    const rows = this.db.prepare(`SELECT * FROM ratings WHERE server_id IN (${ids.map(() => '?').join(',')})
      ORDER BY updated_at DESC, created_at DESC, server_id ASC`).all(...ids);
    const voters = new Map();
    for (const row of rows) if (!voters.has(row.voter_hash)) voters.set(row.voter_hash, row.value);
    return { up: [...voters.values()].filter(value => value === 1).length,
      down: [...voters.values()].filter(value => value === -1).length, vote: voters.get(voterHash) ?? null };
  }
  mutate(ids, serverId, voterHash, value, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT created_at FROM ratings WHERE server_id = ? AND voter_hash = ?').get(serverId, voterHash);
      this.db.prepare(`DELETE FROM ratings WHERE server_id IN (${ids.map(() => '?').join(',')}) AND voter_hash = ?`).run(...ids, voterHash);
      if (value !== null) this.db.prepare('INSERT INTO ratings VALUES (?, ?, ?, ?, ?)').run(serverId, voterHash, value, old?.created_at ?? now, now);
      const result = this.totals(ids, voterHash);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
