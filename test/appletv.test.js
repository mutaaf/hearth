import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AtvBridge, setBridge } from '../src/atv-bridge.js';
import { appleTvFromAirplayInfo, appleTvsFrom } from '../src/discovery.js';
import { AppleTvDriver } from '../src/drivers/appletv.js';
import { HearthError } from '../src/errors.js';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';

// A pretend pyatv bridge: answers the same JSON ops the Python process does,
// with one Apple TV that shows a code per protocol and accepts "1234".
class FakeBridge extends EventEmitter {
  available = true;
  reason = '';
  calls = [];
  pairing = null;
  connected = new Map();
  apps = [{ id: 'com.netflix.Netflix', title: 'Netflix' }, { id: 'com.google.ios.youtube', title: 'YouTube' }];
  services = { companion: { port: 49153, pairing: 'Mandatory' }, airplay: { port: 7000, pairing: 'Mandatory' } };
  state = { online: true, power: 'on', app: null, appTitle: null, title: null, playing: null, volume: null, volumeLevel: false };

  async request(op, args = {}) {
    this.calls.push([op, args]);
    const fail = (status, code, msg) => {
      const err = new HearthError(status, msg);
      err.code = code;
      throw err;
    };
    switch (op) {
      case 'info':
        return { name: 'Media Room', ip: args.ip, identifier: 'E2:AC:BD:99:96:BD', model: 'AppleTV11,1', services: this.services };
      case 'pair_begin':
        this.pairing = { key: args.key, protocol: args.protocol };
        return { protocol: args.protocol, devicePin: true, identifier: 'E2:AC:BD:99:96:BD' };
      case 'pair_pin': {
        const p = this.pairing;
        this.pairing = null;
        if (!p) fail(410, 'expired', 'expired');
        if (args.pin !== '1234') fail(401, 'auth', 'bad pin');
        return { protocol: p.protocol, credentials: `${p.protocol}-secret` };
      }
      case 'pair_cancel':
        this.pairing = null;
        return {};
      case 'connect':
        this.connected.set(args.key, args.credentials);
        return { identifier: 'E2:AC:BD:99:96:BD', ip: args.ip, state: this.state };
      case 'disconnect':
        this.connected.delete(args.key);
        return {};
      case 'remote':
      case 'text':
      case 'power':
      case 'launch':
      case 'set_volume':
        if (!this.connected.has(args.key)) fail(503, 'offline', 'Not connected to that Apple TV');
        return {};
      case 'apps':
        return this.apps;
      default:
        fail(501, 'unsupported', `Unknown op ${op}`);
    }
  }

  push(key, state) {
    this.emit('state', { event: 'state', key, state: { ...this.state, ...state } });
  }

  sent(op) {
    return this.calls.filter(([o]) => o === op).map(([, a]) => a);
  }
}

const tick = () => new Promise((r) => setImmediate(r));

function makeDriver(tv = {}, bridge = new FakeBridge()) {
  const saved = [];
  const info = [];
  const t = { id: 'appletv-media', brand: 'appletv', name: 'Media Room', ip: '127.0.0.1', macs: [], ...tv };
  const driver = new AppleTvDriver(t, {
    bridge,
    onCredentials: (c) => {
      t.credentials = { ...t.credentials, ...c };
      saved.push(c);
    },
    onInfo: (i) => {
      Object.assign(t, i);
      info.push(i);
    },
  });
  return { driver, bridge, tv: t, saved, info };
}

test('pairing: Companion code, then AirPlay code, each step labelled', async () => {
  const { driver, bridge, tv, saved, info } = makeDriver();
  const first = await driver.pair({ mode: 'pin' });
  assert.deepEqual(first, { needsPin: true, step: 1, steps: 2, label: 'remote control', protocol: 'companion' });
  assert.deepEqual(info[0], { atvId: 'E2:AC:BD:99:96:BD' });

  const second = await driver.pair({ pin: '1234' });
  assert.equal(second.needsPin, true);
  assert.equal(second.step, 2);
  assert.equal(second.protocol, 'airplay');
  assert.deepEqual(saved[0], { companion: 'companion-secret' });
  // The remote already works while the second code is on screen.
  await tick();
  assert.deepEqual(bridge.connected.get(tv.id), { companion: 'companion-secret' });

  const done = await driver.pair({ pin: ' 12-34 ' });
  assert.deepEqual(done, {});
  assert.deepEqual(tv.credentials, { companion: 'companion-secret', airplay: 'airplay-secret' });
  await tick();
  assert.deepEqual(bridge.connected.get(tv.id), tv.credentials, 'reconnects with both keys');
  await driver.stop();
});

test('pairing: a wrong code says how to get a new one; no code pending is a 409', async () => {
  const { driver } = makeDriver();
  await driver.pair({ mode: 'pin' });
  await assert.rejects(driver.pair({ pin: '9999' }), (e) => e.status === 401 && /Show the number again/.test(e.message));
  await assert.rejects(driver.pair({ pin: '1234' }), (e) => e.status === 409);
  // Asking again shows a fresh code, which then works.
  assert.equal((await driver.pair({ mode: 'pin' })).step, 1);
  assert.equal((await driver.pair({ pin: '1234' })).step, 2);
  await driver.stop();
});

test('pairing: only the protocols the Apple TV asks for; already-paired skips ahead', async () => {
  const bridge = new FakeBridge();
  bridge.services = { companion: { port: 49153, pairing: 'Mandatory' }, airplay: { port: 7000, pairing: 'NotNeeded' } };
  const { driver, tv } = makeDriver({}, bridge);
  assert.deepEqual(await driver.pair(), { needsPin: true, step: 1, steps: 1, label: 'remote control', protocol: 'companion' });
  assert.deepEqual(await driver.pair({ pin: '1234' }), {});
  assert.deepEqual(tv.credentials, { companion: 'companion-secret' });
  await driver.stop();

  const again = makeDriver({ credentials: { companion: 'c' } });
  const res = await again.driver.pair({ mode: 'pin' });
  assert.equal(res.protocol, 'airplay', 'Companion is done, so only AirPlay asks for a code');
  await again.driver.stop();
});

test('pairing: an Apple TV without Companion (3rd gen and older) is turned away', async () => {
  const bridge = new FakeBridge();
  bridge.services = { airplay: { port: 7000, pairing: 'Mandatory' } };
  const { driver } = makeDriver({}, bridge);
  await assert.rejects(driver.pair({ mode: 'pin' }), (e) => e.status === 501 && /tvOS 15/.test(e.message));
});

test('state: pushed power, app and now-playing; closed connections go offline', async () => {
  const { driver, bridge, tv } = makeDriver({ credentials: { companion: 'c', airplay: 'a' } });
  const states = [];
  driver.on('state', (s) => states.push(s));
  driver.start();
  await tick();
  assert.equal(driver.state.online, true);
  assert.equal(driver.state.power, 'on');

  bridge.push(tv.id, { app: 'com.netflix.Netflix', appTitle: 'Netflix', title: 'Stranger Things: Chapter One', playing: 'playing' });
  assert.equal(driver.state.app, 'com.netflix.Netflix');
  assert.equal(driver.state.appTitle, 'Netflix');
  assert.equal(driver.state.nowPlaying, 'Stranger Things: Chapter One');
  assert.equal(driver.state.playing, 'playing');

  bridge.push('appletv-other', { power: 'off' });
  assert.equal(driver.state.power, 'on', 'other Apple TVs’ pushes are ignored');

  bridge.push(tv.id, { power: 'off', app: 'com.netflix.Netflix' });
  assert.equal(driver.state.power, 'off');
  assert.equal(driver.state.app, null, 'asleep means no app');

  bridge.emit('closed', { event: 'closed', key: tv.id, reason: 'lost' });
  assert.equal(driver.state.online, false);
  await driver.stop();
  bridge.push(tv.id, { power: 'on' });
  assert.equal(driver.state.online, false, 'no updates after stop');
});

test('state: volume level is a capability only when the Apple TV reports one', async () => {
  const { driver, bridge, tv } = makeDriver({ credentials: { companion: 'c' } });
  driver.start();
  await tick();
  assert.equal(driver.capabilities.volumeLevel, false);
  await assert.rejects(driver.setVolume(20), (e) => e.status === 501);
  bridge.push(tv.id, { volume: 35, volumeLevel: true });
  assert.equal(driver.capabilities.volumeLevel, true);
  assert.equal(driver.state.volume, 35);
  await driver.setVolume(40);
  assert.deepEqual(bridge.sent('set_volume').at(-1), { key: tv.id, level: 40 });
  await driver.stop();
});

test('keys map to pyatv buttons; holds become long presses', async () => {
  const { driver, bridge, tv } = makeDriver({ credentials: { companion: 'c' } });
  driver.start();
  await tick();
  await driver.key('up');
  await driver.key('ok', { hold: 900 });
  await driver.key('back');
  await driver.key('home', { hold: 1200 }); // Control Center on tvOS
  await driver.key('volup');
  await driver.key('voldown', { hold: 500 }); // volume can't be held: a click
  await driver.key('forward');
  assert.deepEqual(bridge.sent('remote').map((a) => [a.method, a.hold]), [
    ['up', false], ['select', true], ['menu', false], ['home', true], ['volume_up', false], ['volume_down', false], ['skip_forward', false],
  ]);
  await assert.rejects(driver.key('mute'), (e) => e.status === 501 && /volume to the TV/.test(e.message));
  await assert.rejects(driver.key('source'), (e) => e.status === 501);
  await assert.rejects(driver.key('nonsense'), (e) => e.status === 501);

  // Play/pause follows what's actually playing, like the remote's button.
  bridge.push(tv.id, { playing: 'playing' });
  const before = bridge.sent('remote').length;
  await driver.key('play');
  assert.equal(bridge.sent('remote').length, before, 'already playing: nothing to do');
  await driver.key('pause');
  assert.equal(bridge.sent('remote').at(-1).method, 'play_pause');
  await driver.stop();
});

test('power, apps and launch go through the bridge; launch shows the app at once', async () => {
  const { driver, bridge, tv } = makeDriver({ credentials: { companion: 'c' } });
  driver.start();
  await tick();
  await driver.powerOff();
  await driver.powerOn();
  assert.deepEqual(bridge.sent('power').map((a) => a.on), [false, true]);
  assert.deepEqual(await driver.apps(), [
    { id: 'com.netflix.Netflix', title: 'Netflix', icon: null },
    { id: 'com.google.ios.youtube', title: 'YouTube', icon: null },
  ]);
  await driver.launch('com.google.ios.youtube');
  assert.deepEqual(bridge.sent('launch').at(-1), { key: tv.id, app: 'com.google.ios.youtube' });
  assert.equal(driver.state.app, 'com.google.ios.youtube');
  assert.equal(driver.state.appTitle, 'YouTube');
  await assert.rejects(driver.launch(''), (e) => e.status === 400);
  await driver.stop();
});

test('typing goes to the focused field; Enter is a no-op (tvOS searches as you type)', async () => {
  const { driver, bridge, tv } = makeDriver({ credentials: { companion: 'c' } });
  driver.start();
  await tick();
  assert.equal(driver.capabilities.keyboard, true);
  assert.equal(driver.capabilities.pointer, false);
  await driver.text({ text: 'bluey' });
  await driver.text({ backspace: 2 });
  await driver.text({ enter: true });
  assert.deepEqual(bridge.sent('text'), [
    { key: tv.id, text: 'bluey', backspace: 0 },
    { key: tv.id, text: '', backspace: 2 },
  ]);
  await driver.stop();
});

test('an unpaired Apple TV refuses commands with a plain explanation', async () => {
  const { driver } = makeDriver();
  await assert.rejects(driver.key('up'), (e) => e.status === 409 && /code/.test(e.message));
});

test('the driver reconnects after the bridge restarts', async () => {
  const { driver, bridge, tv } = makeDriver({ credentials: { companion: 'c' } });
  driver.start();
  await tick();
  bridge.connected.clear();
  bridge.emit('restart');
  await tick();
  assert.ok(bridge.connected.has(tv.id));
  await driver.stop();
});

test('hub: add → two-step pair → keys stored server-side only', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-atv-'));
  const bridge = new FakeBridge();
  setBridge(bridge);
  // The fake Apple TV lives on 127.0.0.1, which real TVs never do.
  const hub = await new Hub({ store: new Store(dir), forbiddenIp: () => false }).init();
  hub.watchMs = 3_600_000;
  try {
    const added = await hub.add({ brand: 'appletv', name: 'Media Room', model: '4K (2nd gen)', ip: '127.0.0.1', atvId: 'E2:AC:BD:99:96:BD' });
    assert.equal(added.brand, 'appletv');
    assert.equal(hub.get(added.id).atvId, 'E2:AC:BD:99:96:BD');

    const step1 = await hub.pair(added.id, { mode: 'pin' });
    assert.equal(step1.needsPin, true);
    assert.equal(step1.step, 1);
    assert.equal(step1.steps, 2);
    const step2 = await hub.pair(added.id, { pin: '1234' });
    assert.equal(step2.needsPin, true);
    assert.equal(step2.step, 2);
    assert.equal(step2.paired, true, 'the remote works after step 1');
    const done = await hub.pair(added.id, { pin: '1234' });
    assert.equal(done.needsPin, undefined);

    const onDisk = JSON.parse(readFileSync(path.join(dir, 'tvs.json'), 'utf8'));
    assert.deepEqual(onDisk.tvs[0].credentials, { companion: 'companion-secret', airplay: 'airplay-secret' });
    const seen = JSON.stringify([hub.list(), step1, step2, done]);
    assert.ok(!seen.includes('secret'), 'pairing keys never reach clients');
  } finally {
    await hub.close();
    setBridge(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovery: only AppleTV* models are TVs (not Macs, iPads, HomePods or AirPlay TVs)', () => {
  const e = (service, name, ip, txt) => ({ service: `${service}._tcp.local`, name, ip, port: 1, txt });
  const tvs = appleTvsFrom([
    e('_companion-link', 'Media Room', '192.168.4.71', { rpmd: 'AppleTV11,1' }),
    e('_airplay', 'Media Room', '192.168.4.71', { model: 'AppleTV11,1', deviceid: 'e2:ac:bd:99:96:bd' }),
    e('_airplay', 'Apple TV', '192.168.4.23', { model: 'AppleTV5,3', deviceid: '7A:23:F5:E9:38:4F' }),
    e('_companion-link', 'Mutaaf’s MacBook Pro', '192.168.4.29', { rpfl: '0x20000' }),
    e('_airplay', 'YLQ51F65YV', '192.168.4.28', { model: 'MacBookPro18,2' }),
    e('_companion-link', 'Kitchen iPad', '192.168.4.30', { rpmd: 'iPad13,1' }),
    e('_airplay', 'Bedroom', '192.168.4.31', { model: 'AudioAccessory5,1' }),
    e('_airplay', 'Home Theater', '192.168.4.24', { model: 'Denon AVR-S960H' }),
    e('_airplay', 'Living Room TV', '192.168.4.45', { model: '55UP7000PUA' }),
  ]);
  assert.deepEqual(tvs, [
    { brand: 'appletv', name: 'Media Room', model: '4K (2nd gen)', ip: '192.168.4.71', macs: [], atvId: 'E2:AC:BD:99:96:BD', id: 'appletv-e2acbd9996bd' },
    { brand: 'appletv', name: 'Apple TV', model: 'HD', ip: '192.168.4.23', macs: [], atvId: '7A:23:F5:E9:38:4F', id: 'appletv-7a23f5e9384f' },
  ]);
});

test('probe: AirPlay /info names an Apple TV by its model string', () => {
  const bplist = Buffer.concat([Buffer.from('bplist00Ô\u0001'), Buffer.from('ZAppleTV6,2O\u0010nameYGame Room')]);
  assert.deepEqual(appleTvFromAirplayInfo(bplist), { model: 'AppleTV6,2', name: '' });
  assert.equal(appleTvFromAirplayInfo(Buffer.from('bplist00 model 65A300W')), null);
});

// The process manager, with a pretend Python child on PassThrough pipes.
function fakeSpawn(behaviour) {
  const children = [];
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => child.emit('exit', null);
    let buf = '';
    child.stdin.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        behaviour(req, (msg) => child.stdout.write(`${JSON.stringify(msg)}\n`), child);
      }
    });
    children.push(child);
    setImmediate(() => child.stdout.write('{"event":"ready","pyatv":"0.18.0"}\n'));
    return child;
  };
  return { spawnFn, children };
}

test('bridge: requests and replies over JSON lines; errors keep their status', async () => {
  const { spawnFn } = fakeSpawn((req, reply) => {
    if (req.op === 'ping') reply({ id: req.id, ok: true, result: { pyatv: '0.18.0' } });
    else reply({ id: req.id, ok: false, code: 'offline', error: 'The Apple TV didn’t answer' });
  });
  const bridge = new AtvBridge({ python: process.execPath, spawnFn });
  assert.deepEqual(await bridge.request('ping'), { pyatv: '0.18.0' });
  assert.equal(bridge.available, true);
  assert.equal(bridge.version, '0.18.0');
  await assert.rejects(bridge.request('connect', { key: 'x' }), (e) => e.status === 503 && e.code === 'offline');
  await bridge.close();
});

test('bridge: a crash fails in-flight requests, then it restarts and says so', async () => {
  const { spawnFn, children } = fakeSpawn((req, reply, child) => {
    if (req.op === 'crash') child.emit('exit', 1);
    else reply({ id: req.id, ok: true, result: 'pong' });
  });
  const bridge = new AtvBridge({ python: process.execPath, spawnFn });
  await bridge.request('ping');
  const restarted = new Promise((r) => bridge.once('restart', r));
  await assert.rejects(bridge.request('crash'), (e) => e.status === 503 && /restarted/.test(e.message));
  await restarted; // after a 1 s backoff
  assert.equal(children.length, 2);
  assert.equal(await bridge.request('ping'), 'pong');
  await bridge.close();
});

test('bridge: no Python means a clear 503, and it tries again later', async () => {
  const bridge = new AtvBridge({ python: path.join(os.tmpdir(), 'no-such-dir', 'python') });
  await assert.rejects(bridge.request('ping'), (e) => e.status === 503 && /npm run up/.test(e.message));
  assert.equal(bridge.available, false);
  assert.match(bridge.reason, /Python 3 and pyatv/);
  await assert.rejects(bridge.request('ping'), (e) => e.status === 503, 'not cached forever');

  // A driver on a missing bridge shows the reason in its state.
  const { driver } = makeDriver({ credentials: { companion: 'c' } }, bridge);
  driver.start();
  await tick();
  await tick();
  assert.equal(driver.state.online, false);
  assert.match(driver.state.unavailable, /npm run up/);
  await driver.stop();
});
