import { open, lstat, readFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function replaceSettings(contents, settings, separator) {
  const keys = new Set(Object.keys(settings));
  const kept = [...contents.matchAll(/[^\n]*\n|[^\n]+$/g)].map(match => match[0]).filter(line => {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:=|\s)\s*/);
    return !match || !keys.has(match[1]);
  }).join('');
  const prefix = kept && !kept.endsWith('\n') ? `${kept}\n` : kept;
  return prefix + Object.entries(settings).map(([key, value]) => `${key}${separator}${value}\n`).join('');
}

export async function atomicReplace(path, contents, { mode, uid, gid, mustExist = true } = {}) {
  const parent = dirname(path);
  const old = await lstat(path).catch(error => {
    if (!mustExist && error.code === 'ENOENT') return null;
    throw error;
  });
  if (old && !old.isFile()) throw new Error(`${path} must be a regular file`);
  const targetMode = mode ?? (old.mode & 0o777);
  const targetUid = uid ?? old?.uid;
  const targetGid = gid ?? old?.gid;
  const temporary = join(parent, `.${randomUUID()}.christmasdust`);
  let file;
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(contents);
    if (targetUid !== undefined) await file.chown(targetUid, targetGid);
    await file.chmod(targetMode);
    await file.sync();
    await file.close();
    file = null;
    await rename(temporary, path);
    const directory = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (file) await file.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function configureGeoip(path, account, license, dbDirectory, sourcePath = path) {
  if (!/^[0-9]+$/.test(account) || !/^[A-Za-z0-9_-]+$/.test(license)) throw new Error('Invalid MaxMind credentials');
  const old = await lstat(sourcePath).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (old && !old.isFile()) throw new Error(`${sourcePath} must be a regular file`);
  const existing = await readFile(sourcePath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const contents = replaceSettings(existing, {
    AccountID: account, LicenseKey: license, EditionIDs: 'GeoLite2-City', DatabaseDirectory: dbDirectory,
    Host: 'updates.maxmind.com'
  }, ' ');
  await atomicReplace(path, contents, { mode: 0o600, uid: process.getuid(), gid: process.getgid(), mustExist: false });
}

export async function configureEnvironment(path, dbPath) {
  const old = await lstat(path);
  if (!old.isFile() || old.uid !== process.getuid() || (old.mode & 0o022)) throw new Error('Environment file must be owned by the caller, regular, and without group/other write access');
  const contents = replaceSettings(await readFile(path, 'utf8'), { GEOIP_PATH: dbPath }, '=');
  await atomicReplace(path, contents);
}

export async function restoreEnvironment(path, backup) {
  const old = await lstat(backup);
  if (!old.isFile()) throw new Error('Environment backup must be a regular file');
  await atomicReplace(path, await readFile(backup), { mode: old.mode & 0o777, uid: old.uid, gid: old.gid });
}

export async function protectDatabase(path, gid) {
  if (!Number.isSafeInteger(gid) || gid < 0) throw new Error('Invalid service group ID');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('GeoIP database must be a regular file');
    await file.chown(process.getuid(), gid);
    await file.chmod(0o640);
    await file.sync();
  } finally { await file.close(); }
}

if (process.argv[1]?.endsWith('/geoip-files.js')) {
  try {
    const [action, path, argument, sourcePath] = process.argv.slice(2);
    if (action === 'configure') {
      const input = await new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => { data += chunk; if (data.length > 4096) reject(new Error('Credential input too long')); });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
      });
      const [account, license] = input.split('\n');
      await configureGeoip(path, account, license, argument, sourcePath);
    } else if (action === 'environment') await configureEnvironment(path, argument);
    else if (action === 'restore') await restoreEnvironment(path, argument);
    else if (action === 'protect') await protectDatabase(path, Number(argument));
    else throw new Error('Unknown action');
  } catch (error) {
    // Never print config contents or credentials.
    console.error(`GeoIP file operation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
