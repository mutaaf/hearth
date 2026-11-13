import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Driver } from '../src/drivers/base.js';
import { Hub } from '../src/hub.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { announce, announcePlan, canPause, NO_MESSAGES, sayWhy } from '../src/announce.js';

// One fake per brand. What each TV is doing comes from its name.
const log = [];
const START = {
  'Living Room': { online: true, power: 'on' }, // LG, on: shows it
  Den: { online: false, power: 'off' }, // LG, off
  Basement: { online: true, power: 'on', app: '12', media: { state: 'playing' } }, // Roku playing
  Kids: { online: true, power: 'on', app: '837', media: { state: 'paused' } }, // Roku paused: never toggle
  Office: { online: true, power: 'on', playing: 'playing' }, // Apple TV playing
  Bedroom: { online: true, power: 'on', app: 'netflix' }, // Samsung in an app
  Garage: { online: true, power: 'on' }, // Google TV
};
class FakeTv extends Driver {
  capabilities = { volumeLevel: false, inputs: false, toast: this.tv.brand === 'lg', appIcons: false };
  start() { this.setState(START[this.tv.name]); }
  async pair() { this.onCredentials({ k: 1 }); this.start(); }
  async key(name) { log.push([this.tv.name, 'key', name]); }
  async toast(message) {
    if (this.tv.name === 'Den') throw new Error('should not be asked');
    log.push([this.tv.name, 'toast', message]);
  }
}

let dir;
let hub;
let server;
let base;
before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-announce-'));
  const drivers = { lg: FakeTv, roku: FakeTv, appletv: FakeTv, samsung: FakeTv, androidtv: FakeTv };
  hub = await new Hub({ store: new Store(dir), drivers, probeFn: async () => null }).init();
  hub.burstMs = 0;
  hub.settleDelays = [];
  const tvs = [['lg', 'Living Room'], ['lg', 'Den'], ['roku', 'Basement'], ['roku', 'Kids'], ['appletv', 'Office'], ['samsung', 'Bedroom'], ['androidtv', 'Garage']];
  for (const [i, [brand, name]] of tvs.entries()) {
    const tv = await hub.add({ ip: `10.0.0.${10 + i}`, brand, name, macs: [] });
    await hub.pair(tv.id);
  }
  // Paired drivers start on their own tick; under load that's later than this line.
  for (let i = 0; i < 100 && !hub.list().every((v) => v.state?.power === START[v.name].power); i++) await new Promise((r) => setTimeout(r, 30));
  server = createServer(hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const byName = (list) => Object.fromEntries(list.map((x) => [x.name, x]));

test('the plan: which TVs will show it, and a plain reason for each one that won’t', () => {
  const plan = byName(announcePlan(hub).tvs);
  assert.equal(plan['Living Room'].can, true);
  assert.equal(plan['Living Room'].why, undefined);
  assert.match(plan.Den.why, /off/);
  assert.equal(plan.Basement.why, NO_MESSAGES.roku);
  assert.equal(plan.Office.why, NO_MESSAGES.appletv);
  assert.equal(plan.Bedroom.why, NO_MESSAGES.samsung);
  assert.equal(plan.Garage.why, NO_MESSAGES.androidtv);
  // Pause only where it can't backfire.
  assert.equal(plan.Basement.pause, true);
  assert.equal(plan.Kids.pause, false, 'a paused Roku would start playing');
  assert.equal(plan.Office.pause, true);
  assert.equal(plan.Bedroom.pause, true);
  assert.equal(plan.Garage.pause, false);
  assert.equal(plan.Den.pause, false);
});

test('send: shows it where it can, says why everywhere else, pauses nothing unasked', async () => {
  log.length = 0;
  const { message, results } = await announce(hub, { message: "  Dinner's   ready! " });
  assert.equal(message, "Dinner's ready!");
  const r = byName(results);
  assert.deepEqual(r['Living Room'], { id: r['Living Room'].id, name: 'Living Room', ok: true, how: 'shown' });
  assert.equal(r.Den.ok, false);
  assert.equal(r.Basement.ok, false);
  assert.equal(r.Basement.why, NO_MESSAGES.roku);
  assert.deepEqual(log, [['Living Room', 'toast', "Dinner's ready!"]]);
});

test('send with pause: the TVs that can’t show it pause, the paused Roku is left alone', async () => {
  log.length = 0;
  const res = await fetch(`${base}/api/announce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Dinner is ready', pause: true }) });
  assert.equal(res.status, 200);
  const r = byName((await res.json()).results);
  assert.equal(r.Basement.how, 'paused');
  assert.equal(r.Office.how, 'paused');
  assert.equal(r.Bedroom.how, 'paused');
  assert.equal(r.Kids.ok, false);
  assert.equal(r.Garage.ok, false);
  assert.deepEqual(log.filter((x) => x[1] === 'key').map((x) => x[0]).sort(), ['Basement', 'Bedroom', 'Office']);
});

test('an empty message is a friendly 400; the GET plan is served', async () => {
  const bad = await fetch(`${base}/api/announce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '   ' }) });
  assert.equal(bad.status, 400);
  const plan = await (await fetch(`${base}/api/announce`)).json();
  assert.equal(plan.tvs.length, 7);
});

test('sayWhy/canPause on an unpaired TV', () => {
  const v = { paired: false, brand: 'lg', capabilities: { toast: true }, state: { online: true, power: 'on' } };
  assert.match(sayWhy(v), /Not connected/);
  assert.equal(canPause(v), false);
});
