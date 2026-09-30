import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readlink, rm, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
// Exercise the real transaction script with temporary paths and fake OS/network commands.
// This validates rollback logic, not a real systemd installation or package download.
const legacy = { strong: ['christmas', 'xmas', 'santa', 'noel', 'weihnacht', 'swieta'],
  weak: ['winter', 'snow', 'snowy'], include: ['8.8.8.8:27015'], exclude: ['1.1.1.1:27016'] };
const legacyBytes = `${JSON.stringify(legacy, null, 2)}\n`;
async function transaction(t, failure = '', initialSnapshot = true, detectionBytes = legacyBytes) {
  const dir = await mkdtemp(join(tmpdir(), 'christmasdust-deploy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const sub of ['root/releases/previous', 'root/node/bin', 'etc', 'lib', 'bin', 'fixture/config', 'fixture/src/config', 'fixture/src/services', 'fixture/src/utils', 'fixture/scripts']) await mkdir(join(dir, sub), { recursive: true });
  const old = join(dir, 'root/releases/previous');
  await symlink(old, join(dir, 'root/current')); await symlink(process.execPath, join(dir, 'root/node/bin/node'));
  await writeFile(join(old, 'REVISION'), 'old');
  if (initialSnapshot) await writeFile(join(dir, 'lib/snapshot.json'), 'previous-snapshot');
  await writeFile(join(dir, 'etc/channel'), 'main'); await writeFile(join(dir, 'etc/christmasdust.env'), 'HOST=127.0.0.1\nPORT=3001\n');
  const detectionPath = join(dir, 'etc/detection.json');
  await writeFile(detectionPath, detectionBytes); await chmod(detectionPath, 0o640);
  await writeFile(join(dir, 'fixture/package.json'), '{"type":"module"}');
  for (const file of ['src/config/index.js', 'src/config/detection.js', 'src/utils/address.js', 'config/christmas-maps.json', 'scripts/migrate-detection.js'])
    await writeFile(join(dir, 'fixture', file), await readFile(new URL(`../${file}`, import.meta.url)));
  if (failure === 'validation') await writeFile(join(dir, 'fixture/config/christmas-maps.json'), '{"strong":["duplicate"],"probable":["duplicate"]}');
  await writeFile(join(dir, 'fixture/src/services/geoip.js'), 'export const loadGeoip=async()=>()=>({});');
  await writeFile(join(dir, 'fixture/scripts/christmasdust'), '#!/bin/bash\nexit 0\n');
  const mocks = {
    runuser: 'shift 3; exec "$@"',
    git: 'if [[ $1 == clone ]]; then cp -a "$DEPLOY_TEST_DIR/fixture" "${@: -1}"; else echo candidate; fi',
    npm: '[[ $DEPLOY_TEST_FAILURE != prepare ]]',
    chown: 'exit 0',
    sleep: 'exit 0',
    systemctl: 'if [[ $1 == stop && $DEPLOY_TEST_FAILURE == config-changed && ! -e $DEPLOY_TEST_DIR/config-edit-done ]]; then printf \'\\n\' >> "$DEPLOY_TEST_DIR/etc/detection.json"; touch "$DEPLOY_TEST_DIR/config-edit-done"; fi\nif [[ $1 == start ]]; then revision=$(cat "$DEPLOY_TEST_DIR/root/current/REVISION"); if [[ $revision == old ]] && grep -q \'"version": 2\' "$DEPLOY_TEST_DIR/etc/detection.json"; then echo incompatible-old-config >> "$DEPLOY_TEST_DIR/events"; exit 42; fi; if [[ $revision == candidate ]]; then echo changed > "$DEPLOY_TEST_DIR/lib/snapshot.json"; fi; fi\nexit 0',
    curl: 'revision=$(cat "$DEPLOY_TEST_DIR/root/current/REVISION"); if [[ $DEPLOY_TEST_FAILURE == health && $revision == candidate ]]; then exit 22; fi; if [[ $DEPLOY_TEST_FAILURE == revision && $revision == candidate ]]; then revision=wrong; fi; printf \'{"ready":true,"revision":"%s"}\\n\' "$revision"'
  };
  for (const [name, body] of Object.entries(mocks)) await writeFile(join(dir, 'bin', name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  let script = await readFile(new URL('../scripts/christmasdust', import.meta.url), 'utf8');
  script = script.replaceAll('/opt/christmasdust', join(dir, 'root')).replaceAll('/etc/christmasdust', join(dir, 'etc'))
    .replaceAll('/var/lib/christmasdust', join(dir, 'lib')).replaceAll('/run/lock/christmasdust-update.lock', join(dir, 'lock'))
    .replaceAll('/usr/local/bin/christmasdust', join(dir, 'bin/christmasdust')).replace('[[ $EUID == 0 ]]', 'true')
    .replace('/usr/sbin:/usr/bin:/sbin:/bin', `${join(dir, 'bin')}:/usr/sbin:/usr/bin:/sbin:/bin`);
  const scriptPath = join(dir, 'updater'); await writeFile(scriptPath, script);
  const result = spawnSync('bash', [scriptPath, 'update'], { env: { ...process.env, DEPLOY_TEST_DIR: dir, DEPLOY_TEST_FAILURE: failure }, encoding: 'utf8', timeout: 15000 });
  const snapshot = await readFile(join(dir, 'lib/snapshot.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const events = await readFile(join(dir, 'events'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return { result, current: await readlink(join(dir, 'root/current')), snapshot, old,
    detection: await readFile(detectionPath, 'utf8'), detectionMode: (await stat(detectionPath)).mode & 0o777, events };
}
test('updater commits a prepared, healthy candidate', async t => {
  const { result, current, snapshot, old, detection, detectionMode } = await transaction(t);
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.notEqual(current, old); assert.equal(snapshot.trim(), 'changed');
  const migrated = JSON.parse(detection);
  assert.equal(migrated.version, 2); assert.ok(migrated.strong.includes('weihnachten'));
  assert.ok(migrated.related.includes('santa')); assert.deepEqual(migrated.include, legacy.include);
  assert.deepEqual(migrated.exclude, legacy.exclude); assert.equal(detectionMode, 0o640);
});
test('updater preparation failure leaves running release and data untouched', async t => {
  const { result, current, snapshot, old, detection } = await transaction(t, 'prepare');
  assert.notEqual(result.status, 0); assert.equal(current, old); assert.equal(snapshot, 'previous-snapshot');
  assert.equal(detection, legacyBytes);
});
test('updater health failure automatically restores prior release and snapshot', async t => {
  const { result, current, snapshot, old, detection, detectionMode, events } = await transaction(t, 'health');
  assert.notEqual(result.status, 0, result.stdout + result.stderr); assert.equal(current, old); assert.equal(snapshot, 'previous-snapshot');
  assert.equal(detection, legacyBytes); assert.equal(detectionMode, 0o640); assert.equal(events, '');
  assert.match(result.stderr, /Previous version is healthy/);
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
  assert.equal(detection, legacyBytes); assert.equal(detectionMode, 0o640); assert.equal(events, '');
  assert.match(result.stderr, /Previous version is healthy/);
});
test('current detection config is not rewritten during a successful update', async t => {
  const currentBytes = await readFile(new URL('../config/detection.json', import.meta.url), 'utf8');
  const { result, detection, current, old } = await transaction(t, '', true, currentBytes);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.notEqual(current, old); assert.equal(detection, currentBytes);
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
