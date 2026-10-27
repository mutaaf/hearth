import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { guideKey, sanitizeSupport, scrub, validateGuide } from '../src/device-schema.js';
import { handle } from '../src/worker/index.js';

// Just enough of Cloudflare D1 over node:sqlite for the Worker's queries.
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  return {
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

const post = (path, body, headers = {}) =>
  new Request(`https://mutaafaziz.com/hearth/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const GUIDE = {
  family: 'Samsung 2016 smart TV (K series)',
  year: 2016,
  os: 'Tizen',
  connect: { how: 'none', summary: 'This TV connects by itself.', before: [], onTv: null },
  keepReachable: [{ title: 'Power On with Mobile', path: 'Settings → General → Network → Expert Settings → Power On with Mobile' }],
  troubleshoot: [{ when: 'refused', fix: 'Settings → General → External Device Manager → Device Connect Manager → Access Notification.' }],
  quirks: [],
  confidence: 'high',
};

test('scrub takes out addresses, serials, emails and long numbers, keeps model codes', () => {
  assert.equal(scrub('OLED55C2PUA at 192.168.4.45 (34:e6:e6:00:11:22) serial 0B7S3CAJ900123X, me@x.com 4695551234'), 'OLED55C2PUA at [ip] ([mac]) serial [id], [email] #');
  assert.equal(scrub('QN65QN90BAFXZA'), 'QN65QN90BAFXZA');
});

test('a support report keeps only what a TV is and what went wrong', () => {
  const r = sanitizeSupport({
    device: { brand: 'samsung', model: 'UN55KU6290', firmware: 'T-KTMAKUC-1440.1', name: 'Living Room', ip: '192.168.4.50' },
    symptom: { when: 'refused', steps: [{ step: 'pair', status: 'fail', detail: 'refused by 192.168.4.50' }], ports: [{ port: 8001, open: true }, { port: 'x' }], error: 'ECONNREFUSED 192.168.4.50:8002' },
    app: { platform: 'ios', version: '1.0 (2610271351)' },
    note: 'In the Living Room, my email is a@b.co',
    macs: ['aa:bb:cc:dd:ee:ff'],
  });
  const text = JSON.stringify(r);
  assert.ok(!/192\.168|aa:bb|a@b\.co/.test(text), text);
  assert.equal(r.device.name, undefined);
  assert.deepEqual(r.symptom.ports, [{ port: 8001, open: true }]);
  assert.equal(r.app.version, '', 'a version with spaces is dropped, not guessed');
  assert.equal(sanitizeSupport({ device: { brand: 'toaster' } }), null);
});

test('validateGuide keeps a usable answer and drops junk', () => {
  assert.equal(validateGuide({ connect: {} }), null);
  const g = validateGuide({ ...GUIDE, year: 1999, troubleshoot: [{ when: 'lol', fix: 'x' }, ...GUIDE.troubleshoot] });
  assert.equal(g.year, null);
  assert.equal(g.troubleshoot.length, 1);
  assert.equal(guideKey({ brand: 'lg', model: ' oled55c2pua ' }, null), 'lg|OLED55C2PUA|setup');
});

test('Worker /device: the AI writes a guide once; the next house with that TV gets it from the cache', async () => {
  let calls = 0;
  const env = { DB: fakeD1(), AI: { run: async () => (calls++, { response: JSON.stringify(GUIDE) }) } };
  const body = { device: { brand: 'samsung', model: 'UN55KU6290' }, symptom: { when: 'refused' } };
  const first = await (await handle(post('/device', body), env)).json();
  assert.equal(first.guide.connect.how, 'none');
  assert.equal(first.cached, false);
  const second = await (await handle(post('/device', body), env)).json();
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  assert.equal((await handle(post('/device', { device: { brand: 'samsung' } }), env)).status, 400);
});

test('Worker /support: the queue takes a report, the app can check its status, only the agent can read or update it', async () => {
  const env = { DB: fakeD1(), SUPPORT_TOKEN: 'secret-token' };
  const report = { device: { brand: 'roku', model: '3941X' }, symptom: { when: 'not-found' }, note: 'never shows up' };
  const res = await handle(post('/support', { report }), env);
  assert.equal(res.status, 201);
  const { id } = await res.json();
  const status = await (await handle(new Request(`https://x/hearth/api/support/status/${id}`), env)).json();
  assert.equal(status.status, 'new');

  assert.equal((await handle(new Request('https://x/hearth/api/support'), env)).status, 404, 'no token, no queue');
  const auth = { authorization: 'Bearer secret-token' };
  const list = await (await handle(new Request('https://x/hearth/api/support?status=new', { headers: auth }), env)).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].report.device.model, '3941X');

  const patch = (b) => new Request(`https://x/hearth/api/support/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(b) });
  assert.equal((await handle(patch({ status: 'nope' }), env)).status, 400);
  assert.equal((await handle(patch({ status: 'supported', resolution: 'Roku 3941 added in 1.1.' }), env)).status, 200);
  const after = await (await handle(new Request(`https://x/hearth/api/support/status/${id}`), env)).json();
  assert.equal(after.status, 'supported');
  assert.equal(after.resolution, 'Roku 3941 added in 1.1.');
});

test('Worker /support: rate-limited per address', async () => {
  const env = { DB: fakeD1() };
  const report = { device: { brand: 'lg', model: 'X' } };
  for (let i = 0; i < 5; i++) assert.equal((await handle(post('/support', { report }), env)).status, 201);
  assert.equal((await handle(post('/support', { report }), env)).status, 429);
});

test('/api/guide: built-in at once; the AI only fills in, and never overrides how the driver connects', async () => {
  const { routes, mergeGuide } = await import('../src/routes.js');
  const { deviceGuide } = await import('../src/devices.js');
  let asked = 0;
  const hub = {
    get: () => ({ id: 'x', brand: 'samsung', model: 'UN55KU6290' }),
    insights: { guide: async () => (asked++, { guide: { ...GUIDE, family: 'AI family', connect: { ...GUIDE.connect, how: 'allow' } }, model: 'gemma', cached: true }) },
  };
  const table = routes(hub);
  const call = (body) => {
    for (const [m, re, fn] of table) if (m === 'POST' && re.test('/api/guide')) return fn([], body, new URL('http://h/api/guide'), { headers: {} });
  };
  const plain = await call({ tvId: 'x' });
  assert.equal(plain.ai, null, 'a known model needs no AI');
  assert.equal(plain.guide.connect.how, 'none');
  assert.equal(asked, 0);
  const helped = await call({ tvId: 'x', symptom: { when: 'refused' } });
  assert.equal(asked, 1, 'something went wrong: ask the AI');
  assert.equal(helped.guide.connect.how, 'none', 'the driver’s truth wins');
  assert.equal(helped.guide.family, deviceGuide({ brand: 'samsung', model: 'UN55KU6290' }).family, 'a known family stays');
  assert.equal(helped.guide.troubleshoot[0].when, 'refused');
  const unknown = mergeGuide(deviceGuide({ brand: 'samsung', model: 'ZZ99' }), GUIDE);
  assert.equal(unknown.family, GUIDE.family, 'an unknown model takes the AI’s family');
  assert.equal(unknown.source, 'AI');
});
