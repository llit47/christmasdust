import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
// Exercise the real transaction script with temporary paths and fake OS/network commands.
// This validates rollback logic, not a real systemd installation or package download.
async function transaction(t, failure = '') {
  const dir = await mkdtemp(join(tmpdir(), 'christmasdust-deploy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const sub of ['root/releases/previous', 'root/node/bin', 'etc', 'lib', 'bin', 'fixture/src/config', 'fixture/src/services', 'fixture/scripts']) await mkdir(join(dir, sub), { recursive: true });
  const old = join(dir, 'root/releases/previous');
  await symlink(old, join(dir, 'root/current')); await symlink(process.execPath, join(dir, 'root/node/bin/node'));
  await writeFile(join(old, 'REVISION'), 'old'); await writeFile(join(dir, 'lib/snapshot.json'), 'previous-snapshot');
  await writeFile(join(dir, 'etc/channel'), 'main'); await writeFile(join(dir, 'etc/christmasdust.env'), 'HOST=127.0.0.1\nPORT=3001\n');
  await writeFile(join(dir, 'fixture/package.json'), '{"type":"module"}');
  await writeFile(join(dir, 'fixture/src/config/index.js'), 'export const readConfig=()=>({}); export const loadDetection=async()=>({});');
  await writeFile(join(dir, 'fixture/src/services/geoip.js'), 'export const loadGeoip=async()=>()=>({});');
  await writeFile(join(dir, 'fixture/scripts/christmasdust'), '#!/bin/bash\nexit 0\n');
  const mocks = {
    runuser: 'shift 3; exec "$@"',
    git: 'if [[ $1 == clone ]]; then cp -a "$DEPLOY_TEST_DIR/fixture" "${@: -1}"; else echo candidate; fi',
    npm: '[[ $DEPLOY_TEST_FAILURE != prepare ]]',
    chown: 'exit 0',
    sleep: 'exit 0',
    systemctl: 'if [[ $1 == start && $(cat "$DEPLOY_TEST_DIR/root/current/REVISION") == candidate ]]; then echo changed > "$DEPLOY_TEST_DIR/lib/snapshot.json"; fi\nexit 0',
    curl: 'revision=$(cat "$DEPLOY_TEST_DIR/root/current/REVISION"); if [[ $DEPLOY_TEST_FAILURE == health && $revision == candidate ]]; then exit 22; fi; printf \'{"ready":true,"revision":"%s"}\\n\' "$revision"'
  };
  for (const [name, body] of Object.entries(mocks)) await writeFile(join(dir, 'bin', name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  let script = await readFile(new URL('../scripts/christmasdust', import.meta.url), 'utf8');
  script = script.replaceAll('/opt/christmasdust', join(dir, 'root')).replaceAll('/etc/christmasdust', join(dir, 'etc'))
    .replaceAll('/var/lib/christmasdust', join(dir, 'lib')).replaceAll('/run/lock/christmasdust-update.lock', join(dir, 'lock'))
    .replaceAll('/usr/local/bin/christmasdust', join(dir, 'bin/christmasdust')).replace('[[ $EUID == 0 ]]', 'true')
    .replace('/usr/sbin:/usr/bin:/sbin:/bin', `${join(dir, 'bin')}:/usr/sbin:/usr/bin:/sbin:/bin`);
  const scriptPath = join(dir, 'updater'); await writeFile(scriptPath, script);
  const result = spawnSync('bash', [scriptPath, 'update'], { env: { ...process.env, DEPLOY_TEST_DIR: dir, DEPLOY_TEST_FAILURE: failure }, encoding: 'utf8', timeout: 15000 });
  return { result, current: await readlink(join(dir, 'root/current')), snapshot: await readFile(join(dir, 'lib/snapshot.json'), 'utf8'), old };
}
test('updater commits a prepared, healthy candidate', async t => {
  const { result, current, snapshot, old } = await transaction(t);
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.notEqual(current, old); assert.equal(snapshot.trim(), 'changed');
});
test('updater preparation failure leaves running release and data untouched', async t => {
  const { result, current, snapshot, old } = await transaction(t, 'prepare');
  assert.notEqual(result.status, 0); assert.equal(current, old); assert.equal(snapshot, 'previous-snapshot');
});
test('updater health failure automatically restores prior release and snapshot', async t => {
  const { result, current, snapshot, old } = await transaction(t, 'health');
  assert.notEqual(result.status, 0, result.stdout + result.stderr); assert.equal(current, old); assert.equal(snapshot, 'previous-snapshot');
  assert.match(result.stderr, /Previous version is healthy/);
});
