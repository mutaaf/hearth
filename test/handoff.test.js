import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hub } from '../src/hub-core.js';
import { Store } from '../src/store.js';
import { SceneStore, Scenes } from '../src/scenes.js';
import { handle } from '../src/worker/index.js';
import { MESSAGES, newKey, openBox, parseInvite, planImport, seal, keyText } from '../src/handoff.js';
import { routes } from '../src/routes.js';

// "Share this house": phone A seals its paired TVs and scenes, Hearth Cloud
// holds only the sealed box, phone B opens it with the key from the link.

// Just enough of Cloudflare D1 over node:sqlite for the Worker's queries.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  return {
    raw: db,
    prepare(sql) {
      const st = db.prepare(sql);
      let args = [];
      const api = {
        bind: (...a) => ((args = a), api),
        run: async () => ({ meta: { changes: Number(st.run(...args).changes) } }),
        first: async () => st.get(...args) ?? null,
        all: async () => ({ results: st.all(...args) }),
      };
      return api;
    },
  };
}

const CLOUD = 'https://mutaafaziz.com/hearth/api';
// The Worker itself, behind a fetch: what the hubs talk to.
function cloud(env = { DB: fakeD1() }) {
  const seen = [];
  const fetchFn = async (url, init = {}) => {
    seen.push({ url: String(url), body: init.body ?? null });
    return handle(new Request(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body }), env);
  };
  return { env, seen, fetchFn };
}

const post = (p, body, headers = {}) => new Request(`${CLOUD}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4', ...headers }, body: JSON.stringify(body) });
const get = (p) => new Request(`${CLOUD}${p}`, { headers: { 'cf-connecting-ip': '1.2.3.4' } });

class Fake extends EventEmitter {
  constructor(tv, { onCredentials }) {
    super();
    this.tv = tv;
    this.state = { online: true, power: 'on' };
    this.onCredentials = onCredentials;
    this.started = 0;
  }
  setState(p) {
    this.state = { ...this.state, ...p };
    this.emit('state', this.state);
  }
  start() {
    this.started++;
  }
  async stop() {}
  async pair() {
    this.onCredentials({ key: `${this.tv.name}-${Math.random().toString(36).slice(2, 8)}` });
  }
  async reconnect() {}
}

async function phone(fetchFn, drivers = { samsung: Fake, roku: Fake, appletv: Fake, lg: Fake }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-share-'));
  const hub = await new Hub({ store: new Store(dir), drivers, probeFn: async () => null, handoff: { cloud: CLOUD, fetchFn } }).init();
  hub.scenes = await new Scenes({ hub, store: new SceneStore(dir) }).init();
  const add = async (brand, ip, name, macs = [], { pair = true, room = '' } = {}) => {
    const t = await hub.add({ ip, brand, name, macs, room });
    if (pair) await hub.pair(t.id);
    return t.id;
  };
  return { hub, dir, add, done: async () => (await hub.close(), rmSync(dir, { recursive: true, force: true })) };
}

test('seal and open: the same house comes back; a changed byte or the wrong key is one plain error', () => {
  const key = newKey();
  const house = { hearth: 'house', v: 1, tvs: [{ id: 'lg-1', credentials: { clientKey: 'secret' } }], note: 'ünïcødé 📺' };
  const box = seal(house, key);
  assert.match(box, /^[A-Za-z0-9_-]+$/);
  assert.ok(!box.includes('secret'));
  assert.deepEqual(openBox(box, key), house);
  // Two seals of the same thing differ (fresh nonce).
  assert.notEqual(seal(house, key), box);
  const flip = box.slice(0, 40) + (box[40] === 'A' ? 'B' : 'A') + box.slice(41);
  for (const [b, k] of [[flip, key], [box, newKey()], [box.slice(0, 30), key], ['not base64!', key], [box, key.slice(0, 16)]]) {
    assert.throws(() => openBox(b, k), (err) => err.status === 400 && err.message === MESSAGES.broken);
  }
});

test('invite links: the web link, the app link, #house= and the bare pair all parse; anything else is a plain 400', () => {
  const key = newKey();
  const id = 'AbCdEfGhIjKlMnOpQrStUv';
  for (const text of [`https://mutaafaziz.com/hearth/join#${id}.${keyText(key)}`, `hearth://join#${id}.${keyText(key)}`, `#house=${id}.${keyText(key)}`, ` ${id}.${keyText(key)}\n`]) {
    const p = parseInvite(text);
    assert.equal(p.id, id);
    assert.deepEqual([...p.key], [...key]);
  }
  for (const bad of ['', 'https://mutaafaziz.com/hearth/join', `${id}.short`, `${id}.${keyText(key)}x`]) {
    assert.throws(() => parseInvite(bad), (err) => err.status === 400 && /isn’t a Hearth invite/.test(err.message));
  }
});

test('Worker /handoff: stores only the box, hands it over once, then 404; expired is 410; junk and oversize refused', async () => {
  const env = { DB: fakeD1() };
  const box = seal({ hello: 'house' }, newKey());
  const made = await handle(post('/handoff', { box }), env);
  assert.equal(made.status, 201);
  const { id, expires } = await made.json();
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.ok(Math.abs(new Date(expires) - Date.now() - 24 * 3_600_000) < 60_000);
  const first = await handle(get(`/handoff/${id}`), env);
  assert.equal(first.status, 200);
  assert.equal((await first.json()).box, box);
  const second = await handle(get(`/handoff/${id}`), env);
  assert.equal(second.status, 404);
  assert.match((await second.json()).error, /already used or has expired/);
  assert.equal((await handle(get('/handoff/short'), env)).status, 404, 'a malformed id never reaches the table');

  // Expired: 410 and gone.
  const { id: old } = await (await handle(post('/handoff', { box }), env)).json();
  env.DB.raw.prepare('UPDATE handoff SET expires = ? WHERE id = ?').run(Date.now() - 1, old);
  assert.equal((await handle(get(`/handoff/${old}`), env)).status, 410);
  assert.equal((await handle(get(`/handoff/${old}`), env)).status, 404);

  assert.equal((await handle(post('/handoff', { box: 'short' }), env)).status, 400);
  assert.equal((await handle(post('/handoff', { box: 'has spaces and more than fifty four characters in it ......' }), env)).status, 400);
  assert.equal((await handle(post('/handoff', { box: 'A'.repeat(90_000) }), env)).status, 413);
  assert.equal((await handle(new Request(`${CLOUD}/handoff`, { method: 'POST', body: 'x' }), env)).status, 415);
  // Expired rows are swept on the next upload.
  const { id: stale } = await (await handle(post('/handoff', { box }), env)).json();
  env.DB.raw.prepare('UPDATE handoff SET expires = ? WHERE id = ?').run(Date.now() - 1, stale);
  await handle(post('/handoff', { box }, { 'cf-connecting-ip': '5.6.7.8' }), env);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM handoff WHERE id = ?').get(stale).n, 0);
});

test('Worker /handoff: uploads are rate limited per address', async () => {
  const env = { DB: fakeD1() };
  const box = seal({ a: 1 }, newKey());
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await handle(post('/handoff', { box }, { 'cf-connecting-ip': '9.9.9.9' }), env)).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(201));
  assert.equal(codes[10], 429);
});

test('share → join: phone B gets every paired TV with its keys and the scenes; the server never sees a key', async () => {
  const c = cloud();
  const a = await phone(c.fetchFn);
  const b = await phone(c.fetchFn);
  try {
    const den = await a.add('samsung', '10.0.0.6', 'Den', ['aa:bb:cc:dd:ee:06'], { room: 'Den' });
    const roku = await a.add('roku', '10.0.0.7', 'Kids Roku');
    await a.add('lg', '10.0.0.9', 'Spare', [], { pair: false }); // not paired: stays home
    await a.hub.update(den, { wakeVia: roku });
    await a.hub.scenes.create({ name: 'Cartoons', steps: [{ target: [roku], action: 'power', args: { on: true } }, { target: [den], action: 'volume', args: { level: 12 } }] });

    const made = await a.hub.handoff.create();
    assert.equal(made.tvs, 2);
    assert.match(made.link, /^https:\/\/mutaafaziz\.com\/hearth\/join#[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    assert.equal(made.appLink, made.link.replace('https://mutaafaziz.com/hearth/join', 'hearth://join'));
    assert.match(made.qr, /^<svg/);
    // What went over the wire: the box only. No key, no names, no credentials.
    const keyPart = made.link.split('.').pop();
    const sent = c.seen.map((s) => `${s.url} ${s.body ?? ''}`).join('\n');
    for (const secret of [keyPart, 'Kids Roku', 'Den-', '10.0.0.6', 'aa:bb:cc']) assert.ok(!sent.includes(secret), `leaked ${secret}`);

    const preview = await b.hub.handoff.open(made.link);
    assert.deepEqual(preview.tvs.map((t) => [t.name, t.status]), [['Den', 'new'], ['Kids Roku', 'new']]);
    assert.ok(!JSON.stringify(preview).includes('key'), 'the preview never carries credentials');
    assert.equal(preview.scenes, 4); // three starters + Cartoons

    const got = await b.hub.handoff.accept(preview.token);
    assert.deepEqual(got.added.map((t) => [t.name, t.paired, t.room]), [['Den', true, 'Den'], ['Kids Roku', true, '']]);
    const bDen = b.hub.tvs.find((t) => t.name === 'Den');
    assert.deepEqual(bDen.credentials, a.hub.get(den).credentials, 'same pairing, no Allow prompt');
    assert.equal(bDen.wakeVia, b.hub.tvs.find((t) => t.name === 'Kids Roku').id);
    assert.equal(b.hub.driver(bDen.id).started, 1, 'the driver starts at once');
    assert.equal(got.scenes, 1, 'Cartoons comes along; the starter scenes were already here');
    const cartoons = b.hub.scenes.scenes.find((s) => s.name === 'Cartoons');
    assert.deepEqual(cartoons.steps.map((s) => s.target), [[roku], [den]]);
    // Saved: a restart keeps them.
    assert.equal((await new Store(b.dir).load()).length, 2);

    // The invite worked once.
    await assert.rejects(b.hub.handoff.open(made.link), (err) => err.status === 410 && err.message === MESSAGES.gone);
    // And the token is spent.
    assert.throws(() => b.hub.handoff.preview(preview.token), (err) => err.status === 410);
  } finally {
    await a.done();
    await b.done();
  }
});

test('a tampered box is a clean 400 on the phone, never half a house', async () => {
  const c = cloud();
  const a = await phone(c.fetchFn);
  const b = await phone(c.fetchFn);
  try {
    await a.add('roku', '10.0.0.7', 'Roku');
    const made = await a.hub.handoff.create();
    const id = made.link.split('#')[1].split('.')[0];
    const row = c.env.DB.raw.prepare('SELECT box FROM handoff WHERE id = ?').get(id);
    const box = row.box;
    c.env.DB.raw.prepare('UPDATE handoff SET box = ? WHERE id = ?').run(box.slice(0, 60) + (box[60] === 'A' ? 'B' : 'A') + box.slice(61), id);
    await assert.rejects(b.hub.handoff.open(made.link), (err) => err.status === 400 && err.message === MESSAGES.broken);
    assert.equal(b.hub.tvs.length, 0);
  } finally {
    await a.done();
    await b.done();
  }
});

test('merge rules: same TV by id, MAC, Apple TV id or address; ours unpaired takes theirs; ours paired stays unless asked', async () => {
  const c = cloud();
  const a = await phone(c.fetchFn);
  const b = await phone(c.fetchFn);
  try {
    await a.add('samsung', '10.0.0.6', 'Den', ['aa:bb:cc:dd:ee:06']);
    await a.add('lg', '10.0.0.9', 'Bedroom', ['aa:bb:cc:dd:ee:09']);
    await a.add('roku', '10.0.0.7', 'Roku');
    await a.add('appletv', '10.0.0.8', 'ATV');
    // B already has: the LG paired with its own key (by MAC, at a new address),
    // the Samsung unpaired, and the Roku paired with the very same key.
    await b.add('lg', '10.0.0.19', 'Our LG', ['AA:BB:CC:DD:EE:09']);
    await b.add('samsung', '10.0.0.6', 'Samsung', ['aa:bb:cc:dd:ee:06'], { pair: false });
    const bRoku = await b.add('roku', '10.0.0.7', 'Roku', [], { pair: false });
    const rokuKey = a.hub.tvs.find((t) => t.brand === 'roku').credentials;
    b.hub.get(bRoku).credentials = JSON.parse(JSON.stringify(rokuKey));
    const lgKeyB = JSON.stringify(b.hub.tvs.find((t) => t.brand === 'lg').credentials);

    const made = await a.hub.handoff.create();
    const preview = await b.hub.handoff.open(made.link);
    const by = Object.fromEntries(preview.tvs.map((t) => [t.name, t]));
    assert.equal(by.Den.status, 'adopt');
    assert.equal(by.Den.as, 'Samsung');
    assert.equal(by.Bedroom.status, 'have');
    assert.equal(by.Bedroom.as, 'Our LG');
    assert.equal(by.Roku.status, 'same');
    assert.equal(by.ATV.status, 'new');
    assert.equal(b.hub.handoff.adds(preview.token), 1);
    assert.equal(b.hub.handoff.adds(preview.token, { only: [] }), 0);

    // Keep our LG pairing (no replace): only the Samsung and the Apple TV change.
    const got = await b.hub.handoff.accept(preview.token);
    assert.deepEqual(got.added.map((t) => t.name), ['ATV']);
    assert.deepEqual(got.updated.map((t) => t.name), ['Samsung'], 'keeps our name for a TV we had');
    assert.deepEqual(got.kept.map((t) => t.name).sort(), ['Our LG', 'Roku']);
    assert.equal(JSON.stringify(b.hub.tvs.find((t) => t.brand === 'lg').credentials), lgKeyB);
    assert.equal(b.hub.tvs.length, 4, 'no duplicates');
    assert.ok(b.hub.tvs.find((t) => t.brand === 'samsung').credentials);

    // A second invite, this time saying yes to their LG pairing.
    const again = await b.hub.handoff.open((await a.hub.handoff.create()).link);
    const lgRef = again.tvs.find((t) => t.name === 'Bedroom').ref;
    assert.equal(b.hub.handoff.preview(again.token, { replace: [lgRef] }).tvs.find((t) => t.ref === lgRef).status, 'replace');
    const swapped = await b.hub.handoff.accept(again.token, { replace: [lgRef] });
    assert.deepEqual(swapped.updated.map((t) => t.name), ['Our LG']);
    assert.deepEqual(b.hub.tvs.find((t) => t.brand === 'lg').credentials, a.hub.tvs.find((t) => t.brand === 'lg').credentials);
    assert.equal(b.hub.tvs.length, 4);
  } finally {
    await a.done();
    await b.done();
  }
});

test('planImport: only picks, brands this hub can’t drive, and one of ours never matches twice', () => {
  const ours = [{ id: 'x', brand: 'roku', ip: '10.0.0.7', macs: [], credentials: { a: 1 } }];
  const theirs = [
    { id: 'r1', brand: 'roku', ip: '10.0.0.7', macs: [], credentials: { a: 2 } },
    { id: 'r2', brand: 'roku', ip: '10.0.0.7', macs: [], credentials: { a: 3 } },
    { id: 'z', brand: 'zenith', ip: '10.0.0.3', macs: [], credentials: { a: 4 } },
    { id: 'n', brand: 'lg', ip: '10.0.0.4', macs: [], credentials: { a: 5 } },
  ];
  const plan = planImport(ours, theirs, { supported: new Set(['roku', 'lg']), only: ['r1'] });
  assert.deepEqual(plan.map((p) => [p.inc.id, p.status, p.reason ?? null]), [['r1', 'have', null], ['r2', 'skip', 'not-picked'], ['z', 'skip', 'unsupported'], ['n', 'skip', 'not-picked']]);
  // An Apple TV that moved: same pyatv identifier, new address and id.
  const atv = planImport([{ id: 'appletv-a', brand: 'appletv', ip: '10.0.0.8', atvId: 'AA:11:22', macs: [] }], [{ id: 'appletv-b', brand: 'appletv', ip: '10.0.0.28', atvId: 'AA:11:22', macs: [], credentials: { companion: 'x' } }]);
  assert.equal(atv[0].status, 'adopt');
  assert.equal(atv[0].match.id, 'appletv-a');
});

test('nothing paired: no invite; the routes carry it end to end and never return a credential', async () => {
  const c = cloud();
  const a = await phone(c.fetchFn);
  const b = await phone(c.fetchFn);
  try {
    await assert.rejects(a.hub.handoff.create(), (err) => err.status === 409);
    await a.add('roku', '10.0.0.7', 'Roku');
    const call = async (hub, method, p, body = {}) => {
      for (const [m, re, fn] of routes(hub)) {
        const match = `/api${p}`.match(re);
        if (match && m === method) return fn(match.slice(1), body, new URL(`http://x/api${p}`), { headers: {} });
      }
      throw new Error(`no route ${p}`);
    };
    const made = await call(a.hub, 'POST', '/handoff/create');
    const preview = await call(b.hub, 'POST', '/handoff/open', { invite: made.link });
    const ref = preview.tvs[0].ref;
    assert.equal((await call(b.hub, 'POST', '/handoff/preview', { token: preview.token, only: [] })).tvs[0].status, 'skip');
    const got = await call(b.hub, 'POST', '/handoff/accept', { token: preview.token, only: [ref, '<bad id>'] });
    assert.equal(got.added.length, 1);
    assert.ok(!JSON.stringify([made, preview, got]).includes(JSON.stringify(a.hub.tvs[0].credentials).slice(1, -1)));
    assert.deepEqual(await call(b.hub, 'POST', '/handoff/forget', { token: 'nope' }), { ok: true });
  } finally {
    await a.done();
    await b.done();
  }
});
