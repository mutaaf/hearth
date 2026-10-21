import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import tls from 'node:tls';
import { after, before, test } from 'node:test';
import forge from 'node-forge';
import { GoogleTvDriver } from '../src/drivers/googletv.js';
import { decode, encode, str } from '../src/proto.js';

// A pretend Google TV speaking Cast over TLS on localhost: answers GET_STATUS
// (with isStandBy), GET_APP_AVAILABILITY and LAUNCH; can go silent.
function selfSigned() {
  // Native keygen (fast); forge only builds the certificate.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const priv = forge.pki.privateKeyFromPem(pem);
  const keys = { privateKey: priv, publicKey: forge.pki.setRsaPublicKey(priv.n, priv.e) };
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 86400e3);
  const attrs = [{ name: 'commonName', value: 'fake-cast' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
}

const fake = { standby: false, app: null, silent: false, launched: [], available: ['233637DE', '32EAB1DF'] };
let server;
let port;
const sockets = new Set();

function frame(namespace, payload) {
  const body = encode({ 1: 0, 2: 'receiver-0', 3: 'sender-0', 4: namespace, 5: 0, 6: JSON.stringify(payload) });
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}
const status = (requestId = 0) => ({
  type: 'RECEIVER_STATUS',
  requestId,
  status: {
    isStandBy: fake.standby,
    volume: { controlType: 'master', level: 0.27, muted: false },
    ...(fake.app ? { applications: [{ appId: fake.app.id, displayName: fake.app.title, sessionId: 's1', isIdleScreen: false }] } : {}),
  },
});

before(async () => {
  server = tls.createServer(selfSigned(), (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (buf.length < 4 + n) break;
        const msg = decode(buf.subarray(4, 4 + n));
        buf = buf.subarray(4 + n);
        if (fake.silent) continue;
        const p = JSON.parse(str(msg, 6) ?? '{}');
        const ns = str(msg, 4);
        if (p.type === 'PING') sock.write(frame(ns, { type: 'PONG' }));
        if (p.type === 'GET_STATUS') sock.write(frame(ns, status(p.requestId)));
        if (p.type === 'GET_APP_AVAILABILITY') {
          const availability = Object.fromEntries(p.appId.map((id) => [id, fake.available.includes(id) ? 'APP_AVAILABLE' : 'APP_UNAVAILABLE']));
          sock.write(frame(ns, { type: 'GET_APP_AVAILABILITY', responseType: 'GET_APP_AVAILABILITY', requestId: p.requestId, availability }));
        }
        if (p.type === 'LAUNCH') {
          fake.launched.push(p.appId);
          if (!fake.available.includes(p.appId)) sock.write(frame(ns, { type: 'LAUNCH_ERROR', reason: 'NOT_FOUND', requestId: p.requestId }));
          else {
            fake.standby = false;
            fake.app = { id: p.appId, title: p.appId === '32EAB1DF' ? 'YouTube TV' : 'YouTube' };
            sock.write(frame(ns, status(p.requestId)));
          }
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => {
  for (const s of sockets) s.destroy();
  server.close();
});

const makeDriver = () => new GoogleTvDriver({ id: 'atv', brand: 'androidtv', name: 'Upstairs', ip: '127.0.0.1', macs: [], credentials: { cast: true } }, { port });
const until = (driver, pred) => new Promise((resolve) => {
  if (pred(driver.state)) return resolve(driver.state);
  const on = (s) => pred(s) && (driver.off('state', on), resolve(s));
  driver.on('state', on);
});

test('standby is real: isStandBy → power standby with nothing playing (it used to say "on")', async () => {
  Object.assign(fake, { standby: true, app: null, silent: false });
  const driver = makeDriver();
  try {
    driver.start();
    const s = await until(driver, (st) => st.online);
    assert.deepEqual([s.power, s.app, s.volume], ['standby', null, 27]);
  } finally {
    await driver.stop();
  }
});

test('apps are the catalog Cast apps the TV says it can open; launch reports what came up', async () => {
  Object.assign(fake, { standby: false, app: null, silent: false, launched: [] });
  const driver = makeDriver();
  try {
    driver.start();
    await until(driver, (st) => st.online);
    const apps = await driver.apps();
    assert.deepEqual(apps.map((a) => a.title), ['YouTube', 'YouTube TV']);
    await driver.launch('32EAB1DF');
    const s = await until(driver, (st) => st.app === '32EAB1DF');
    assert.deepEqual([s.power, s.appTitle], ['on', 'YouTube TV']);
    await assert.rejects(driver.launch('CA5E8412'), /couldn’t open/);
  } finally {
    await driver.stop();
  }
});

test('a socket that goes quiet (TV unplugged, Wi-Fi gone) is dropped, not trusted', async () => {
  Object.assign(fake, { standby: false, app: { id: '233637DE', title: 'YouTube' }, silent: false });
  const driver = new GoogleTvDriver({ id: 'atv', brand: 'androidtv', name: 'Upstairs', ip: '127.0.0.1', macs: [], credentials: { cast: true } }, { port, staleMs: 200 });
  try {
    driver.start();
    await until(driver, (st) => st.app === '233637DE');
    fake.silent = true;
    const s = await until(driver, (st) => !st.online);
    assert.deepEqual([s.power, s.app], ['off', null]);
  } finally {
    fake.silent = false;
    await driver.stop();
  }
});

test('refresh() re-reads the receiver status', async () => {
  Object.assign(fake, { standby: false, app: { id: '233637DE', title: 'YouTube' }, silent: false });
  const driver = makeDriver();
  try {
    driver.start();
    await until(driver, (st) => st.app === '233637DE');
    fake.standby = true;
    await driver.refresh();
    assert.deepEqual([driver.state.power, driver.state.app], ['standby', null]);
  } finally {
    await driver.stop();
  }
});
