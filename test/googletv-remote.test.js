import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import tls from 'node:tls';
import { after, before, test } from 'node:test';
import {
  ANDROID_KEYS,
  AtvPairing,
  AtvRemote,
  DIRECTION,
  keyNumbersFromPeer,
  keyNumbersFromPem,
  makeIdentity,
  pairingSecret,
} from '../src/drivers/googletv-remote.js';
import { decode, first, frame, sub, unframe } from '../src/proto.js';

// A pretend Google TV: the pairing service shows a code (we read it from
// `shown`), and the remote service only accepts the certificate it paired.
const tvId = makeIdentity('Pretend TV');
const tvNums = keyNumbersFromPem(tvId.cert);
let pairSrv;
let remoteSrv;
let pairPort;
let remotePort;
let shown = null; // the code "on screen"
let trusted = null; // client cert fingerprint the TV accepted
const received = []; // remote messages from Hearth

function serve(handler) {
  const srv = tls.createServer({ cert: tvId.cert, key: tvId.key, requestCert: true, rejectUnauthorized: false }, (sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      const [msgs, rest] = unframe(Buffer.concat([buf, d]));
      buf = rest;
      for (const m of msgs) handler(sock, decode(m));
    });
    sock.on('error', () => {});
    handler(sock, null);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

before(async () => {
  pairSrv = await serve((sock, msg) => {
    if (!msg) return;
    const reply = (m) => sock.write(frame({ 1: 2, 2: 200, ...m }));
    if (msg[10]) return reply({ 11: {} });
    if (msg[20]) return reply({ 20: { 1: [{ 1: 3, 2: 6 }], 3: 1 } });
    if (msg[30]) {
      // "Show" a code: random nonce, first byte from the secret hash.
      const nonce = crypto.randomBytes(2);
      const client = keyNumbersFromPeer(sock.getPeerCertificate());
      const probe = `00${nonce.toString('hex')}`;
      const { secret } = pairingSecret(client, tvNums, probe);
      shown = (secret[0].toString(16).padStart(2, '0') + nonce.toString('hex')).toUpperCase();
      return reply({ 31: {} });
    }
    if (msg[40]) {
      const client = keyNumbersFromPeer(sock.getPeerCertificate());
      const { secret } = pairingSecret(client, tvNums, shown);
      if (Buffer.compare(sub(msg, 40)[1][0], secret) !== 0) return sock.write(frame({ 1: 2, 2: 402 }));
      trusted = sock.getPeerCertificate().fingerprint256;
      return reply({ 41: {} });
    }
  });
  remoteSrv = await serve((sock, msg) => {
    if (!msg) {
      if (sock.getPeerCertificate().fingerprint256 !== trusted) return sock.destroy();
      return sock.write(frame({ 1: { 1: 622, 2: { 1: 'Pretend TV' } } }));
    }
    received.push(msg);
    if (msg[1]) sock.write(frame({ 2: { 1: 622 } }));
    if (msg[2]) {
      sock.write(frame({ 8: { 1: 7 } }));
      sock.write(frame({ 40: { 1: 1 } }));
      sock.write(frame({ 50: { 6: 100, 7: 30, 8: 0 } }));
    }
  });
  pairPort = pairSrv.address().port;
  remotePort = remoteSrv.address().port;
});
after(() => {
  // Don't let a failed test keep sockets (and the run) alive.
  for (const srv of [pairSrv, remoteSrv]) {
    srv.close();
    srv.closeAllConnections?.();
  }
});

const me = makeIdentity();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the secret ties both keys to the code; a mistyped code is caught locally', () => {
  const ours = keyNumbersFromPem(me.cert);
  assert.match(ours.e, /^0[0-9A-F]+$/);
  assert.equal(ours.e, '010001');
  assert.throws(() => pairingSecret(ours, tvNums, 'XYZ123'), (e) => e.status === 400);
  const a = pairingSecret(ours, tvNums, '00ABCD');
  assert.equal(a.secret.length, 32);
});

test('wrong code → friendly 400 and nothing sent; right code pairs', async () => {
  const pairing = new AtvPairing({ host: '127.0.0.1', port: pairPort, cert: me.cert, key: me.key });
  assert.deepEqual(await pairing.start(), { needsCode: true });
  assert.match(shown, /^[0-9A-F]{6}$/);
  // Flip the first byte: guaranteed mismatch, rejected before sending.
  const bad = ((parseInt(shown.slice(0, 2), 16) + 1) % 256).toString(16).padStart(2, '0') + shown.slice(2);
  await assert.rejects(pairing.finish(bad), (e) => e.status === 400 && /doesn’t match/.test(e.message));
  assert.equal(trusted, null, 'the TV never got a secret');
  await pairing.finish(shown.toLowerCase());
  assert.ok(trusted, 'the TV trusts our certificate now');
});

test('remote: handshake, ping/pong, state pushes, short and long presses', async () => {
  const remote = new AtvRemote({ host: '127.0.0.1', port: remotePort, cert: me.cert, key: me.key });
  const states = [];
  remote.on('state', (s) => states.push(s));
  test.after?.(() => remote.close());
  await remote.connect();
  assert.equal(remote.ready, true);
  await wait(100);
  assert.ok(received.some((m) => m[1]), 'answered configure');
  assert.ok(received.some((m) => m[2]), 'answered set_active');
  assert.equal(first(sub(received.find((m) => m[9]), 9), 1), 7, 'pong echoes the ping value');
  assert.deepEqual(states.find((s) => 'started' in s), { started: true });
  assert.deepEqual(states.find((s) => 'volume' in s), { volume: 30, muted: false });

  remote.key(ANDROID_KEYS.right);
  remote.key(ANDROID_KEYS.ok, DIRECTION.START_LONG);
  remote.key(ANDROID_KEYS.ok, DIRECTION.END_LONG);
  await wait(100);
  const keys = received.filter((m) => m[10]).map((m) => [first(sub(m, 10), 1), first(sub(m, 10), 2)]);
  assert.deepEqual(keys, [[22, 3], [23, 1], [23, 2]]);
  remote.close();
});

test('a certificate the TV never paired is refused with a 401 to re-unlock', async () => {
  const stranger = makeIdentity('Stranger');
  const remote = new AtvRemote({ host: '127.0.0.1', port: remotePort, cert: stranger.cert, key: stranger.key });
  await assert.rejects(remote.connect(2000), (e) => e.status === 401);
});
