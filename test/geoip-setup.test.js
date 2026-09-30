import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, lstat, symlink, chmod, rm, readdir } from 'node:fs/promises';
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
  await configureGeoip(path, '123456', 'private-key_1', '/var/lib/christmasdust-geoip');
  const first = await readFile(path, 'utf8');
  assert.doesNotMatch(first, /Host updates\.example\.test/);
  assert.match(first, /^Host updates\.maxmind\.com$/m);
  assert.match(first, /^AccountID 123456$/m);
  assert.match(first, /^LicenseKey private-key_1$/m);
  assert.match(first, /^EditionIDs GeoLite2-City$/m);
  assert.match(first, /^DatabaseDirectory \/var\/lib\/christmasdust-geoip$/m);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await configureGeoip(path, '123456', 'private-key_1', '/var/lib/christmasdust-geoip');
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
  await configureEnvironment(path, '/var/lib/christmasdust-geoip/GeoLite2-City.mmdb');
  const changed = await readFile(path, 'utf8');
  assert.match(changed, /PORT=3210/);
  assert.match(changed, /STEAM_API_KEY=placeholder/);
  assert.equal((changed.match(/GEOIP_PATH=/g) ?? []).length, 1);
  assert.match(changed, /GEOIP_PATH=\/var\/lib\/christmasdust-geoip\/GeoLite2-City\.mmdb/);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
  await configureEnvironment(path, '/var/lib/christmasdust-geoip/GeoLite2-City.mmdb');
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

test('failed staged download or restart leaves working config and database untouched', async t => {
  const dir = await fixture(t);
  const root = join(dir, 'opt');
  const etc = join(dir, 'etc');
  const state = join(dir, 'var');
  const bin = join(dir, 'bin');
  for (const path of [join(root, 'node/bin'), join(root, 'current/scripts'), join(etc, 'christmasdust'), state, bin])
    await mkdir(path, { recursive: true });
  await symlink(process.execPath, join(root, 'node/bin/node'));
  const conf = join(etc, 'GeoIP.conf');
  const env = join(etc, 'christmasdust/christmasdust.env');
  const databaseDir = join(state, 'christmasdust-geoip');
  await mkdir(databaseDir);
  const database = join(databaseDir, 'GeoLite2-City.mmdb');
  const previousConf = 'AccountID 111\nLicenseKey working-key\nEditionIDs GeoLite2-City\n';
  const previousEnv = 'PORT=3001\nGEOIP_PATH=working.mmdb\n';
  await writeFile(conf, previousConf, { mode: 0o600 });
  await writeFile(env, previousEnv, { mode: 0o640 });
  await writeFile(database, 'working-database');
  await writeFile(join(bin, 'getent'), '#!/bin/sh\nprintf "christmasdust:x:%s:\\n" "$TEST_GID"\n', { mode: 0o755 });
  await writeFile(join(bin, 'geoipupdate'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$TEST_LOG"\nexit 1\n', { mode: 0o755 });
  let script = await readFile(new URL('../scripts/setup-geoip', import.meta.url), 'utf8');
  const swap = (before, after) => {
    assert.ok(script.includes(before), `Expected setup command fragment: ${before}`);
    script = script.replace(before, after);
  };
  swap('ROOT=/opt/christmasdust', `ROOT=${root}`);
  swap('export PATH="$ROOT/node/bin:/usr/sbin:/usr/bin:/sbin:/bin"', `export PATH=${bin}:/usr/sbin:/usr/bin:/sbin:/bin`);
  swap('HELPER="$ROOT/current/scripts/geoip-files.js"', `HELPER=${new URL('../scripts/geoip-files.js', import.meta.url).pathname}`);
  swap('ENV_FILE=/etc/christmasdust/christmasdust.env', `ENV_FILE=${env}`);
  swap('DB_DIR=/var/lib/christmasdust-geoip', `DB_DIR=${databaseDir}`);
  swap('CONF=/etc/GeoIP.conf', `CONF=${conf}`);
  swap('[[ $EUID == 0 ]]', 'true');
  swap('. /etc/os-release', 'ID=debian');
  swap('candidate_conf=$(mktemp /etc/.GeoIP.conf.christmasdust.XXXXXXXX)', `candidate_conf=$(mktemp ${etc}/.GeoIP.conf.christmasdust.XXXXXXXX)`);
  swap('validation_dir=$(mktemp -d /var/lib/.christmasdust-geoip-validation.XXXXXXXX)', `validation_dir=$(mktemp -d ${state}/.christmasdust-geoip-validation.XXXXXXXX)`);
  swap('chown root:christmasdust "$validation_dir"', 'true');
  const promptStart = script.indexOf('[[ -e /dev/tty ]]');
  const promptEnd = script.indexOf('[[ $account =~', promptStart);
  assert.ok(promptStart > 0 && promptEnd > promptStart);
  script = `${script.slice(0, promptStart)}account=222\nlicense=invalid-key\n${script.slice(promptEnd)}`;
  const fixtureScript = join(dir, 'setup-geoip');
  await writeFile(fixtureScript, script);
  const log = join(dir, 'geoipupdate-args');
  const result = spawnSync('bash', [fixtureScript], { encoding: 'utf8', env: { ...process.env,
    TEST_GID: String(process.getgid()), TEST_LOG: log } });
  assert.equal(result.status, 1, result.stderr);
  const args = await readFile(log, 'utf8');
  assert.match(args, /-f .*\.GeoIP\.conf\.christmasdust\./);
  assert.match(args, /-d .*\.christmasdust-geoip-validation\./);
  assert.doesNotMatch(args, new RegExp(`-f ${conf}`));
  assert.equal(await readFile(conf, 'utf8'), previousConf);
  assert.equal(await readFile(env, 'utf8'), previousEnv);
  assert.equal(await readFile(database, 'utf8'), 'working-database');

  // Now let the staged download succeed and fail the service restart after
  // replacement. The pre-existing live files must still be restored.
  await writeFile(join(bin, 'geoipupdate'), '#!/bin/bash\nwhile [[ $# -gt 0 ]]; do if [[ $1 == -d ]]; then mkdir -p "$2"; printf new-database > "$2/GeoLite2-City.mmdb"; exit 0; fi; shift; done\nexit 1\n', { mode: 0o755 });
  await writeFile(join(bin, 'runuser'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await writeFile(join(bin, 'install'), '#!/bin/bash\nif [[ $1 == -d ]]; then mkdir -p "${@: -1}"; else cp "${@: -2:1}" "${@: -1}"; fi\n', { mode: 0o755 });
  swap('conf_backup=$(mktemp /etc/.GeoIP.conf.backup.XXXXXXXX)', `conf_backup=$(mktemp ${etc}/.GeoIP.conf.backup.XXXXXXXX)`);
  swap('env_backup=$(mktemp /etc/christmasdust/.christmasdust.env.geoip.XXXXXXXX)', `env_backup=$(mktemp ${etc}/christmasdust/.christmasdust.env.geoip.XXXXXXXX)`);
  await writeFile(fixtureScript, script);
  const failedRestart = spawnSync('bash', [fixtureScript], { encoding: 'utf8', env: { ...process.env,
    TEST_GID: String(process.getgid()), TEST_LOG: log } });
  assert.equal(failedRestart.status, 1, failedRestart.stderr);
  assert.match(failedRestart.stderr, /restoring previous configuration and database/);
  assert.equal(await readFile(conf, 'utf8'), previousConf);
  assert.equal(await readFile(env, 'utf8'), previousEnv);
  assert.equal(await readFile(database, 'utf8'), 'working-database');
});

test('native setup stores GeoIP outside the service-writable state directory', async () => {
  const script = await readFile(new URL('../scripts/setup-geoip', import.meta.url), 'utf8');
  assert.match(script, /^DB_DIR=\/var\/lib\/christmasdust-geoip$/m);
  assert.doesNotMatch(script, /^DB_DIR=\/var\/lib\/christmasdust\//m);
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
