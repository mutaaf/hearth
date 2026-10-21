import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runDoctor, runDoctorAll } from '../src/doctor.js';
import { Driver } from '../src/drivers/base.js';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';

// Fake brand: verify() answers whatever the test sets on `trust`.
let trust = { ok: true, auth: 'ok', detail: 'fine' };
const made = [];
class Fake extends Driver {
  static brand = 'lg';
  constructor(tv, opts) {
    super(tv, opts);
    made.push(this);
    this.starts = 0;
    this.stops = 0;
  }
  start() {
    this.starts++;
  }
  async stop() {
    this.stops++;
  }
  async pair() {
    this.onCredentials({ ok: true });
  }
  async verify() {
    return trust;
  }
}

async function makeHub({ tvs, discover = async () => [], macFor = async () => null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-doctor-'));
  const store = new Store(dir);
  await store.save(tvs);
  const hub = await new Hub({
    store,
    drivers: { lg: Fake, samsung: Fake, roku: Fake, androidtv: Fake },
    discoverFn: discover,
    probeFn: async () => null,
    macForFn: macFor,
  }).init();
  hub.watchMs = 1e9;
  return { hub, dir, store };
}

const living = () => ({ id: 'lg-aabbcc000001', brand: 'lg', name: 'Living Room', ip: '10.0.0.5', macs: ['aa:bb:cc:00:00:01'], credentials: { clientKey: 'k' } });

test('a known TV seen at a new address is followed (by id or shared MAC)', async () => {
  const { hub, dir, store } = await makeHub({
    tvs: [living()],
    discover: async () => [{ id: 'lg-aabbcc000001', brand: 'lg', name: 'Living Room', ip: '10.0.0.61', macs: ['aa:bb:cc:00:00:01'] }],
  });
  const healed = [];
  hub.on('healed', (h) => healed.push(h));
  const before = made.length;
  const found = await hub.scan();
  assert.equal(hub.get('lg-aabbcc000001').ip, '10.0.0.61');
  assert.equal(found[0].added, true, 'not offered as a new TV');
  assert.deepEqual(healed, [{ id: 'lg-aabbcc000001', name: 'Living Room', from: '10.0.0.5', to: '10.0.0.61', message: 'Living Room moved to 10.0.0.61 — reconnected' }]);
  assert.equal(made.length, before + 1, 'driver rebuilt for the new address');
  assert.equal((await store.load())[0].ip, '10.0.0.61', 'persisted');
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a TV discovered without a MAC is matched through the OS neighbour table', async () => {
  const gtv = { id: 'androidtv-9', brand: 'androidtv', name: 'Upstairs', ip: '10.0.0.48', macs: ['94:b3:f7:a1:aa:63'], credentials: { cast: true } };
  const { hub, dir } = await makeHub({
    tvs: [gtv],
    discover: async () => [{ id: 'androidtv-100070', brand: 'androidtv', name: 'Upstairs', ip: '10.0.0.70', macs: [] }],
    macFor: async (ip) => (ip === '10.0.0.70' ? '94:b3:f7:a1:aa:63' : null),
  });
  await hub.scan();
  assert.equal(hub.get('androidtv-9').ip, '10.0.0.70');
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

test('never steals an address another known TV is using', async () => {
  const other = { id: 'samsung-1', brand: 'lg', name: 'Den', ip: '10.0.0.61', macs: [], credentials: { x: 1 } };
  const { hub, dir } = await makeHub({
    tvs: [living(), other],
    discover: async () => [{ id: 'lg-aabbcc000001', brand: 'lg', ip: '10.0.0.61', macs: ['aa:bb:cc:00:00:01'] }],
  });
  await hub.scan();
  assert.equal(hub.get('lg-aabbcc000001').ip, '10.0.0.5');
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

// A fake world for the doctor: probe results scripted per call.
function deps({ upAfter = 0, wakeable = true } = {}) {
  let t = 0;
  let calls = 0;
  const log = [];
  return {
    log,
    probe: async (ip) => {
      calls++;
      log.push(['probe', ip]);
      return { up: calls > upAfter, results: [{ port: 3001, ok: calls > upAfter, ms: 4 }] };
    },
    macFor: async () => 'aa:bb:cc:00:00:01',
    wake: async (macs) => {
      log.push(['wake', macs.length]);
      if (!wakeable) upAfter = 1e9;
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
}

test('doctor, healthy TV: every step ✓, reconnects, still trusted', async () => {
  trust = { ok: true, auth: 'ok', detail: 'LG answered in 12 ms' };
  const { hub, dir } = await makeHub({ tvs: [living()] });
  const events = [];
  hub.on('doctor', (e) => events.push(e));
  const d = deps();
  const r = await runDoctor(hub, 'lg-aabbcc000001', d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => [s.step, s.status]), [['network', 'ok'], ['wake', 'ok'], ['find', 'ok'], ['reconnect', 'ok'], ['verify', 'ok'], ['pair', 'ok']]);
  assert.ok(events.some((e) => e.status === 'running'), 'progress streams as it goes');
  const drv = hub.driver('lg-aabbcc000001');
  assert.ok(drv.stops >= 1 && drv.starts >= 2, 'stopped and started again');
  assert.equal(r.summary, 'All good: connected and answering.');
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

test('doctor, TV asleep: wakes it, waits, then carries on', async () => {
  trust = { ok: true, auth: 'ok', detail: 'ok' };
  const { hub, dir } = await makeHub({ tvs: [living()] });
  const d = deps({ upAfter: 3 });
  const r = await runDoctor(hub, 'lg-aabbcc000001', d);
  assert.equal(r.steps.find((s) => s.step === 'wake').status, 'ok');
  assert.match(r.steps.find((s) => s.step === 'wake').detail, /Woke up in \d+ s/);
  assert.ok(d.log.some(([k]) => k === 'wake'));
  assert.equal(r.ok, true);
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

test('doctor, TV moved: the rescan finds it at a new address', async () => {
  trust = { ok: true, auth: 'ok', detail: 'ok' };
  const { hub, dir } = await makeHub({
    tvs: [living()],
    discover: async () => [{ id: 'lg-aabbcc000001', brand: 'lg', ip: '10.0.0.77', macs: ['aa:bb:cc:00:00:01'] }],
  });
  const d = deps({ wakeable: false });
  // Unreachable at the old address only.
  d.probe = async (ip) => ({ up: ip === '10.0.0.77', results: [{ port: 3001, ok: ip === '10.0.0.77' }] });
  const r = await runDoctor(hub, 'lg-aabbcc000001', d);
  assert.deepEqual(r.healed, { from: '10.0.0.5', to: '10.0.0.77' });
  assert.equal(r.ok, true);
  assert.match(r.summary, /moved to 10\.0\.0\.77/);
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

test('doctor, gone for good: plain words, no crash', async () => {
  const { hub, dir } = await makeHub({ tvs: [living()] });
  const d = deps({ upAfter: 1e9 });
  const r = await runDoctor(hub, 'lg-aabbcc000001', d);
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.step === 'find').status, 'fail');
  assert.match(r.summary, /plugged in/);
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

test('doctor, key no longer trusted: says exactly how to pair again', async () => {
  trust = { ok: true, auth: 'prompt', how: 'lg-pin', detail: 'asking again' };
  const { hub, dir } = await makeHub({ tvs: [living()] });
  const r = await runDoctor(hub, 'lg-aabbcc000001', deps());
  assert.equal(r.needsPairing, true);
  assert.equal(r.how, 'lg-pin');
  assert.equal(r.ok, false);
  assert.match(r.summary, /number/);
  const all = await runDoctorAll(hub, deps());
  assert.equal(all.length, 1);
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

test('unpair forgets the key but keeps the TV', async () => {
  const { hub, dir, store } = await makeHub({ tvs: [living()] });
  const view = await hub.unpair('lg-aabbcc000001');
  assert.equal(view.paired, false);
  assert.equal(hub.tvs.length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'tvs.json'), 'utf8')).tvs[0].credentials, undefined);
  void store;
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});
