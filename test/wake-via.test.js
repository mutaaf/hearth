import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/hub-core.js';
import { Store } from '../src/store.js';

// Waking a TV through the Roku or Apple TV on its HDMI (CEC).
const log = [];
class Fake extends EventEmitter {
  constructor(tv, { onCredentials }) {
    super();
    this.tv = tv;
    this.state = { online: false, power: 'off' };
    this.onCredentials = onCredentials;
  }
  setState(p) {
    this.state = { ...this.state, ...p };
    this.emit('state', this.state);
  }
  start() {}
  async stop() {}
  async pair() { this.onCredentials({ k: 1 }); }
  async powerOn() {
    log.push([this.tv.name, 'on']);
    if (this.tv.brand === 'samsung') throw new Error('gone');
  }
  async powerOff() {}
  async key(k) { log.push([this.tv.name, 'key', k]); }
  async reconnect() {}
}

async function house() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-via-'));
  const hub = await new Hub({ store: new Store(dir), drivers: { samsung: Fake, roku: Fake, appletv: Fake, lg: Fake }, probeFn: async () => null }).init();
  const add = async (brand, ip, name, macs = []) => {
    const t = await hub.add({ ip, brand, name, macs });
    await hub.pair(t.id);
    return t.id;
  };
  const ids = { tv: await add('samsung', '10.0.0.6', 'Den', ['aa:bb:cc:dd:ee:06']), roku: await add('roku', '10.0.0.7', 'Roku'), atv: await add('appletv', '10.0.0.8', 'ATV'), lg: await add('lg', '10.0.0.9', 'Bed', ['aa:bb:cc:dd:ee:09']) };
  return { hub, ids, done: async () => (await hub.close(), rmSync(dir, { recursive: true, force: true })) };
}

test('wakeVia: only a Roku or Apple TV, never itself; shown in the view', async () => {
  const { hub, ids, done } = await house();
  try {
    await assert.rejects(hub.update(ids.tv, { wakeVia: ids.lg }), /Roku or Apple TV/);
    await assert.rejects(hub.update(ids.roku, { wakeVia: ids.roku }), /Roku or Apple TV/);
    await assert.rejects(hub.update(ids.tv, { wakeVia: 'nope' }), /Roku or Apple TV/);
    assert.equal((await hub.update(ids.tv, { wakeVia: ids.atv })).wakeVia, ids.atv);
    assert.equal((await hub.update(ids.tv, { wakeVia: null })).wakeVia, null);
  } finally {
    await done();
  }
});

test('power on through the box: the TV’s own wake and the box’s, a Roku also gets Home; one failing is fine', async () => {
  const { hub, ids, done } = await house();
  try {
    await hub.update(ids.tv, { wakeVia: ids.roku });
    log.length = 0;
    assert.deepEqual(await hub.power(ids.tv, true), { ok: true }, 'the Samsung’s own wake failed, the Roku’s worked');
    assert.deepEqual(log.sort(), [['Den', 'on'], ['Roku', 'key', 'home'], ['Roku', 'on']].sort());
    await hub.update(ids.tv, { wakeVia: ids.atv });
    log.length = 0;
    await hub.power(ids.tv, true);
    assert.ok(log.some((l) => l[0] === 'ATV' && l[1] === 'on') && !log.some((l) => l[1] === 'key'));
    log.length = 0;
    await hub.power(ids.tv, false);
    assert.ok(!log.some((l) => l[0] === 'ATV'), 'switching off leaves the box alone');
  } finally {
    await done();
  }
});

test('a box that goes away: the TV wakes on its own again', async () => {
  const { hub, ids, done } = await house();
  try {
    await hub.update(ids.lg, { wakeVia: ids.roku });
    await hub.remove(ids.roku);
    assert.equal(hub.view(hub.get(ids.lg)).wakeVia, null);
    log.length = 0;
    await hub.power(ids.lg, true);
    assert.deepEqual(log, [['Bed', 'on']]);
  } finally {
    await done();
  }
});

test('a quiet TV that comes on right after a press on a box → one offer to link them', async () => {
  const { hub, ids, done } = await house();
  const offers = [];
  hub.on('wake-via', (o) => offers.push(o));
  try {
    const den = hub.driver(ids.tv);
    den.setState({ online: false });
    await hub.wakeFor(ids.roku); // a press on the Roku
    den.setState({ online: true, power: 'on' });
    assert.deepEqual(offers, [{ id: ids.tv, via: ids.roku }]);
    den.setState({ online: false });
    await hub.wakeFor(ids.roku);
    den.setState({ online: true, power: 'on' });
    assert.equal(offers.length, 1, 'asked once');
    // Long after any press: no offer.
    const bed = hub.driver(ids.lg);
    bed.setState({ online: false });
    hub.cameWithMs = 0;
    await new Promise((r) => setTimeout(r, 5));
    bed.setState({ online: true, power: 'on' });
    assert.equal(offers.length, 1);
  } finally {
    await done();
  }
});

// ── the wake coach ──
import { wakePlan } from '../src/wake-plan.js';

const view = (o) => ({ id: 't', name: 'Den', brand: 'samsung', model: '', paired: true, canWake: true, wakeVia: null, state: { online: false }, ...o });
const roku = { id: 'r', name: 'Basement Roku', brand: 'roku', paired: true };

test('wake plan: a 2016 Samsung can’t wake over Wi-Fi → through the box, with Anynet+ and 1-touch play', () => {
  const p = wakePlan(view({ model: 'UN55KU6290' }), [roku]);
  assert.equal(p.way, 'box');
  assert.equal(p.network.possible, false);
  assert.match(p.why, /leave the Wi-Fi/);
  assert.deepEqual(p.box.boxes.map((b) => b.id), ['r']);
  assert.match(p.box.tvStep.path, /Settings → General → External Device Manager → Anynet\+/);
  assert.match(p.box.boxSteps.roku[0].path, /1-touch play/);
  assert.equal(p.summary, 'Needs a box: tap to set up');
});

test('wake plan: no box in the house → its own remote, and says how a box would help', () => {
  const p = wakePlan(view({ model: 'UN55KU6290' }), []);
  assert.equal(p.way, 'remote');
  assert.match(p.why, /Plug a Roku or Apple TV/);
});

test('wake plan: a 2020 Samsung wakes itself after Power On with Mobile; an LG Hearth set up is ready', () => {
  const s = wakePlan(view({ model: 'UN43TU7000' }), [roku]);
  assert.equal(s.way, 'network');
  assert.ok(s.network.steps.some((x) => /Power On with Mobile/.test(x.title)));
  assert.equal(s.box.possible, true, 'the box stays on offer');
  const lg = wakePlan(view({ brand: 'lg', model: '55UP7000PUA', state: { online: true, wakeOnLan: true } }), []);
  assert.equal(lg.way, 'network');
  assert.equal(lg.network.auto, true);
  assert.match(lg.headline, /ready/);
  assert.equal(lg.summary, 'From your phone');
});

test('wake plan: linked to a box → says so; a box itself has no box option', () => {
  const p = wakePlan(view({ model: 'UN55KU6290', wakeVia: 'r' }), [roku]);
  assert.equal(p.way, 'box');
  assert.equal(p.summary, 'Through Basement Roku');
  assert.equal(wakePlan(view({ id: 'r', brand: 'roku', name: 'Roku' }), [roku]).box.possible, false);
  assert.equal(wakePlan(view({ brand: 'androidtv' }), []).way, 'remote');
});

test('wake test: through a box without saving it; reports how long it took, or that nothing answered', async () => {
  const { hub, ids, done } = await house();
  try {
    Object.assign(hub, { pollMs: 5, wakeTestMs: 300, reseekMs: [], kickEveryMs: 1e9 });
    const den = hub.driver(ids.tv);
    log.length = 0;
    setTimeout(() => den.setState({ online: true, power: 'on' }), 30);
    const ok = await hub.wakeTest(ids.tv, { via: ids.roku });
    assert.equal(ok.ok, true);
    assert.ok(log.some((l) => l[0] === 'Roku' && l[1] === 'on'));
    assert.equal(hub.view(hub.get(ids.tv)).wakeVia, null, 'a test never saves the link');
    assert.deepEqual(await hub.wakeTest(ids.tv), { ok: false, reason: 'already-on' });
    den.setState({ online: false, power: 'off' });
    assert.deepEqual(await hub.wakeTest(ids.tv, { via: ids.roku }), { ok: false, reason: 'no-answer' });
    await assert.rejects(hub.wakeTest(ids.tv, { via: ids.lg }), /Roku or Apple TV/);
  } finally {
    await done();
  }
});
