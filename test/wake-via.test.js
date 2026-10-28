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
