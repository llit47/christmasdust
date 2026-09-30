import { readFile, writeFile } from 'node:fs/promises';
import { migrateDetection, serializeDetection } from '../src/config/detection.js';

const [source, candidate] = process.argv.slice(2);
if (!source || !candidate) throw new Error('Usage: node scripts/migrate-detection.js SOURCE CANDIDATE');
try {
  const { config, changed } = migrateDetection(JSON.parse(await readFile(source, 'utf8')));
  if (changed) await writeFile(candidate, serializeDetection(config));
  process.stdout.write(changed ? 'migrated\n' : 'current\n');
} catch {
  console.error('Detection migration failed: invalid or unreadable configuration');
  process.exitCode = 1;
}
