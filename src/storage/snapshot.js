import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseAddress } from '../utils/address.js';
export class SnapshotStore {
  constructor(path) { this.path = path; }
  async load() {
    let value;
    try { value = JSON.parse(await readFile(this.path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Snapshot unreadable'); }
    if (value.schema !== 1 || !Array.isArray(value.servers) || value.servers.length > 5000 || !value.state) throw new Error('Invalid snapshot schema');
    for (const row of value.servers) {
      if (parseAddress(row.id).ip !== row.ip || parseAddress(row.id).port !== row.port || !row.classification || !['none', 'probable', 'high', 'curated'].includes(row.classification.confidence) || !Array.isArray(row.classification.reasons)) throw new Error('Invalid snapshot server');
    }
    return value;
  }
  async save(snapshot) {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(snapshot)); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.path);
      const dir = await open(directory, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await unlink(temp).catch(() => {}); }
  }
}
