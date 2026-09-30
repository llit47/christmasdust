import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, lstat, symlink, chmod, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configureGeoip, configureEnvironment, restoreEnvironment, protectDatabase } from '../scripts/geoip-files.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'christmasdust-geoip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('GeoIP config protects credentials, preserves unrelated settings, and remains idempotent', async t => {
  const dir = await fixture(t);
  const path = join(dir, 'GeoIP.conf');
  await writeFile(path, '# comment\nHost updates.example.test\nAccountID old\nLicenseKey old\nEditionIDs GeoLite2-Country\n');
  await configureGeoip(path, '123456', 'private-key_1', '/var/lib/christmasdust/geoip');
  const first = await readFile(path, 'utf8');
  assert.doesNotMatch(first, /Host updates\.example\.test/);
  assert.match(first, /^Host updates\.maxmind\.com$/m);
  assert.match(first, /^AccountID 123456$/m);
  assert.match(first, /^LicenseKey private-key_1$/m);
  assert.match(first, /^EditionIDs GeoLite2-City$/m);
  assert.match(first, /^DatabaseDirectory \/var\/lib\/christmasdust\/geoip$/m);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await configureGeoip(path, '123456', 'private-key_1', '/var/lib/christmasdust/geoip');
  assert.equal(await readFile(path, 'utf8'), first);
  assert.equal((await lstat(path)).isFile(), true);
  assert.deepEqual(await readdir(dir), ['GeoIP.conf']);
});

test('environment update is atomic, preserves other lines and can restore exact bytes', async t => {
  const dir = await fixture(t);
  const path = join(dir, 'christmasdust.env');
  const backup = join(dir, 'backup');
  const original = '# operator note\nPORT=3210\nGEOIP_PATH=/old/path\nSTEAM_API_KEY=placeholder\n';
  await writeFile(path, original, { mode: 0o640 });
  await writeFile(backup, original, { mode: 0o640 });
  await configureEnvironment(path, '/var/lib/christmasdust/geoip/GeoLite2-City.mmdb');
  const changed = await readFile(path, 'utf8');
  assert.match(changed, /PORT=3210/);
  assert.match(changed, /STEAM_API_KEY=placeholder/);
  assert.equal((changed.match(/GEOIP_PATH=/g) ?? []).length, 1);
  assert.match(changed, /GEOIP_PATH=\/var\/lib\/christmasdust\/geoip\/GeoLite2-City\.mmdb/);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  await configureEnvironment(path, '/var/lib/christmasdust/geoip/GeoLite2-City.mmdb');
  assert.equal(await readFile(path, 'utf8'), changed);
  await restoreEnvironment(path, backup);
  assert.equal(await readFile(path, 'utf8'), original);
});

test('rejects symlinks and unsafe environment permissions; database permissions are restricted', async t => {
  const dir = await fixture(t);
  const target = join(dir, 'target');
  const link = join(dir, 'link');
  await writeFile(target, 'unchanged', { mode: 0o666 });
  await symlink(target, link);
  await assert.rejects(configureGeoip(link, '123', 'valid-key', dir), /regular file/);
  await chmod(target, 0o666);
  await assert.rejects(configureEnvironment(target, '/database'), /without group\/other write access/);
  await assert.rejects(protectDatabase(link, process.getgid()), /ELOOP/);
  await protectDatabase(target, process.getgid());
  assert.equal((await stat(target)).mode & 0o777, 0o640);
});

test('invalid credential input cannot change config or leak the supplied key in diagnostics', async t => {
  const dir = await fixture(t);
  const path = join(dir, 'GeoIP.conf');
  await writeFile(path, 'original\n');
  const secret = 'do-not-print-this-key';
  const result = spawnSync(process.execPath, ['scripts/geoip-files.js', 'configure', path, dir],
    { input: `invalid-account\n${secret}\n`, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, new RegExp(secret));
  assert.equal(await readFile(path, 'utf8'), 'original\n');
});

test('native CLI advertises setup and denies unprivileged invocation', () => {
  const script = new URL('../scripts/christmasdust', import.meta.url).pathname;
  const usage = spawnSync('bash', [script], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stdout, /sudo christmasdust setup-geoip/);
  if (process.getuid() !== 0) {
    const denied = spawnSync('bash', [script, 'setup-geoip'], { encoding: 'utf8' });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /requires root/);
  }
});
