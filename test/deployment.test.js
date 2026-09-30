import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readlink, rm, chmod, stat, rename } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
// Exercise the real transaction script with temporary paths and fake OS/network commands.
// This validates rollback logic, not a real systemd installation or package download.
const legacy = { strong: ['christmas', 'xmas', 'santa', 'noel', 'weihnacht', 'swieta'],
  weak: ['winter', 'snow', 'snowy'], include: ['8.8.8.8:27015'], exclude: ['1.1.1.1:27016'] };
const legacyBytes = `${JSON.stringify(legacy, null, 2)}\n`;
async function transaction(t, failure = '', initialSnapshot = true, detectionBytes = legacyBytes, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'christmasdust-deploy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const sub of ['root/releases/previous', 'root/node/bin', 'etc', 'lib', 'bin', 'fixture/config', 'fixture/src/config', 'fixture/src/services', 'fixture/src/utils', 'fixture/scripts']) await mkdir(join(dir, sub), { recursive: true });
  await chmod(join(dir, 'etc'), 0o750);
  const old = join(dir, 'root/releases/previous');
  await symlink(old, join(dir, 'root/current'));
  if (failure === 'stale-link') await symlink(old, join(dir, 'root/next-link'));
  await writeFile(join(dir, 'root/node/bin/node'), `#!/bin/bash
if [[ $1 == -e && $2 == *fs.fsyncSync* ]]; then
  for path in "${'${@:3}'}"; do printf 'fsync:%s\n' "$path" >> "$DEPLOY_TEST_DIR/events"; done
  if [[ $DEPLOY_TEST_FAILURE == after-backup && -f $DEPLOY_TEST_BACKUP_PATH && $3 == "${'${DEPLOY_TEST_BACKUP_PATH%/*}'}" ]]; then exit 46; fi
fi
exec ${process.execPath} "$@"
`, { mode: 0o755 });
  await writeFile(join(old, 'REVISION'), 'old');
  if (initialSnapshot) await writeFile(join(dir, 'lib/snapshot.json'), 'previous-snapshot');
  const defaultPath = join(dir, 'etc/detection.json');
  const detectionPath = options.customPath ? join(dir, 'custom/detection.json') : defaultPath;
  if (options.customPath) { await mkdir(dirname(detectionPath)); await chmod(dirname(detectionPath), 0o750); }
  await writeFile(join(dir, 'etc/channel'), 'main');
  await writeFile(join(dir, 'etc/christmasdust.env'), `HOST=127.0.0.1\nPORT=3001\nDETECTION_PATH=${options.configuredPath ?? detectionPath}\n`);
  await writeFile(detectionPath, detectionBytes); await chmod(detectionPath, 0o640);
  if (options.defaultBytes !== undefined) await writeFile(defaultPath, options.defaultBytes);
  const backupPath = join(dirname(detectionPath), 'rollback', `${basename(detectionPath, '.json')}-v1.json`);
  if (options.initialBackupBytes !== undefined) {
    await mkdir(dirname(backupPath), { mode: 0o700 });
    await writeFile(backupPath, options.initialBackupBytes, { mode: 0o640 });
  }
  await writeFile(join(dir, 'fixture/package.json'), '{"type":"module"}');
  for (const file of ['src/config/index.js', 'src/config/detection.js', 'src/utils/address.js', 'config/christmas-maps.json', 'scripts/migrate-detection.js', 'scripts/resolve-detection.js'])
    await writeFile(join(dir, 'fixture', file), await readFile(new URL(`../${file}`, import.meta.url)));
  if (failure === 'validation') await writeFile(join(dir, 'fixture/config/christmas-maps.json'), '{"strong":["duplicate"],"probable":["duplicate"]}');
  await writeFile(join(dir, 'fixture/src/services/geoip.js'), 'export const loadGeoip=async()=>()=>({});');
  await writeFile(join(dir, 'fixture/scripts/christmasdust'), '#!/bin/bash\nexit 0\n');
  if (options.existingGeoipMode !== undefined) { await mkdir(join(dir, 'lib/geoip')); await chmod(join(dir, 'lib/geoip'), options.existingGeoipMode); }
  const mocks = {
    runuser: 'shift 3; exec "$@"',
    git: 'if [[ $1 == clone ]]; then cp -a "$DEPLOY_TEST_DIR/fixture" "${@: -1}"; else echo candidate; fi',
    npm: '[[ $DEPLOY_TEST_FAILURE != prepare ]]',
    chown: 'exit 0',
    sleep: 'exit 0',
    sync: 'printf \'sync:%s\\n\' "$*" >> "$DEPLOY_TEST_DIR/events"; exec /usr/bin/sync "$@"',
    mv: 'target=${@: -1}; printf \'mv:%s\\n\' "$target" >> "$DEPLOY_TEST_DIR/events"; /usr/bin/mv "$@"; if [[ $DEPLOY_TEST_FAILURE == crash-after-release && $target == "$DEPLOY_TEST_DIR/root/current" ]] || [[ $DEPLOY_TEST_FAILURE == crash-after-config && $target == "$DEPLOY_TEST_DETECTION_PATH" ]]; then kill -KILL "$PPID"; fi; if [[ ! -e $DEPLOY_TEST_DIR/fault-fired ]] && { [[ $DEPLOY_TEST_FAILURE == after-release-mv && $target == "$DEPLOY_TEST_DIR/root/current" ]] || [[ $DEPLOY_TEST_FAILURE == after-config-mv && $target == "$DEPLOY_TEST_DETECTION_PATH" ]]; }; then touch "$DEPLOY_TEST_DIR/fault-fired"; exit 42; fi; if [[ $DEPLOY_TEST_FAILURE == channel && $target == "$DEPLOY_TEST_DIR/etc/channel" ]]; then exit 43; fi',
    ln: 'target=${@: -1}; printf \'ln:%s\\n\' "$target" >> "$DEPLOY_TEST_DIR/events"; if [[ $DEPLOY_TEST_FAILURE == backup-fail && $target == "$DEPLOY_TEST_BACKUP_PATH" ]]; then exit 45; fi; exec /usr/bin/ln "$@"',
    install: 'if [[ $1 == -d ]]; then printf \'install:%s\\n\' "$*" >> "$DEPLOY_TEST_DIR/events"; exec /usr/bin/install -d -m 0750 "${@: -1}"; fi; if [[ $DEPLOY_TEST_FAILURE == management ]]; then exit 44; fi; exec /usr/bin/install "$@"',
    systemctl: 'if [[ $1 == stop && $DEPLOY_TEST_FAILURE == config-changed && ! -e $DEPLOY_TEST_DIR/config-edit-done ]]; then printf \'\\n\' >> "$DEPLOY_TEST_DETECTION_PATH"; touch "$DEPLOY_TEST_DIR/config-edit-done"; fi\nif [[ $1 == start ]]; then revision=$(cat "$DEPLOY_TEST_DIR/root/current/REVISION"); if [[ $revision == old ]] && grep -q \'"version": 2\' "$DEPLOY_TEST_DETECTION_PATH"; then echo incompatible-old-config >> "$DEPLOY_TEST_DIR/events"; exit 42; fi; if [[ $revision == candidate ]]; then echo changed > "$DEPLOY_TEST_DIR/lib/snapshot.json"; fi; fi\nexit 0',
    curl: 'revision=$(cat "$DEPLOY_TEST_DIR/root/current/REVISION"); if [[ $DEPLOY_TEST_FAILURE == health && $revision == candidate ]]; then exit 22; fi; if [[ $DEPLOY_TEST_FAILURE == revision && $revision == candidate ]]; then revision=wrong; fi; printf \'{"ready":true,"revision":"%s"}\\n\' "$revision"'
  };
  for (const [name, body] of Object.entries(mocks)) await writeFile(join(dir, 'bin', name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  let script = await readFile(new URL('../scripts/christmasdust', import.meta.url), 'utf8');
  script = script.replaceAll('/opt/christmasdust', join(dir, 'root')).replaceAll('/etc/christmasdust', join(dir, 'etc'))
    .replaceAll('/var/lib/christmasdust', join(dir, 'lib')).replaceAll('/run/lock/christmasdust-update.lock', join(dir, 'lock'))
    .replaceAll('/usr/local/bin', join(dir, 'bin')).replace('[[ $EUID == 0 ]]', 'true')
    .replace('/usr/sbin:/usr/bin:/sbin:/bin', `${join(dir, 'bin')}:/usr/sbin:/usr/bin:/sbin:/bin`);
  const scriptPath = join(dir, 'updater'); await writeFile(scriptPath, script);
  const run = () => spawnSync('bash', [scriptPath, 'update'], { env: { ...process.env, DEPLOY_TEST_DIR: dir,
    DEPLOY_TEST_DETECTION_PATH: detectionPath, DEPLOY_TEST_BACKUP_PATH: backupPath, DEPLOY_TEST_FAILURE: failure }, encoding: 'utf8', timeout: 15000 });
  const firstResult = run();
  const result = options.repeatUpdate && firstResult.status === 0 ? run() : firstResult;
  const snapshot = await readFile(join(dir, 'lib/snapshot.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const events = await readFile(join(dir, 'events'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const backup = await readFile(backupPath, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const defaultDetection = await readFile(defaultPath, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  const geoip = await stat(join(dir, 'lib/geoip')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  return { result, firstResult, current: await readlink(join(dir, 'root/current')), snapshot, old,
    detection: await readFile(detectionPath, 'utf8'), detectionMode: (await stat(detectionPath)).mode & 0o777,
    detectionPath, defaultDetection, backup, backupPath, backupMode: backup === null ? null : (await stat(backupPath)).mode & 0o777,
    backupOwner: backup === null ? null : (await stat(backupPath)).uid,
    backupDirMode: backup === null ? null : (await stat(dirname(backupPath))).mode & 0o777,
    geoipMode: geoip === null ? null : geoip.mode & 0o777, events };
}
test('updater provisions the GeoIP directory when an existing installation lacks it', async t => {
  const state = await transaction(t);
  assert.equal(state.result.status, 0, state.result.stdout + state.result.stderr);
  assert.equal(state.geoipMode, 0o750);
  assert.match(state.events, /install:-d -o root -g christmasdust -m 0750 .*\/lib\/geoip/);
});
test('updater corrects the GeoIP directory mode on an existing installation', async t => {
  const state = await transaction(t, '', true, legacyBytes, { existingGeoipMode: 0o755 });
  assert.equal(state.result.status, 0, state.result.stdout + state.result.stderr);
  assert.equal(state.geoipMode, 0o750);
});
test('updater commits a prepared, healthy candidate', async t => {
  const { result, current, snapshot, old, detection, detectionMode } = await transaction(t);
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.notEqual(current, old); assert.equal(snapshot.trim(), 'changed');
  const migrated = JSON.parse(detection);
  assert.equal(migrated.version, 2); assert.ok(migrated.strong.includes('weihnachten'));
  assert.ok(migrated.related.includes('santa')); assert.deepEqual(migrated.include, legacy.include);
  assert.deepEqual(migrated.exclude, legacy.exclude); assert.equal(detectionMode, 0o640);
});
test('updater can retry after a crash left an unused next-link', async t => {
  const { result, current, old, detection } = await transaction(t, 'stale-link');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(current, old); assert.equal(JSON.parse(detection).version, 2);
});
test('updater preparation failure leaves running release and data untouched', async t => {
  const { result, current, snapshot, old, detection } = await transaction(t, 'prepare');
  assert.notEqual(result.status, 0); assert.equal(current, old); assert.equal(snapshot, 'previous-snapshot');
  assert.equal(detection, legacyBytes);
});
test('updater health failure automatically restores prior release and snapshot', async t => {
  const { result, current, snapshot, old, detection, detectionMode, events } = await transaction(t, 'health');
  assert.notEqual(result.status, 0, result.stdout + result.stderr); assert.equal(current, old); assert.equal(snapshot, 'previous-snapshot');
  assert.equal(detection, legacyBytes); assert.equal(detectionMode, 0o640); assert.doesNotMatch(events, /incompatible-old-config/);
  assert.match(result.stderr, /Previous version is healthy/);
  const lines = events.split('\n');
  const snapshotRestore = lines.findLastIndex(line => line.startsWith('mv:') && line.endsWith('/lib/snapshot.json'));
  const oldPointer = lines.findLastIndex(line => line.startsWith('mv:') && line.endsWith('/root/current'));
  const snapshotBarrier = lines.findIndex((line, index) => index > snapshotRestore && line.startsWith('fsync:') && line.endsWith('/lib'));
  assert.ok(snapshotRestore >= 0 && snapshotRestore < snapshotBarrier && snapshotBarrier < oldPointer, events);
});
test('updater health failure removes candidate snapshot when previous release had none', async t => {
  const { result, current, snapshot, old, detection } = await transaction(t, 'health', false);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(current, old);
  assert.equal(snapshot, null);
  assert.equal(detection, legacyBytes);
  assert.match(result.stderr, /Previous version is healthy/);
});
test('staged validation failure leaves exact legacy bytes and old release active', async t => {
  const { result, current, snapshot, old, detection } = await transaction(t, 'validation');
  assert.notEqual(result.status, 0);
  assert.equal(current, old); assert.equal(snapshot, 'previous-snapshot');
  assert.equal(detection, legacyBytes);
});
test('invalid legacy configuration fails before any live change', async t => {
  const invalid = '{"strong":["xmas"],"weak":[],"include":["127.0.0.1:1"],"exclude":[]}\n';
  const { result, current, snapshot, old, detection } = await transaction(t, '', true, invalid);
  assert.notEqual(result.status, 0);
  assert.equal(current, old); assert.equal(snapshot, 'previous-snapshot');
  assert.equal(detection, invalid);
});
test('unsupported future detection version blocks update without changing live bytes', async t => {
  const future = '{"version": 99, "strong": [], "related": [], "weak": [], "include": [], "exclude": []}\n';
  const { result, current, old, detection } = await transaction(t, '', true, future);
  assert.notEqual(result.status, 0); assert.equal(current, old); assert.equal(detection, future);
});
test('operator edit during update is retained instead of overwritten', async t => {
  const { result, current, old, detection } = await transaction(t, 'config-changed');
  assert.notEqual(result.status, 0);
  assert.equal(current, old); assert.equal(detection, `${legacyBytes}\n`);
});
test('revision mismatch restores old release and exact detection bytes before restart', async t => {
  const { result, current, snapshot, old, detection, detectionMode, events } = await transaction(t, 'revision');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(current, old); assert.equal(snapshot, 'previous-snapshot');
  assert.equal(detection, legacyBytes); assert.equal(detectionMode, 0o640); assert.doesNotMatch(events, /incompatible-old-config/);
  assert.match(result.stderr, /Previous version is healthy/);
});
test('current detection config is not rewritten during a successful update', async t => {
  const currentBytes = await readFile(new URL('../config/detection.json', import.meta.url), 'utf8');
  const { result, detection, current, old, backup } = await transaction(t, '', true, currentBytes);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(current, old); assert.equal(detection, currentBytes);
  assert.equal(backup, null);
});
test('successful update keeps custom detection terms while moving legacy defaults', async t => {
  const custom = `${JSON.stringify({ ...legacy, strong: [...legacy.strong, 'mychristmasserver'],
    weak: [...legacy.weak, 'mywinterterm'] }, null, 2)}\n`;
  const { result, detection } = await transaction(t, '', true, custom);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const migrated = JSON.parse(detection);
  assert.ok(migrated.strong.includes('mychristmasserver'));
  assert.ok(migrated.weak.includes('mywinterterm'));
  assert.deepEqual(migrated.include, legacy.include); assert.deepEqual(migrated.exclude, legacy.exclude);
});
test('release pointer is durably committed before detection config replacement', async t => {
  const { result, events } = await transaction(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = events.split('\n');
  const root = lines.find(line => line.startsWith('mv:') && line.endsWith('/root/current'));
  const config = lines.find(line => line.startsWith('mv:') && line.endsWith('/etc/detection.json'));
  const releaseIndex = lines.indexOf(root);
  const treeSyncIndex = lines.findIndex(line => line.startsWith('sync:-f ') && line.includes('/root/releases/'));
  const rootFsyncIndex = lines.findIndex((line, index) => index > releaseIndex && line === root.replace('mv:', 'fsync:').replace('/current', ''));
  const configIndex = lines.indexOf(config);
  const configFsyncIndex = lines.findIndex((line, index) => index > configIndex && line === config.replace('mv:', 'fsync:').replace('/detection.json', ''));
  assert.ok(treeSyncIndex >= 0 && treeSyncIndex < releaseIndex && releaseIndex < rootFsyncIndex && rootFsyncIndex < configIndex && configIndex < configFsyncIndex, events);
});
test('abrupt updater death at each switch boundary leaves compatible release and config', async t => {
  for (const [failure, expectedVersion] of [['crash-after-release', undefined], ['crash-after-config', 2]]) {
    const state = await transaction(t, failure);
    assert.equal(state.result.signal, 'SIGKILL');
    assert.notEqual(state.current, state.old);
    assert.equal(JSON.parse(state.detection).version, expectedVersion);
  }
});
test('failure after release pointer replacement restores compatible old state', async t => {
  const { result, current, old, detection, events } = await transaction(t, 'after-release-mv');
  assert.notEqual(result.status, 0); assert.equal(current, old); assert.equal(detection, legacyBytes);
  assert.doesNotMatch(events, /incompatible-old-config/);
});
test('failure after config replacement restores config before old release', async t => {
  const { result, current, old, detection, events } = await transaction(t, 'after-config-mv');
  assert.notEqual(result.status, 0); assert.equal(current, old); assert.equal(detection, legacyBytes);
  assert.doesNotMatch(events, /incompatible-old-config/);
  const lines = events.split('\n');
  const replacements = lines.filter(line => line.endsWith('/etc/detection.json'));
  assert.equal(replacements.length, 2);
  const restoredConfigIndex = lines.findLastIndex(line => line.startsWith('mv:') && line.endsWith('/etc/detection.json'));
  const restoredReleaseIndex = lines.findLastIndex(line => line.startsWith('mv:') && line.endsWith('/root/current'));
  const configBarrier = lines.findIndex((line, index) => index > restoredConfigIndex && line.startsWith('fsync:') && line.endsWith('/etc'));
  assert.ok(restoredConfigIndex < configBarrier && configBarrier < restoredReleaseIndex, events);
});
for (const failure of ['management', 'channel']) test(`post-health ${failure} failure keeps healthy release and migrated config`, async t => {
  const { result, current, old, detection, events } = await transaction(t, failure);
  assert.notEqual(result.status, 0); assert.notEqual(current, old);
  assert.equal(JSON.parse(detection).version, 2);
  assert.doesNotMatch(events, /incompatible-old-config/);
  assert.match(result.stderr, /Application is healthy/);
});
test('first legacy migration retains exact durable v1 backup before v2 commit', async t => {
  const state = await transaction(t);
  assert.equal(state.result.status, 0, state.result.stdout + state.result.stderr);
  assert.equal(state.backup, legacyBytes);
  assert.equal(state.backupMode, 0o640);
  assert.equal(state.backupOwner, process.getuid());
  assert.equal(state.backupDirMode, 0o700);
  const lines = state.events.split('\n');
  const linked = lines.indexOf(`ln:${state.backupPath}`);
  const durable = lines.findIndex((line, index) => index > linked && line === `fsync:${dirname(state.backupPath)}`);
  const liveCommit = lines.indexOf(`mv:${state.detectionPath}`);
  assert.ok(linked >= 0 && linked < durable && durable < liveCommit, state.events);
});
test('custom absolute detection path works with the default file absent', async t => {
  const state = await transaction(t, '', true, legacyBytes, { customPath: true });
  assert.equal(state.result.status, 0, state.result.stdout + state.result.stderr);
  assert.equal(state.defaultDetection, null);
  assert.equal(JSON.parse(state.detection).version, 2);
  assert.equal(state.backup, legacyBytes);
  assert.ok(state.events.includes(`mv:${state.detectionPath}`));
});
test('custom path update never touches an unused default detection file', async t => {
  const state = await transaction(t, '', true, legacyBytes, { customPath: true, defaultBytes: 'unused-default\n' });
  assert.equal(state.result.status, 0, state.result.stdout + state.result.stderr);
  assert.equal(state.defaultDetection, 'unused-default\n');
  assert.equal(JSON.parse(state.detection).version, 2);
});
test('custom path health failure restores its original bytes and removes new rollback backup', async t => {
  const state = await transaction(t, 'health', true, legacyBytes, { customPath: true });
  assert.notEqual(state.result.status, 0);
  assert.equal(state.current, state.old);
  assert.equal(state.detection, legacyBytes);
  assert.equal(state.defaultDetection, null);
  assert.equal(state.backup, null);
});
test('second update leaves the first v1 backup byte-identical', async t => {
  const state = await transaction(t, '', true, legacyBytes, { repeatUpdate: true });
  assert.equal(state.firstResult.status, 0, state.firstResult.stdout + state.firstResult.stderr);
  assert.equal(state.result.status, 0, state.result.stdout + state.result.stderr);
  assert.equal(state.backup, legacyBytes);
  assert.equal(JSON.parse(state.detection).version, 2);
});
test('backup creation failure aborts before v2 config commit', async t => {
  const state = await transaction(t, 'backup-fail');
  assert.notEqual(state.result.status, 0);
  assert.equal(state.current, state.old);
  assert.equal(state.detection, legacyBytes);
  assert.equal(state.backup, null);
});
test('failure after backup creation removes uncommitted rollback metadata', async t => {
  const state = await transaction(t, 'after-backup');
  assert.notEqual(state.result.status, 0);
  assert.equal(state.current, state.old);
  assert.equal(state.detection, legacyBytes);
  assert.equal(state.backup, null);
});
test('existing invalid rollback backup blocks migration without replacing it', async t => {
  const invalid = '{"version":2,"strong":[],"related":[],"weak":[],"include":[],"exclude":[]}\n';
  const state = await transaction(t, '', true, legacyBytes, { initialBackupBytes: invalid });
  assert.notEqual(state.result.status, 0);
  assert.equal(state.current, state.old);
  assert.equal(state.detection, legacyBytes);
  assert.equal(state.backup, invalid);
});
test('existing invalid rollback backup also blocks a v2-to-v2 update', async t => {
  const currentBytes = await readFile(new URL('../config/detection.json', import.meta.url), 'utf8');
  const invalid = '{"version":99}\n';
  const state = await transaction(t, '', true, currentBytes, { initialBackupBytes: invalid });
  assert.notEqual(state.result.status, 0);
  assert.equal(state.current, state.old);
  assert.equal(state.detection, currentBytes);
  assert.equal(state.backup, invalid);
});
test('existing valid v1 backup is never overwritten by another migration', async t => {
  const prior = `${JSON.stringify({ ...legacy, strong: ['olderchristmas'] })}\n`;
  const state = await transaction(t, '', true, legacyBytes, { initialBackupBytes: prior });
  assert.equal(state.result.status, 0, state.result.stdout + state.result.stderr);
  assert.equal(state.backup, prior);
  assert.equal(JSON.parse(state.detection).version, 2);
});
test('failed update preserves a valid pre-existing v1 backup', async t => {
  const state = await transaction(t, 'health', true, legacyBytes, { initialBackupBytes: legacyBytes });
  assert.notEqual(state.result.status, 0);
  assert.equal(state.current, state.old);
  assert.equal(state.detection, legacyBytes);
  assert.equal(state.backup, legacyBytes);
});
test('native update rejects relative or missing configured detection paths', async t => {
  for (const configuredPath of ['./detection.json', '/missing/christmasdust/detection.json']) {
    const state = await transaction(t, '', true, legacyBytes, { configuredPath });
    assert.notEqual(state.result.status, 0);
    assert.equal(state.current, state.old);
    assert.equal(state.detection, legacyBytes);
  }
});
test('retained pre-v2 loader accepts the preserved backup after manual restoration', async t => {
  const state = await transaction(t);
  assert.equal(state.result.status, 0, state.result.stdout + state.result.stderr);
  const oldLoader = bytes => {
    const parsed = JSON.parse(bytes);
    for (const key of Object.keys(parsed)) if (!['strong', 'weak', 'include', 'exclude'].includes(key)) throw new Error('Unknown legacy key');
    return parsed;
  };
  assert.throws(() => oldLoader(state.detection), /Unknown legacy key/);
  assert.deepEqual(oldLoader(state.backup), legacy);
  const restore = join(dirname(state.detectionPath), '.manual-restore');
  await writeFile(restore, state.backup);
  await rename(restore, state.detectionPath);
  assert.deepEqual(oldLoader(await readFile(state.detectionPath, 'utf8')), legacy);
});
