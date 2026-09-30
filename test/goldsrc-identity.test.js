import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readConfig } from '../src/config/index.js';
import { a2sFingerprint, usableServerIdentity } from '../src/domain/duplicates.js';
import { goldsrcIdentityProbe, parseGoldsrcIdentityResponse } from '../src/services/goldsrc-identity.js';
import { gameQuery } from '../src/services/query.js';

const server = { id: '8.8.8.8:27015', ip: '8.8.8.8', port: 27015 };
const response = id => Buffer.concat([Buffer.from([255, 255, 255, 255]),
  Buffer.from(`A00000000 12345678 3 ${id} 1\n\0`, 'latin1')]);
const info = () => ({ name: 'Christmas Dust', map: 'de_xmas', maxplayers: 32, version: '1.1.2.7/Stdio',
  raw: { protocol: 48, folder: 'cstrike', game: 'Counter-Strike', appId: 10 } });

test('GoldSrc challenge parser retains the exact 64-bit decimal ID and rejects unusable replies', () => {
  const id = '8412857032437472227';
  assert.equal(parseGoldsrcIdentityResponse(response(id)), id);
  for (const value of ['0', '1', '00000000000000001', '18446744073709551616', 'abc'])
    assert.equal(parseGoldsrcIdentityResponse(response(value)), null, value);
  assert.equal(parseGoldsrcIdentityResponse(Buffer.from('A00000000 1 3 8412857032437472227 1')), null);
  assert.equal(parseGoldsrcIdentityResponse(Buffer.concat([response(id), Buffer.alloc(256)])), null);
  assert.equal(usableServerIdentity(1), false);
  assert.equal(a2sFingerprint({ ...info(), serverIdentity: '1' }), null);
});

test('identity probe uses the endpoint and ignores packets from another source', async () => {
  let sent;
  const socket = new EventEmitter();
  socket.close = () => {};
  socket.send = (packet, port, ip, callback) => {
    sent = { packet, port, ip };
    callback();
    queueMicrotask(() => {
      socket.emit('message', response('8412857032437472227'), { address: '1.1.1.1', port });
      socket.emit('message', response('8412857032437472227'), { address: ip, port });
    });
  };
  assert.equal(await goldsrcIdentityProbe(server, 500, () => socket), '8412857032437472227');
  assert.equal(sent.packet.toString('latin1'), '\xff\xff\xff\xffgetchallenge steam\n');
  assert.deepEqual([sent.ip, sent.port], [server.ip, server.port]);
  assert.throws(() => goldsrcIdentityProbe({ ip: '127.0.0.1', port: 27015 }, 500, () => socket));
});

test('identity probe times out and closes its socket without a reply', async () => {
  const socket = new EventEmitter();
  let closed = false;
  socket.close = () => { closed = true; };
  socket.send = (_packet, _port, _ip, callback) => callback();
  assert.equal(await goldsrcIdentityProbe(server, 1, () => socket), null);
  assert.equal(closed, true);
});

test('GameDig query reuses successful identity, bounds retries, and leaves failures ungrouped', async () => {
  let clock = 1000; let calls = 0; let identity = '8412857032437472227';
  const query = gameQuery(readConfig({}), async () => info(), async () => { calls++; return identity; }, () => clock);
  const first = await query(server);
  assert.equal(first.serverIdentity, identity);
  assert.ok(a2sFingerprint(first));
  clock += 45000;
  assert.equal((await query(server)).serverIdentity, identity);
  assert.equal(calls, 1);
  clock += 600000;
  identity = '1';
  assert.equal((await query(server)).serverIdentity, undefined);
  assert.equal(calls, 2);
  assert.equal((await query(server)).serverIdentity, undefined);
  assert.equal(calls, 2);
  clock += 300000;
  const failed = gameQuery(readConfig({}), async () => info(), async () => { throw Error('timeout'); });
  assert.equal((await failed(server)).serverIdentity, undefined);
  let unexpectedProbe = false;
  const direct = gameQuery(readConfig({}), async () => ({ ...info(), raw: { ...info().raw, steamid: '8412857032437472227' } }),
    async () => { unexpectedProbe = true; return null; });
  assert.equal((await direct(server)).raw.steamid, '8412857032437472227');
  assert.equal(unexpectedProbe, false);
});

test('two GoldSrc endpoints with the same probed identity yield the same conservative fingerprint', async () => {
  const query = gameQuery(readConfig({}), async () => info(), async () => '8412857032437472227');
  const a = await query(server);
  const b = await query({ id: '1.1.1.1:27015', ip: '1.1.1.1', port: 27015 });
  assert.equal(a2sFingerprint(a), a2sFingerprint(b));
  assert.equal(a.version, '1.1.2.7/Stdio');
});
