import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { readConfig } from '../src/config/index.js';

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
  process.stdout.write(`${path}\n`);
} catch {
  console.error('Native update requires an existing, root-owned detection file at an absolute DETECTION_PATH in a protected directory.');
  process.exitCode = 1;
}
