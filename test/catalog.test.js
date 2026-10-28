import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { bulk } from '../src/bulk.js';
import { CATALOG, catalogApp, matchTitle, normTitle, ownerOf, resolveApp } from '../src/catalog.js';
import { Driver } from '../src/drivers/base.js';
import { Hub } from '../src/hub.js';
import { Scenes, SceneStore } from '../src/scenes.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

const entry = (key) => CATALOG.find((e) => e.key === key);

// ── The catalog itself ──
test('catalog: the popular apps, a unique key each, ids per brand as arrays', () => {
  const keys = CATALOG.map((e) => e.key);
  for (const k of ['youtube', 'youtubetv', 'netflix', 'primevideo', 'disneyplus', 'max', 'hulu', 'appletv', 'peacock', 'paramountplus', 'espn', 'spotify', 'plex', 'tubi', 'plutotv', 'sling', 'fubo', 'twitch', 'crunchyroll', 'youtubekids']) {
    assert.ok(keys.includes(k), `${k} is in the catalog`);
  }
  assert.equal(new Set(keys).size, keys.length);
  for (const e of CATALOG) {
    for (const brand of ['samsung', 'lg', 'roku', 'androidtv', 'appletv']) assert.ok(Array.isArray(e.ids[brand]), `${e.key}.${brand}`);
    assert.ok(e.ids.appletv.length, `${e.key} has an Apple TV bundle id`);
    if (!e.ids.androidtv.length) assert.match(e.note ?? '', /Cast/, `${e.key} says why it can't open on Google TV`);
  }
  assert.deepEqual(entry('youtube').ids.appletv, ['com.google.ios.youtube']);
  assert.deepEqual(entry('youtubetv').ids.appletv, ['com.google.ios.youtubeunplugged']);
  assert.deepEqual(entry('youtube').ids.androidtv, ['233637DE']);
});

test('catalog: names normalize (Disney+ = Disney Plus) and find entries by key or name', () => {
  assert.equal(normTitle('Disney+'), 'disney plus');
  assert.equal(normTitle('Google Play Movies ＆ TV'), 'google play movies and tv');
  assert.equal(catalogApp('youtubetv').title, 'YouTube TV');
  assert.equal(catalogApp('YouTube TV').key, 'youtubetv');
  assert.equal(catalogApp('youtube').key, 'youtube');
  assert.equal(catalogApp('HBO Max').key, 'max');
  assert.equal(catalogApp('Disney Plus').key, 'disneyplus');
  assert.equal(catalogApp('Pandora'), null);
});

// ── Resolution: never YouTube for YouTube TV, or the other way round ──
test('resolve: the first catalog id installed wins (Samsung YouTube TV by its store id)', () => {
  const apps = [{ id: '111299001912', title: 'YouTube' }, { id: '3201707014489', title: 'YouTube TV' }];
  assert.deepEqual(resolveApp(entry('youtubetv'), 'samsung', apps), { id: '3201707014489', title: 'YouTube TV', via: 'id' });
  assert.deepEqual(resolveApp(entry('youtube'), 'samsung', apps), { id: '111299001912', title: 'YouTube', via: 'id' });
});

test('resolve: YouTube never matches YouTube TV (or YouTube Kids), and vice versa, by title alone', () => {
  // Unknown ids, so only titles can decide.
  const onlyTv = [{ id: 'a1', title: 'YouTube TV' }, { id: 'a2', title: 'YouTube Kids' }];
  assert.equal(resolveApp(entry('youtube'), 'lg', onlyTv), null);
  assert.equal(resolveApp(entry('youtubetv'), 'lg', onlyTv).id, 'a1');
  const onlyYt = [{ id: 'b1', title: 'YouTube' }];
  assert.equal(resolveApp(entry('youtubetv'), 'lg', onlyYt), null);
  assert.equal(resolveApp(entry('youtubekids'), 'lg', onlyYt), null);
  // Longer store titles still find their own app, not the shorter one.
  const long = [{ id: 'c1', title: 'YouTube TV - Live TV & more' }, { id: 'c2', title: 'YouTube: Videos & Music' }];
  assert.equal(resolveApp(entry('youtubetv'), 'lg', long).id, 'c1');
  assert.equal(resolveApp(entry('youtube'), 'lg', long).id, 'c2');
  assert.equal(ownerOf({ title: 'YouTube TV' }, 'lg').key, 'youtubetv');
  // Free titles go through the same rules (scenes, bulk).
  assert.equal(matchTitle('YouTube', onlyTv, 'lg'), null);
  assert.equal(matchTitle('youtube tv', onlyTv, 'lg').id, 'a1');
});

test('resolve: exact title, then a careful fuzzy match', () => {
  const apps = [
    { id: 's1', title: 'Spotify - Music and Podcasts' },
    { id: 'd1', title: 'Disney Plus' },
    { id: 'h1', title: 'HBO Max' },
    { id: 'p1', title: 'Pandora' },
    { id: 'r1', title: 'Red Bull TV' },
  ];
  assert.deepEqual(resolveApp(entry('spotify'), 'lg', apps), { id: 's1', title: 'Spotify - Music and Podcasts', via: 'fuzzy' });
  assert.equal(resolveApp(entry('disneyplus'), 'lg', apps).via, 'title');
  assert.equal(resolveApp(entry('max'), 'lg', apps).id, 'h1');
  assert.equal(resolveApp(entry('netflix'), 'lg', apps), null);
  assert.equal(matchTitle('pandora', apps, 'lg').id, 'p1');
  assert.equal(matchTitle('Red Bull', apps, 'lg').id, 'r1');
  assert.equal(matchTitle('Red', apps, 'lg').id, 'r1');
  assert.equal(matchTitle('Bull', apps, 'lg'), null, 'only whole-word prefixes, never a substring');
});

test('resolve: a TV that can’t list apps gets the first catalog id; none means not launchable', () => {
  assert.deepEqual(resolveApp(entry('youtubetv'), 'appletv', null), { id: 'com.google.ios.youtubeunplugged', title: 'YouTube TV', via: 'catalog' });
  assert.equal(resolveApp(entry('hulu'), 'androidtv', null), null);
});

// ── POST /api/launch across brands, plus bulk and scenes ──
const log = [];
const INSTALLED = {
  lg: [{ id: 'youtube.leanback.v4', title: 'YouTube' }, { id: 'youtube.leanback.ytv.v1', title: 'YouTube TV' }, { id: 'netflix', title: 'Netflix' }],
  samsung: [{ id: '111299001912', title: 'YouTube' }, { id: '3201707014489', title: 'YouTube TV' }],
  roku: [{ id: '837', title: 'YouTube' }, { id: '12', title: 'Netflix' }],
  androidtv: [{ id: '233637DE', title: 'YouTube' }, { id: '32EAB1DF', title: 'YouTube TV' }],
};
class FakeTv extends Driver {
  capabilities = { volumeLevel: true, inputs: false, toast: false, appIcons: false };
  refreshes = 0;
  active = null;
  start() { this.setState({ online: true, power: this.tv.name === 'Off' ? 'off' : 'on' }); if (this.tv.name === 'Off') this.setState({ online: false }); }
  async pair() { this.onCredentials({ k: 1 }); this.start(); }
  async key(name) { log.push([this.tv.name, 'key', name]); }
  async powerOn() { log.push([this.tv.name, 'on']); setTimeout(() => this.setState({ online: true, power: 'on' }), 20); }
  async powerOff() { this.setState({ online: false, power: 'off' }); }
  async apps() {
    if (!this.state.online) throw new Error('off');
    return INSTALLED[this.tv.brand];
  }
  async launch(id) { log.push([this.tv.name, 'launch', id]); }
  // `handOn`: someone switched it on with its own remote; a reconnect finds it.
  async reconnect() { log.push([this.tv.name, 'reconnect']); if (this.handOn) this.setState({ online: true, power: 'on' }); }
  refresh() { this.refreshes++; }
  setActive(a) { this.active = a; }
}

let dir;
let hub;
let server;
let base;
before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-catalog-'));
  hub = await new Hub({ store: new Store(dir), drivers: { lg: FakeTv, samsung: FakeTv, roku: FakeTv, androidtv: FakeTv }, probeFn: async () => null }).init();
  Object.assign(hub, { pollMs: 10, wakeMs: 1000, wakeSettleMs: 0, settleDelays: [5], lookFirstMs: 40, kickEveryMs: 100, kickGapMs: 0 });
  for (const [brand, ip, name] of [['lg', '10.0.0.5', 'Living'], ['samsung', '10.0.0.6', 'Study'], ['roku', '10.0.0.7', 'Off'], ['androidtv', '10.0.0.8', 'Upstairs']]) {
    const tv = await hub.add({ ip, brand, name, macs: ['aa:bb:cc:dd:ee:0' + ip.slice(-1)] });
    await hub.pair(tv.id);
  }
  hub.scenes = await new Scenes({ hub, store: new SceneStore(dir), waitOnlineMs: 1000, pollMs: 10 }).init();
  server = createServer(hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const idOf = (name) => hub.tvs.find((t) => t.name === name).id;
const reset = () => {
  log.length = 0;
  hub.driver(idOf('Off')).setState({ online: false, power: 'off' });
};

test('launch: YouTube TV on all TVs → each TV’s own id, a result per TV, off TVs say so', async () => {
  reset();
  const { status, body } = await call('POST', '/api/launch', { app: 'youtubetv', tvs: 'all' });
  assert.equal(status, 200);
  assert.equal(body.title, 'YouTube TV');
  const by = Object.fromEntries(body.results.map((r) => [r.name, r]));
  assert.equal(by.Living.appId, 'youtube.leanback.ytv.v1');
  assert.equal(by.Study.appId, '3201707014489');
  assert.equal(by.Upstairs.appId, '32EAB1DF');
  assert.deepEqual([by.Off.ok, by.Off.reason], [false, 'off']);
  assert.ok(!log.some((l) => l[2] === 'youtube.leanback.v4' || l[2] === '111299001912'), 'never plain YouTube');
});

test('launch: wake turns off TVs on first, then opens the app; missing apps say why', async () => {
  reset();
  const { body } = await call('POST', '/api/launch', { app: 'youtubetv', tvs: [idOf('Off')], wake: true });
  const [r] = body.results;
  assert.equal(r.ok, false, 'the Roku woke, but has no YouTube TV');
  assert.equal(r.reason, 'not-installed');
  assert.match(r.error, /YouTube TV isn’t installed/);
  assert.deepEqual(log.map((l) => l[1]), ['on']);
  reset();
  const ok = await call('POST', '/api/launch', { app: 'netflix', tvs: [idOf('Off')], wake: true });
  assert.deepEqual([ok.body.results[0].ok, ok.body.results[0].appId, ok.body.results[0].woke], [true, '12', true]);
  assert.deepEqual(log.map((l) => l[1]), ['on', 'launch']);
});

test('any button on a sleeping TV wakes it first, then does the press; presses while it wakes share one wake', async () => {
  reset();
  const id = idOf('Off');
  const [a, b] = await Promise.all([call('POST', `/api/tvs/${id}/key`, { key: 'ok' }), call('POST', `/api/tvs/${id}/key`, { key: 'down' })]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual(log.map((l) => l[1]).filter((v) => v !== 'reconnect'), ['on', 'key', 'key'], 'one wake, then both presses');
  log.length = 0;
  await call('POST', `/api/tvs/${idOf('Living')}/key`, { key: 'ok' });
  assert.deepEqual(log.map((l) => l[1]), ['key'], 'an awake TV is never woken');
  await call('POST', `/api/tvs/${id}/power`, { on: false });
  log.length = 0;
  await call('POST', `/api/tvs/${id}/key`, { key: 'voldown' });
  assert.deepEqual(log.map((l) => l[1]), ['key'], 'a press right after switching it off doesn’t switch it back on');
});

test('a TV that never wakes fails the press with a plain answer', async () => {
  await hub.power(idOf('Off'), true); // forget the switch-off above
  await new Promise((r) => setTimeout(r, 40));
  reset();
  const drv = hub.driver(idOf('Off'));
  const real = drv.powerOn;
  drv.powerOn = async () => {};
  Object.assign(hub, { wakeMs: 60 });
  const { status, body } = await call('POST', `/api/tvs/${idOf('Off')}/key`, { key: 'ok' });
  Object.assign(hub, { wakeMs: 1000 });
  drv.powerOn = real;
  assert.equal(status, 503);
  assert.match(body.error, /didn’t wake up/);
});

test('a TV that wakes somewhere else: the hub looks for it again while it comes up', async () => {
  await hub.power(idOf('Off'), true);
  await new Promise((r) => setTimeout(r, 40));
  reset();
  const drv = hub.driver(idOf('Off'));
  const real = drv.powerOn;
  drv.powerOn = async () => {};
  const seeks = [];
  const real2 = hub.seek.bind(hub);
  hub.seek = (o) => (seeks.push(o?.force ?? false), false);
  Object.assign(hub, { wakeMs: 120, reseekMs: [30, 60] });
  await call('POST', `/api/tvs/${idOf('Off')}/key`, { key: 'ok' });
  Object.assign(hub, { wakeMs: 1000, reseekMs: undefined });
  drv.powerOn = real;
  hub.seek = real2;
  assert.deepEqual(seeks, [false, true, true], 'once before the wake, then twice (unthrottled) after');
});

test('a TV switched on by hand while its driver waits out a backoff: a press reconnects, nothing toggles power', async () => {
  reset();
  await hub.power(idOf('Off'), true); // forget earlier switch-offs
  await new Promise((r) => setTimeout(r, 40));
  reset();
  const drv = hub.driver(idOf('Off'));
  drv.handOn = true;
  try {
    const { status } = await call('POST', `/api/tvs/${idOf('Off')}/key`, { key: 'ok' });
    assert.equal(status, 200);
    assert.deepEqual(log.map((l) => l[1]), ['reconnect', 'key'], 'reconnected, no Wake-on-LAN or power key');
  } finally {
    drv.handOn = false;
  }
});

test('while Hearth is open, an offline TV whose port opens is reconnected at once', async () => {
  reset();
  const drv = hub.driver(idOf('Off'));
  drv.handOn = true;
  Object.assign(hub, { lookoutMs: 20, portOpenFn: async () => true });
  hub.setViewers(1);
  try {
    for (let i = 0; i < 50 && !drv.state.online; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(drv.state.online, true);
    assert.ok(log.some((l) => l[0] === 'Off' && l[1] === 'reconnect'));
  } finally {
    hub.setViewers(0);
    drv.handOn = false;
    delete hub.portOpenFn;
  }
});

test('launch: Google TV explains apps Cast can’t open; junk is rejected', async () => {
  const { body } = await call('POST', '/api/launch', { app: 'max', tvs: [idOf('Upstairs')] });
  assert.deepEqual([body.results[0].ok, body.results[0].reason], [false, 'unsupported']);
  assert.match(body.results[0].error, /Google TV/);
  assert.equal((await call('POST', '/api/launch', { tvs: 'all' })).status, 400);
  assert.equal((await call('POST', '/api/launch', { app: 'youtube', tvs: ['nope'] })).status, 400);
  const form = await fetch(`${base}/api/launch`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'app=youtube' });
  assert.equal(form.status, 415, 'still JSON-only');
});

test('launch: the catalog and per-TV status for the app grid', async () => {
  const cat = (await call('GET', '/api/catalog')).body;
  assert.ok(cat.length >= 20);
  assert.ok(!('ids' in cat[0]), 'the grid needs keys and names, not ids');
  assert.deepEqual(cat.find((c) => c.key === 'hulu').brands.includes('androidtv'), false);
  const status = (await call('GET', '/api/catalog/status')).body;
  assert.equal(status[idOf('Living')].youtubetv.installed, true);
  assert.equal(status[idOf('Living')].hulu.installed, false);
  assert.equal(status[idOf('Upstairs')].hulu.reason, 'unsupported');
});

test('bulk and scenes speak the same launch vocabulary ({ app } or { title })', async () => {
  reset();
  const ids = [idOf('Living'), idOf('Study')];
  const results = await bulk(hub, ids, 'launch', { app: 'youtubetv' });
  assert.ok(results.every((r) => r.ok));
  assert.deepEqual(log.map((l) => l[2]), ['youtube.leanback.ytv.v1', '3201707014489']);
  log.length = 0;
  const viaTitle = await bulk(hub, ids, 'launch', { title: 'YouTube' });
  assert.ok(viaTitle.every((r) => r.ok));
  assert.deepEqual(log.map((l) => l[2]), ['youtube.leanback.v4', '111299001912']);
  log.length = 0;
  const scene = (await call('POST', '/api/scenes', { name: 'Game day', steps: [{ target: [idOf('Living')], action: 'launch', args: { app: 'youtubetv' } }] })).body;
  const run = await hub.scenes.run(scene.id);
  assert.ok(run.ok);
  assert.deepEqual(log.map((l) => l[2]), ['youtube.leanback.ytv.v1']);
});

test('after a command the hub re-reads the TV; open app screens speed polling up', async () => {
  const d = hub.driver(idOf('Living'));
  const before = d.refreshes;
  await call('POST', `/api/tvs/${idOf('Living')}/key`, { key: 'ok' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(d.refreshes > before, 'refresh() ran after the key');
  assert.equal(d.active, false);
  const ctrl = new AbortController();
  const es = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.active, true, 'an open app → active polling');
  ctrl.abort();
  await es.body?.cancel().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(d.active, false);
});
