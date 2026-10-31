import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { bulk } from '../src/bulk.js';
import { Driver } from '../src/drivers/base.js';
import { Hub } from '../src/hub.js';
import { nextRun, SceneStore, Scenes, seedScenes } from '../src/scenes.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

// Fake TVs that record what they were told and come online when switched on.
const log = [];
class FakeTv extends Driver {
  capabilities = { volumeLevel: this.tv.brand === 'lg', inputs: false, toast: this.tv.brand === 'lg', appIcons: false };
  start() { this.setState({ online: true, power: 'on', volume: 10, muted: false }); }
  async pair() { this.onCredentials({ k: 1 }); this.start(); }
  async key(name) {
    log.push([this.tv.id, 'key', name]);
    if (name === 'mute') this.setState({ muted: !this.state.muted });
  }
  async powerOn() { log.push([this.tv.id, 'on']); setTimeout(() => this.setState({ online: true, power: 'on' }), 30); }
  async powerOff() { log.push([this.tv.id, 'off']); this.setState({ online: false, power: 'off' }); }
  async setVolume(level) { log.push([this.tv.id, 'volume', level]); this.setState({ volume: level }); }
  async apps() { return this.tv.brand === 'lg' ? [{ id: 'netflix', title: 'Netflix' }] : [{ id: '12', title: 'Netflix' }, { id: '837', title: 'YouTube' }]; }
  async launch(id) { log.push([this.tv.id, 'launch', id]); }
  async toast(message) { log.push([this.tv.id, 'toast', message]); }
}

let dir;
let hub;
let server;
let base;
before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-scenes-'));
  hub = await new Hub({ store: new Store(dir), drivers: { lg: FakeTv, roku: FakeTv }, probeFn: async () => null }).init();
  for (const [brand, ip, name] of [['lg', '10.0.0.5', 'Living Room'], ['roku', '10.0.0.6', 'Basement']]) {
    const tv = await hub.add({ ip, brand, name, macs: [] });
    await hub.pair(tv.id);
  }
  hub.scenes = await new Scenes({ hub, store: new SceneStore(dir), waitOnlineMs: 2000, pollMs: 20 }).init();
  server = createServer(hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const ids = () => hub.tvs.map((t) => t.id);
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};

test('bulk: same action on many TVs, a result per TV', async () => {
  log.length = 0;
  const { body } = await call('POST', '/api/bulk', { ids: ids(), action: 'power', args: { on: false } });
  assert.deepEqual(body.results.map((r) => [r.name, r.ok]), [['Living Room', true], ['Basement', true]]);
  assert.deepEqual(log.map((l) => l[1]), ['off', 'off']);
});

test('bulk: volume sets a level where it can and nudges where it can’t', async () => {
  for (const id of ids()) hub.driver(id).start();
  log.length = 0;
  const results = await bulk(hub, ids(), 'volume', { level: 13 });
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(log.filter((l) => l[0].startsWith('lg')), [[ids()[0], 'volume', 13]]);
  assert.equal(log.filter((l) => l[0].startsWith('roku') && l[2] === 'volup').length, 3, 'roku: 10 → 13 in three steps');
});

test('bulk: open the same app by title, using each TV’s own id', async () => {
  log.length = 0;
  await bulk(hub, ids(), 'launch', { title: 'netflix' });
  assert.deepEqual(log.map((l) => l.slice(1)), [['launch', 'netflix'], ['launch', '12']]);
  const miss = await bulk(hub, ids(), 'launch', { title: 'YouTube' });
  assert.deepEqual(miss.map((r) => r.ok), [false, true]);
  assert.match(miss[0].error, /isn’t installed/);
});

test('bulk: mute only toggles TVs that aren’t already muted; say fails politely on TVs without it', async () => {
  log.length = 0;
  await bulk(hub, ids(), 'mute', { on: true });
  await bulk(hub, ids(), 'mute', { on: true });
  assert.equal(log.filter((l) => l[2] === 'mute').length, 2, 'second mute is a no-op');
  const said = await bulk(hub, ids(), 'say', { message: 'Dinner!' });
  assert.deepEqual(said.map((r) => r.ok), [true, false]);
});

test('bulk: rejects junk', async () => {
  assert.equal((await call('POST', '/api/bulk', { ids: [], action: 'power' })).status, 400);
  assert.equal((await call('POST', '/api/bulk', { ids: ids(), action: 'explode' })).status, 400);
});

test('scenes: first run seeds 3 templates aimed at the TVs in the house; file is private', async () => {
  const list = (await call('GET', '/api/scenes')).body;
  assert.deepEqual(list.map((s) => s.name), ['Everything off', 'Movie night', 'School night']);
  assert.deepEqual(list[1].steps[0].target, [ids()[0]], 'movie night targets the LG');
  assert.equal(list[2].schedule.enabled, false);
  assert.equal(statSync(path.join(dir, 'scenes.json')).mode & 0o777, 0o600);
});

test('scenes: run waits for TVs to wake before the next step, with progress events', async () => {
  for (const id of ids()) await hub.driver(id).powerOff();
  log.length = 0;
  const progress = [];
  hub.scenes.on('progress', (p) => progress.push(p));
  const res = await hub.scenes.run('movie-night');
  assert.equal(res.ok, true);
  assert.deepEqual(log.map((l) => l[1]), ['on', 'volume', 'launch'], 'volume only after it woke');
  assert.deepEqual(progress.map((p) => p.step), [0, 1, 2, 3, 3]);
  assert.equal(progress.at(-1).done, true);
  assert.ok(hub.scenes.get('movie-night').lastRun);
});

test('scenes: create, edit, validate, delete over the API', async () => {
  const created = (await call('POST', '/api/scenes', { name: 'Kids bedtime', emoji: '🧸', steps: [{ target: [ids()[1]], action: 'power', args: { on: false } }] })).body;
  assert.match(created.id, /^kids-bedtime-/);
  const edited = (await call('PATCH', `/api/scenes/${created.id}`, { schedule: { days: [5, 6, 9], time: '20:30', enabled: true } })).body;
  assert.deepEqual(edited.schedule, { days: [5, 6], time: '20:30', enabled: true });
  assert.ok(edited.nextRun);
  assert.equal((await call('PATCH', `/api/scenes/${created.id}`, { steps: [{ action: 'selfdestruct' }] })).status, 400);
  assert.equal((await call('DELETE', `/api/scenes/${created.id}`)).status, 200);
  assert.equal((await call('POST', `/api/scenes/${created.id}/run`, {})).status, 404);
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'scenes.json'), 'utf8'));
  assert.ok(!onDisk.scenes.some((s) => s.id === created.id));
});

test('scheduler: fires once in its minute, never replays missed minutes', async () => {
  let now = new Date(2026, 9, 25, 20, 59, 50); // Sunday 20:59:50
  const scenes = await new Scenes({ hub, store: new SceneStore(path.join(dir, 'sched')), clock: () => now, waitOnlineMs: 50, pollMs: 10 }).init();
  await scenes.update('school-night', { schedule: { days: [0, 1, 2, 3, 4], time: '21:00', enabled: true } });
  assert.deepEqual(scenes.tick(), [], 'not yet');
  now = new Date(2026, 9, 25, 21, 0, 5);
  assert.deepEqual(scenes.tick(), ['school-night']);
  now = new Date(2026, 9, 25, 21, 0, 25);
  assert.deepEqual(scenes.tick(), [], 'same minute: no second run');
  now = new Date(2026, 9, 25, 21, 7, 0);
  assert.deepEqual(scenes.tick(), [], 'Hearth "was down" at 21:00 tomorrow-style gaps are not replayed');
  now = new Date(2026, 9, 31, 21, 0, 0); // Saturday: not a school night
  assert.deepEqual(scenes.tick(), []);
  assert.equal(nextRun(scenes.get('school-night'), new Date(2026, 9, 31, 12, 0)).getDay(), 0, 'next is Sunday');
  await new Promise((r) => setTimeout(r, 100));
});

test('seedScenes with no TVs still makes sense', () => {
  assert.equal(seedScenes([])[1].steps[0].target, 'all');
});

test('just say it: the AI sees TV1/TV2, never names; the draft comes back with ids and names', async () => {
  let seen;
  const before = hub.insights;
  hub.insights = {
    scene: async (request) => {
      seen = request;
      return {
        model: 'fake',
        draft: {
          name: 'Bedtime', emoji: '🌙', summary: 'Quiets TV2, says goodnight on TV2, then turns TV2 off.',
          steps: [
            { action: 'volume', target: ['TV2'], args: { level: 10 } },
            { action: 'say', target: ['TV2'], args: { message: 'Goodnight from TV2' } },
            { action: 'power', target: ['TV2'], args: { on: false } },
          ],
          schedule: { days: [0, 1, 2, 3, 4], time: '20:30' },
        },
      };
    },
  };
  try {
    const r = await call('POST', '/api/scenes/draft', { text: 'Bedtime on school nights at 8:30 in the basement: quiet, goodnight, off' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!/basement|living room/i.test(JSON.stringify(seen)), JSON.stringify(seen));
    assert.match(seen.text, /in the TV2:/);
    const basement = hub.tvs.find((t) => t.name === 'Basement').id;
    assert.deepEqual(r.body.draft.steps.map((s) => s.target), [[basement], [basement], [basement]]);
    assert.match(r.body.draft.summary, /Quiets Basement/);
    assert.equal(r.body.draft.steps[1].args.message, 'Goodnight from Basement');
    assert.deepEqual(r.body.draft.schedule, { days: [0, 1, 2, 3, 4], time: '20:30', enabled: true });
    assert.equal(hub.scenes.list().some((s) => s.name === 'Bedtime'), false, 'a draft is never saved');
  } finally {
    hub.insights = before;
  }
});

test('try it: a draft runs for real under the id "draft" and isn’t saved', async () => {
  const count = hub.scenes.list().length;
  const events = [];
  const on = (e) => events.push(e);
  hub.scenes.on('progress', on);
  log.length = 0;
  try {
    const r = await hub.scenes.tryDraft({ name: 'Try', steps: [{ target: 'all', action: 'volume', args: { level: 7 } }] });
    assert.equal(r.ok, true);
  } finally {
    hub.scenes.off('progress', on);
  }
  assert.ok(events.every((e) => e.id === 'draft' && e.trigger === 'try'));
  assert.ok(events.at(-1).done);
  assert.ok(log.some(([, what, level]) => what === 'volume' && level === 7));
  assert.equal(hub.scenes.list().length, count);
  await assert.rejects(hub.scenes.tryDraft({ steps: [] }), /Add a step first/);
});
