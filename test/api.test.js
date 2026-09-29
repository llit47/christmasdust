import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/routes/app.js';
import { readConfig } from '../src/config/index.js';
async function fixture(t, env = {}) {
  const calls = []; const monitor = { ready: true, busy: null, snapshot: () => ({ servers: [], meta: { stale: true } }), run: async kind => { calls.push(kind); } };
  const app = createApp({ config: readConfig(env), monitor, geoip: () => ({ countryCode: 'DE', latitude: 1, longitude: 2 }) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { monitor, calls, get: (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options) };
}
test('public polling never triggers discovery; visitor location is country only', async t => {
  const { get, calls } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const response = await get('/api/servers', { headers: { 'CF-IPCountry': 'US', 'X-Forwarded-For': '8.8.8.8' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('content-security-policy').includes("script-src 'self'"));
    const body = await response.json(); assert.deepEqual(body.visitor, { countryCode: 'DE' });
  }
  assert.deepEqual(calls, []); assert.equal((await get('/api/query?ip=127.0.0.1')).status, 404);
});
test('health and readiness work independently of upstream freshness', async t => {
  const { get, monitor } = await fixture(t); assert.equal((await get('/api/ready')).status, 200);
  const body = await (await get('/api/health')).json(); assert.equal(body.version, '0.1.0'); assert.equal(body.stale, true);
  monitor.ready = false; assert.equal((await get('/api/ready')).status, 503);
});
test('Cloudflare headers require explicitly trusted immediate proxy', async t => {
  const { get } = await fixture(t, { TRUST_CF_COUNTRY: 'true', TRUSTED_PROXIES: '127.0.0.1/32' });
  assert.equal((await (await get('/api/servers', { headers: { 'CF-IPCountry': 'PL' } })).json()).visitor.countryCode, 'PL');
  const other = await fixture(t, { TRUST_CF_COUNTRY: 'true', TRUSTED_PROXIES: '1.1.1.1/32' });
  assert.equal((await (await other.get('/api/servers', { headers: { 'CF-IPCountry': 'PL' } })).json()).visitor.countryCode, 'DE');
});
test('admin disabled by default; auth, busy response and cooldown when enabled', async t => {
  const initial = await fixture(t); assert.equal((await initial.get('/api/admin/refresh', { method: 'POST' })).status, 404);
  const token = 'z'.repeat(32); const { get, calls, monitor } = await fixture(t, { ADMIN_TOKEN: token });
  assert.equal((await get('/api/admin/refresh', { method: 'POST' })).status, 401);
  const options = { method: 'POST', headers: { Authorization: `Bearer ${token}` } };
  monitor.busy = 'live'; assert.equal((await get('/api/admin/refresh', options)).status, 409); monitor.busy = null;
  assert.equal((await get('/api/admin/refresh', options)).status, 202);
  assert.equal((await get('/api/admin/refresh', options)).status, 429); assert.deepEqual(calls, ['discovery', 'live']);
});
test('frontend assets served with strict headers; unknown routes reveal no stack', async t => {
  const { get } = await fixture(t); const response = await get('/'); assert.equal(response.status, 200);
  assert.match(await response.text(), /Winter server browser/); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await get('/.env')).status, 404); assert.equal((await get('/api/unknown')).status, 404);
});
test('all API request bodies are rejected before they can cause work', async t => {
  const { get, calls } = await fixture(t, { ADMIN_TOKEN: 'a'.repeat(32) });
  assert.equal((await get('/api/admin/refresh', { method: 'POST', body: '{"target":"127.0.0.1"}', headers: { Authorization: `Bearer ${'a'.repeat(32)}` } })).status, 413);
  assert.deepEqual(calls, []);
});
