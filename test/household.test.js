import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Driver } from '../src/drivers/base.js';
import { deviceName, Household } from '../src/household.js';
import { Hub } from '../src/hub.js';
import { createLimiter } from '../src/guard.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

// The household: on the Wi-Fi isn't enough; a phone joins with the house code
// or an invite, then carries a cookie. Tests run on 127.0.0.1, so loopback
// trust is switched off to see what a phone sees.
class FakeDriver extends Driver {
  static brand = 'lg';
  start() {
    this.setState({ online: true, power: 'on' });
  }
  async key() {}
}

let dir;
let hub;
let household;
let server;
let base;

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-house-'));
  hub = await new Hub({ store: new Store(dir), drivers: { lg: FakeDriver }, discoverFn: async () => [] }).init();
  household = await new Household({ dir }).init();
  // (Many joins from one test client: a roomy rate limit.)
  server = createServer(hub, { household, trustLoopback: false, limiter: createLimiter({ capacity: 1000 }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  server.close();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (method, p, { cookie, body, headers = {} } = {}) =>
  fetch(`${base}${p}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const join = async (body) => {
  const res = await call('POST', '/api/household/join', { body });
  const set = res.headers.get('set-cookie') ?? '';
  return { res, set, cookie: set.split(';')[0] };
};

test('a new house gets a 6-digit code, kept across restarts, in a private file', async () => {
  assert.match(household.code, /^\d{6}$/);
  const again = await new Household({ dir }).init();
  assert.equal(again.code, household.code);
  assert.equal(statSync(path.join(dir, 'household.json')).mode & 0o777, 0o600);
});

test('a phone that isn’t in sees the door: API 401, but health, status and the app shell work', async () => {
  assert.equal((await call('GET', '/api/tvs')).status, 401);
  assert.equal((await call('POST', '/api/all/power', { body: { on: false } })).status, 401);
  assert.equal((await call('GET', '/api/events')).status, 401);
  assert.equal((await call('GET', '/api/health')).status, 200);
  assert.equal((await call('GET', '/')).status, 200);
  const status = await (await call('GET', '/api/household')).json();
  assert.deepEqual({ locked: status.locked, trusted: status.trusted }, { locked: true, trusted: false });
});

test('joining: a wrong code is refused; the right one sets an HttpOnly cookie that works', async () => {
  assert.equal((await join({ code: '12345' })).res.status, 403);
  const wrong = household.code === '000000' ? '000001' : '000000';
  assert.equal((await join({ code: wrong })).res.status, 403);
  const { res, set, cookie } = await join({ code: household.code.replace(/(\d{3})/, '$1 ') });
  assert.equal(res.status, 200);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
  assert.equal((await call('GET', '/api/tvs', { cookie })).status, 200);
  const status = await (await call('GET', '/api/household', { cookie })).json();
  assert.equal(status.trusted, true);
  // The native app sends the same token as a header.
  const token = cookie.split('=')[1];
  assert.equal((await call('GET', '/api/tvs', { headers: { 'x-hearth-device': token } })).status, 200);
  // Stored hashed: the file can't be replayed as a token.
  assert.ok(!readFileSync(path.join(dir, 'household.json'), 'utf8').includes(token));
});

test('an invite lets exactly one phone in', async () => {
  const { cookie } = await join({ code: household.code });
  const { token } = await (await call('POST', '/api/household/invite', { cookie, body: {} })).json();
  assert.equal((await call('POST', '/api/household/invite', { body: {} })).status, 401, 'only phones that are in can invite');
  const first = await join({ invite: token });
  assert.equal(first.res.status, 200);
  assert.equal((await call('GET', '/api/tvs', { cookie: first.cookie })).status, 200);
  assert.equal((await join({ invite: token })).res.status, 403, 'used once');
});

test('removing a phone cuts its live stream and locks it out', async () => {
  const keeper = await join({ code: household.code });
  const leaver = await join({ code: household.code });
  const id = (await leaver.res.json()).device.id;
  const closed = new Promise((resolve) => {
    const req = http.get(`${base}/api/events`, { headers: { cookie: leaver.cookie } }, (res) => {
      assert.equal(res.statusCode, 200);
      res.once('data', async () => {
        res.on('close', resolve);
        res.on('error', resolve);
        res.resume();
        assert.equal((await call('DELETE', `/api/household/devices/${id}`, { cookie: keeper.cookie })).status, 200);
      });
    });
    req.on('error', resolve);
  });
  await closed;
  assert.equal((await call('GET', '/api/tvs', { cookie: leaver.cookie })).status, 401);
  assert.equal((await call('GET', '/api/tvs', { cookie: keeper.cookie })).status, 200);
});

test('phones list, rename, new code: the code changes, phones already in stay in', async () => {
  const { cookie } = await join({ code: household.code });
  const list = await (await call('GET', '/api/household/devices', { cookie })).json();
  assert.equal(list.code, household.code);
  const me = list.devices.find((d) => d.current);
  assert.ok(me);
  const renamed = await (await call('PATCH', `/api/household/devices/${me.id}`, { cookie, body: { name: '  Kitchen iPad <b>' } })).json();
  assert.equal(renamed.name, 'Kitchen iPad b');
  const old = household.code;
  const { code } = await (await call('POST', '/api/household/code', { cookie, body: {} })).json();
  assert.match(code, /^\d{6}$/);
  assert.equal((await call('GET', '/api/tvs', { cookie })).status, 200);
  if (code !== old) assert.equal((await join({ code: old })).res.status, 403);
});

test('too many wrong codes from anyone: typing stops working, invites still do', async () => {
  const h = await new Household({ dir: mkdtempSync(path.join(os.tmpdir(), 'hearth-house-')) }).init();
  const wrong = h.code === '111111' ? '222222' : '111111';
  for (let i = 0; i < 20; i++) await assert.rejects(h.join({ code: wrong }), { status: 403 });
  await assert.rejects(h.join({ code: h.code }), { status: 429 });
  const { token } = await h.invite();
  assert.ok((await h.join({ invite: token })).token);
});

test('this computer (loopback) is always in; HEARTH_OPEN-style servers have no lock', async () => {
  const local = createServer(hub, { household });
  await new Promise((r) => local.listen(0, '127.0.0.1', r));
  const open = createServer(hub);
  await new Promise((r) => open.listen(0, '127.0.0.1', r));
  try {
    const at = (s) => `http://127.0.0.1:${s.address().port}`;
    assert.equal((await fetch(`${at(local)}/api/tvs`)).status, 200);
    assert.equal((await (await fetch(`${at(local)}/api/household`)).json()).thisComputer, true);
    assert.equal((await (await fetch(`${at(open)}/api/household`)).json()).locked, false);
  } finally {
    for (const s of [local, open]) {
      s.closeAllConnections?.();
      s.close();
    }
  }
});

test('wrong codes are rate limited per phone (429) before the hourly cap', async () => {
  const strict = createServer(hub, { household, trustLoopback: false, limiter: createLimiter({ capacity: 3 }) });
  await new Promise((r) => strict.listen(0, '127.0.0.1', r));
  try {
    const at = `http://127.0.0.1:${strict.address().port}/api/household/join`;
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(at, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"code":"9"}' })).status);
    assert.deepEqual(statuses, [403, 403, 403, 429]);
  } finally {
    strict.closeAllConnections?.();
    strict.close();
  }
});

test('device names from the user agent', () => {
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'iPhone · Safari');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'), 'Android phone · Chrome');
  assert.equal(deviceName(''), 'Device');
});
