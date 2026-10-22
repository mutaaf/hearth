import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import dgram from 'node:dgram';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import tls from 'node:tls';
import { after, mock, test } from 'node:test';
import forge from 'node-forge';
import { AtvBridge } from '../src/atv-bridge.js';
import { Backoff } from '../src/backoff.js';
import { Driver } from '../src/drivers/base.js';
import { GoogleTvDriver } from '../src/drivers/googletv.js';
import { AtvRemote } from '../src/drivers/googletv-remote.js';
import { asOffline, isUnreachable } from '../src/errors.js';
import { createHostCheck, createLimiter, isForbiddenTarget, isPrivateIp } from '../src/guard.js';
import { Hub } from '../src/hub.js';
import { readJson, writeJson } from '../src/jsonfile.js';
import { rotate } from '../src/log.js';
import { SceneStore } from '../src/scenes.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { Telemetry } from '../src/telemetry.js';
import { encode, frame } from '../src/proto.js';
import { wake } from '../src/wol.js';

// Everything that used to crash, wedge or lie: corrupt files, sockets that
// error twice, garbage frames, half-open connections, races, hostile pages.
const dirs = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'hearth-res-'));
  dirs.push(d);
  return d;
};
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// ── Persistence ──────────────────────────────────────────
test('store: an empty, null or junk tvs.json never stops startup; the backup comes back', async () => {
  const dir = tmp();
  const store = new Store(dir);
  await store.save([{ id: 'a', brand: 'lg', ip: '10.0.0.5', credentials: { clientKey: 'k1' } }]);
  await store.save([{ id: 'a', brand: 'lg', ip: '10.0.0.5', credentials: { clientKey: 'k2' } }]);
  // A power cut mid-write leaves an empty file: the previous good copy (.bak) wins.
  writeFileSync(store.file, '');
  const restored = await store.load();
  assert.equal(restored[0].credentials.clientKey, 'k1');
  assert.ok(readdirSync(dir).some((f) => f.startsWith('tvs.json.corrupt-')), 'the bad copy is kept aside');
  // The next save must not back up the corrupt file over the good backup.
  await store.save(restored);
  assert.equal(JSON.parse(readFileSync(`${store.file}.bak`, 'utf8')).tvs[0].credentials.clientKey, 'k1');

  for (const junk of ['null', '{"tvs":', '[1,2]', '{"tvs":"no"}']) {
    const d = tmp();
    writeFileSync(path.join(d, 'tvs.json'), junk);
    assert.deepEqual(await new Store(d).load(), [], `junk: ${junk}`);
    assert.ok(readdirSync(d).some((f) => f.startsWith('tvs.json.corrupt-')));
  }
  assert.deepEqual(await new Store(tmp()).load(), [], 'first run');
  assert.equal(statSync(store.file).mode & 0o777, 0o600, 'pairing keys stay private');
});

test('scenes and telemetry: corrupt files fall back instead of throwing or being overwritten blind', async () => {
  const d = tmp();
  writeFileSync(path.join(d, 'scenes.json'), 'null');
  assert.equal(await new SceneStore(d).load(), null, 'null → re-seed');
  const ss = new SceneStore(d);
  await ss.save([{ id: 's1', name: 'Movie' }]);
  await ss.save([{ id: 's1', name: 'Movie night' }]);
  writeFileSync(ss.file, '{"scenes": [');
  assert.equal((await ss.load())[0].name, 'Movie');

  writeFileSync(path.join(d, 'telemetry.json'), '{"tvs":');
  const t = await new Telemetry({ dir: d }).load();
  assert.equal(t.tvs.size, 0);
  assert.ok(readdirSync(d).some((f) => f.startsWith('telemetry.json.corrupt-')), 'kept aside, not overwritten');
  // Overlapping saves (timer + flush) each use their own temp file and all land.
  t.rec('tv1');
  await Promise.all([t.save(), t.save(), t.flush()]);
  assert.ok(JSON.parse(readFileSync(path.join(d, 'telemetry.json'), 'utf8')).tvs.tv1);
  assert.ok(!readdirSync(d).some((f) => f.endsWith('.tmp')), 'no temp files left behind');
});

test('writeJson/readJson: missing file with a backup (crash between steps) restores it', async () => {
  const d = tmp();
  const f = path.join(d, 'x.json');
  await writeJson(f, { v: 1 });
  await writeJson(f, { v: 2 });
  rmSync(f);
  assert.deepEqual(await readJson(f, (x) => x), { v: 1 });
});

// ── Process-level: errors with no listener ───────────────
test('Wake-on-LAN: a socket that errors (asynchronously, twice) never crashes the process', async () => {
  const sock = new EventEmitter();
  Object.assign(sock, {
    bind: (cb) => setImmediate(cb),
    setBroadcast() {},
    send(_p, _port, _host, cb) {
      setImmediate(() => {
        sock.emit('error', Object.assign(new Error('send ENETUNREACH'), { code: 'ENETUNREACH' }));
        cb?.();
      });
    },
    close() {
      setImmediate(() => sock.emit('error', new Error('late error after close')));
    },
  });
  const m = mock.method(dgram, 'createSocket', () => sock);
  try {
    await wake(['aa:bb:cc:dd:ee:ff'], '192.168.4.45');
    await new Promise((r) => setTimeout(r, 20)); // the late error lands on a listener
  } finally {
    m.mock.restore();
  }
});

test('Apple TV helper: Python dying mid-write (EPIPE on stdin) fails the request, not Hearth', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    },
  });
  child.kill = () => {};
  const bridge = new AtvBridge({ python: process.execPath, script: 'x', spawnFn: () => child });
  const ready = bridge.start();
  child.stdout.write('{"event":"ready","pyatv":"0"}\n');
  await ready;
  await assert.rejects(bridge.request('info', {}, { timeout: 1000 }), (e) => e.status === 503);
  await bridge.close();
});

// ── Network errors are "off or unreachable", never 500 ───
test('unreachable errors (EHOSTDOWN, timeouts, handshake) map to offline 503', () => {
  for (const code of ['EHOSTDOWN', 'ETIMEDOUT', 'ENETUNREACH', 'ECONNRESET', 'ECONNREFUSED']) {
    assert.equal(asOffline(Object.assign(new Error(code), { code })).status, 503, code);
  }
  assert.ok(isUnreachable(new Error('Opening handshake has timed out')));
  assert.ok(isUnreachable(Object.assign(new Error('x'), { name: 'TimeoutError' })));
  assert.ok(!isUnreachable(new Error('TypeError: x is undefined')));
});

// ── Backoff ──────────────────────────────────────────────
test('backoff: doubles with jitter up to the cap; resets only after staying up', () => {
  let t = 0;
  const b = new Backoff({ min: 2000, max: 60_000, jitter: 0.2, random: () => 0.5, now: () => t });
  assert.deepEqual([b.next(), b.next(), b.next()], [2000, 4000, 8000]);
  for (let i = 0; i < 10; i++) b.next();
  assert.equal(b.next(), 60_000);
  b.up();
  t += 5000; // dropped again after 5 s: keep backing off
  assert.equal(b.next(), 60_000);
  b.up();
  t += 61_000; // stayed up a minute: start over
  assert.equal(b.next(), 2000);
  const j = new Backoff({ min: 1000, jitter: 0.2, random: () => 0 });
  assert.equal(j.next(), 800);
});

// ── Cast: garbage frames drop the socket, not the process ─
function selfSigned() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const priv = forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(priv.n, priv.e);
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400e3);
  cert.validity.notAfter = new Date(Date.now() + 86400e3);
  cert.setSubject([{ name: 'commonName', value: 'fake' }]);
  cert.setIssuer([{ name: 'commonName', value: 'fake' }]);
  cert.sign(priv, forge.md.sha256.create());
  return { key: forge.pki.privateKeyToPem(priv), cert: forge.pki.certificateToPem(cert) };
}
const IDENTITY = selfSigned();
const castFrame = (payload) => {
  const body = encode({ 1: 0, 2: 'receiver-0', 3: 'sender-0', 4: 'urn:x-cast:com.google.cast.receiver', 5: 0, 6: payload });
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
};

test('Cast: a null payload, then a huge length prefix: the socket drops and reconnects, Hearth lives', async () => {
  let connections = 0;
  const server = tls.createServer(IDENTITY, (sock) => {
    connections++;
    sock.on('error', () => {});
    sock.once('data', () => {
      // GET_STATUS answer first (so it connects), then garbage.
      sock.write(castFrame(JSON.stringify({ type: 'RECEIVER_STATUS', requestId: 1, status: { volume: { level: 0.1 } } })));
      sock.write(castFrame('null'));
      setTimeout(() => {
        const huge = Buffer.alloc(8);
        huge.writeUInt32BE(0x7fffffff);
        sock.write(huge);
      }, 30);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const driver = new GoogleTvDriver({ id: 'g', brand: 'androidtv', name: 'G', ip: '127.0.0.1', macs: [], credentials: { cast: true } }, { port: server.address().port });
  try {
    const offline = new Promise((resolve) => driver.on('state', (s) => s.online === false && resolve()));
    driver.start();
    await offline; // the oversized frame dropped the socket
    assert.ok(connections >= 1);
  } finally {
    await driver.stop();
    server.close();
  }
});

test('Cast: many callers at once share one connection (no leaked sockets or heartbeats)', async () => {
  let connections = 0;
  const server = tls.createServer(IDENTITY, (sock) => {
    connections++;
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
        const n = buf.readUInt32BE(0);
        const text = buf.subarray(4, 4 + n).toString();
        buf = buf.subarray(4 + n);
        const id = text.match(/"requestId":(\d+)/)?.[1];
        if (id) sock.write(castFrame(JSON.stringify({ type: 'RECEIVER_STATUS', requestId: Number(id), status: { volume: { level: 0.2, muted: false } } })));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const driver = new GoogleTvDriver({ id: 'g2', brand: 'androidtv', name: 'G', ip: '127.0.0.1', macs: [], credentials: { cast: true } }, { port: server.address().port });
  try {
    await Promise.all([driver.verify(), driver.verify(), driver.verify(), driver.verify()]);
    assert.equal(connections, 1);
  } finally {
    await driver.stop();
    server.close();
  }
});

// ── Google remote: a half-open socket is noticed ─────────
test('Google TV remote: no ping for silenceMs drops the "ready" socket', async () => {
  const server = tls.createServer({ ...IDENTITY, requestCert: true, rejectUnauthorized: false }, (sock) => {
    sock.on('error', () => {});
    // Configure + set_active, then total silence (Wi-Fi gone, no FIN).
    sock.write(frame({ 1: { 1: 622 } }));
    sock.write(frame({ 2: { 1: 622 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const remote = new AtvRemote({ host: '127.0.0.1', port: server.address().port, cert: IDENTITY.cert, key: IDENTITY.key, silenceMs: 250 });
  try {
    const closed = new Promise((r) => remote.once('close', r));
    await remote.connect(3000);
    assert.equal(remote.ready, true);
    await closed;
    assert.equal(remote.ready, false);
    assert.throws(() => remote.key(19), (e) => e.status === 503, 'keys no longer "succeed" into a dead socket');
  } finally {
    remote.close();
    server.close();
  }
});

// ── Hub races ────────────────────────────────────────────
class QuietDriver extends Driver {
  static brand = 'lg';
  static started = 0;
  static live = new Set();
  start() {
    QuietDriver.started++;
    QuietDriver.live.add(this);
  }
  async stop() {
    await new Promise((r) => setTimeout(r, 10));
    QuietDriver.live.delete(this);
  }
}

test('hub: overlapping scans run once; a moved TV is healed once, leaving one live driver', async () => {
  let calls = 0;
  const store = new Store(tmp());
  await store.save([{ id: 'lg-1', brand: 'lg', name: 'Den', ip: '10.0.0.5', macs: ['aa:bb:cc:00:00:01'], credentials: { clientKey: 'k' } }]);
  QuietDriver.live.clear();
  const hub = await new Hub({
    store,
    drivers: { lg: QuietDriver },
    macForFn: async () => null,
    discoverFn: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return [{ id: 'lg-1', brand: 'lg', name: 'Den', ip: '10.0.0.77', macs: ['aa:bb:cc:00:00:01'] }];
    },
  }).init();
  const healed = [];
  hub.on('healed', (h) => healed.push(h));
  try {
    await Promise.all([hub.scan(), hub.scan(), hub.scan()]);
    assert.equal(calls, 1);
    // Two heals of the same TV at once (e.g. doctor + timer) → one move.
    await Promise.all([hub.relocate('lg-1', '10.0.0.88'), hub.relocate('lg-1', '10.0.0.88')]);
    assert.equal(hub.get('lg-1').ip, '10.0.0.88');
    assert.equal(healed.length, 2, 'one heal from the scan, one move');
    assert.equal(QuietDriver.live.size, 1, 'exactly one live driver');
  } finally {
    await hub.close();
  }
});

test('hub: two adds for the same address make one TV; special addresses are refused', async () => {
  let probes = 0;
  const hub = await new Hub({
    store: new Store(tmp()),
    drivers: { lg: QuietDriver },
    macForFn: async () => null,
    probeFn: async (ip) => {
      probes++;
      await new Promise((r) => setTimeout(r, 20));
      return { brand: 'lg', name: 'Den', ip, macs: ['aa:bb:cc:00:00:09'] };
    },
  }).init();
  try {
    const [a, b] = await Promise.all([hub.add({ ip: '10.0.0.9' }), hub.add({ ip: '10.0.0.9' })]);
    assert.equal(a.id, b.id);
    assert.equal(hub.tvs.length, 1);
    assert.equal(probes, 1);
    for (const ip of ['127.0.0.1', '169.254.1.1', '224.0.0.251', '0.0.0.0']) {
      await assert.rejects(hub.add({ ip }), (e) => e.status === 400, ip);
      await assert.rejects(hub.update(a.id, { ip }), (e) => e.status === 400, ip);
    }
    await hub.remove(a.id);
    assert.equal(hub.tvs.length, 0);
  } finally {
    await hub.close();
  }
});

// ── HTTP layer: hosts, origins, icons, limits, SSE, slow TVs ──
class HttpDriver extends Driver {
  static brand = 'lg';
  start() {
    this.setState({ online: true, power: 'on' });
  }
  async key() {
    throw Object.assign(new Error('connect EHOSTDOWN 10.0.0.5:3001'), { code: 'EHOSTDOWN' });
  }
  async apps() {
    return [{ id: 'nf', title: 'Netflix', icon: 'http://10.0.0.5:3000/icon.png' }];
  }
}

async function httpRig({ limiter } = {}) {
  const store = new Store(tmp());
  await store.save([{ id: 'lg-h', brand: 'lg', name: 'Den', ip: '10.0.0.5', macs: [], credentials: { clientKey: 'k' } }]);
  const hub = await new Hub({ store, drivers: { lg: HttpDriver }, discoverFn: async () => [] }).init();
  const viewers = [];
  const setViewers = hub.setViewers.bind(hub);
  hub.setViewers = (n) => {
    viewers.push(n);
    setViewers(n);
  };
  const server = createServer(hub, { hostCheck: createHostCheck({ friendlyUrl: 'http://azizfamily.local/tv', extra: '' }), ...(limiter ? { limiter } : {}) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  return { hub, server, port, base, viewers, close: async () => {
    server.closeAllConnections?.();
    server.close();
    await hub.close();
  } };
}

// fetch() won't let us set Host; use node:http for those.
const raw = (port, { method = 'GET', path: p = '/api/health', headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

test('http: DNS-rebinding hosts and cross-site origins are refused; LAN names work', async () => {
  const rig = await httpRig();
  try {
    assert.equal((await raw(rig.port, { headers: { host: 'evil.example:8770' } })).status, 421);
    for (const host of ['localhost:8770', '192.168.4.29:8770', 'azizfamily.local', 'mutaafs-mac.local:8770', 'mac-mini:8770', '[::1]:8770']) {
      assert.equal((await raw(rig.port, { headers: { host } })).status, 200, host);
    }
    const post = (origin) => raw(rig.port, { method: 'POST', path: '/api/all/power', headers: { host: '192.168.4.29:8770', 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: '{"on":false}' });
    assert.equal((await post('http://evil.example')).status, 403);
    assert.equal((await post('null')).status, 403);
    assert.equal((await post('http://192.168.4.29:8770')).status, 200);
    assert.equal((await post()).status, 200, 'no Origin (curl, scripts) is fine');
  } finally {
    await rig.close();
  }
});

test('http: the icon proxy only fetches icons the TV listed; PATCH ip refuses loopback', async () => {
  const rig = await httpRig();
  try {
    const icon = (u) => fetch(`${rig.base}/api/tvs/lg-h/icon?u=${encodeURIComponent(u)}`);
    assert.equal((await icon('http://10.0.0.5:8080/admin')).status, 403);
    assert.equal((await icon('http://127.0.0.1:22/')).status, 400);
    const patch = await fetch(`${rig.base}/api/tvs/lg-h`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"ip":"127.0.0.1"}' });
    assert.equal(patch.status, 400);
  } finally {
    await rig.close();
  }
});

test('http: a TV that is down answers 503 in plain words, not 500', async () => {
  const rig = await httpRig();
  try {
    const res = await fetch(`${rig.base}/api/tvs/lg-h/key`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"key":"up"}' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /off or not reachable/);
  } finally {
    await rig.close();
  }
});

test('http: scans, doctor runs and AI calls are rate limited per client', async () => {
  const rig = await httpRig({ limiter: createLimiter({ capacity: 2, refillMs: 60_000 }) });
  try {
    const scan = () => fetch(`${rig.base}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await scan()).status, 200);
    assert.equal((await scan()).status, 200);
    const third = await scan();
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    // Other routes are untouched.
    assert.equal((await fetch(`${rig.base}/api/tvs`)).status, 200);
  } finally {
    await rig.close();
  }
});

test('http: an SSE client that leaves is no longer counted as a viewer', async () => {
  const rig = await httpRig();
  try {
    const ac = new AbortController();
    const res = await fetch(`${rig.base}/api/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    await reader.read(); // hello
    assert.equal(rig.viewers.at(-1), 1);
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(rig.viewers.at(-1), 0);
    assert.equal(rig.hub.viewers, 0);
  } finally {
    await rig.close();
  }
});

// ── Guard + logs ─────────────────────────────────────────
test('guard: private ranges and forbidden TV addresses', () => {
  assert.ok(isPrivateIp('192.168.4.29') && isPrivateIp('10.1.2.3') && isPrivateIp('172.20.0.1') && isPrivateIp('100.101.1.1'));
  assert.ok(!isPrivateIp('8.8.8.8') && !isPrivateIp('172.32.0.1'));
  assert.ok(isForbiddenTarget('127.0.0.1') && isForbiddenTarget('169.254.3.3') && isForbiddenTarget('239.255.255.250') && isForbiddenTarget('::1'));
  assert.ok(!isForbiddenTarget('192.168.4.45') && !isForbiddenTarget('192.168.5.0'), 'a /22 has hosts at .0');
});

test('logs rotate at the size limit, keep 3, and stay private', async () => {
  const d = tmp();
  const f = path.join(d, 'hearth.log');
  for (let i = 1; i <= 4; i++) {
    writeFileSync(f, `run ${i} `.repeat(200));
    assert.equal(await rotate(f, { maxBytes: 100, keep: 3 }), true);
    assert.equal(statSync(f).size, 0, 'truncated in place (launchd keeps appending)');
  }
  assert.match(readFileSync(`${f}.1`, 'utf8'), /^run 4/);
  assert.match(readFileSync(`${f}.3`, 'utf8'), /^run 2/);
  assert.ok(!existsSync(`${f}.4`));
  assert.equal(statSync(`${f}.1`).mode & 0o777, 0o600);
  assert.equal(await rotate(f, { maxBytes: 100 }), false, 'small files are left alone');
});
