import { lstatSync, realpathSync, statSync, readFileSync, openSync, writeFileSync, fchownSync, fchmodSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { dirname, isAbsolute } from 'node:path';
import { readConfig } from '../src/config/index.js';

function ensureNativeRatingsPath() {
  // Older installed updaters already execute this candidate-owned script as root.
  // Commit the additive setting before they validate/start the new release;
  // previous releases ignore it, so rollback need not undo this migration.
  const envPath = process.execArgv.find(arg => arg.startsWith('--env-file='))?.slice('--env-file='.length);
  if (!envPath || !isAbsolute(envPath)) throw new Error('absolute environment file required');
  const info = lstatSync(envPath);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o022))
    throw new Error('protected environment file required');
  const source = readFileSync(envPath, 'utf8');
  if (Object.hasOwn(parseEnv(source), 'RATINGS_PATH')) return;
  const directory = dirname(envPath);
  const candidate = `${envPath}.${randomUUID()}.tmp`;
  const syncDirectory = () => {
    const fd = openSync(directory, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  try {
    const fd = openSync(candidate, 'wx', 0o600);
    try {
      writeFileSync(fd, `${source}\nRATINGS_PATH=/var/lib/christmasdust/ratings.sqlite\n`);
      fchownSync(fd, info.uid, info.gid);
      fchmodSync(fd, info.mode & 0o777);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    syncDirectory();
    if (readFileSync(envPath, 'utf8') !== source) throw new Error('environment changed during update');
    renameSync(candidate, envPath);
    syncDirectory();
  } finally {
    try { unlinkSync(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

try {
  // Native installs must name a persistent operator file, not a path relative
  // to whichever release happens to be the working directory.
  if (!process.env.DETECTION_PATH || !isAbsolute(process.env.DETECTION_PATH)) throw new Error('absolute path required');
  const configured = readConfig().detectionPath;
  const entry = lstatSync(configured);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('regular file required');
  const path = realpathSync(configured);
  const owner = process.getuid();
  const systemOwner = statSync('/').uid;
  if (/\r|\n/.test(path) || entry.uid !== owner || (entry.mode & 0o022)) throw new Error('unsafe detection path');
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const info = statSync(directory);
    const stickySystemDirectory = info.uid === systemOwner && (info.mode & 0o1000);
    if ((info.uid !== owner && info.uid !== systemOwner) || ((info.mode & 0o022) && !stickySystemDirectory))
      throw new Error('unsafe detection directory');
    if (directory === dirname(directory)) break;
  }
  ensureNativeRatingsPath();
  process.stdout.write(`${path}\n`);
} catch {
  console.error('Native update requires an existing, root-owned detection file at an absolute DETECTION_PATH in a protected directory and a protected absolute environment file.');
  process.exitCode = 1;
}
