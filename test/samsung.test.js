import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { SamsungDriver } from '../src/drivers/samsung.js';

// A pretend Samsung TV: speaks the samsung.remote.control channel on
// localhost, hands out a token, records what it was sent.
let server;
let port;
const received = [];
let mode = 'allow';

before(async () => {
  server = new WebSocketServer({ port: 0 });
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
  server.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    assert.equal(url.pathname, '/api/v2/channels/samsung.remote.control');
    assert.equal(Buffer.from(url.searchParams.get('name'), 'base64').toString(), 'Hearth');
    if (mode === 'deny') return ws.send(JSON.stringify({ event: 'ms.channel.unauthorized' }));
    const token = url.searchParams.get('token') ?? 'tok-123';
    ws.send(JSON.stringify({ event: 'ms.channel.connect', data: { token } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.params?.event === 'ed.installedApp.get') {
        ws.send(
          JSON.stringify({
            event: 'ed.installedApp.get',
            data: { data: [{ appId: '3201907018807', name: 'Netflix', app_type: 2 }, { appId: '111299001912', name: 'YouTube', app_type: 2 }] },
          }),
        );
      }
    });
  });
});

after(() => server.close());

const makeTv = () => ({ id: 'samsung-test', brand: 'samsung', name: 'Test', ip: '127.0.0.1', macs: [] });
const makeDriver = (tv, saved) =>
  new SamsungDriver(tv, {
    port,
    secure: false,
    fetchInfo: async () => ({ device: { PowerState: 'on' } }),
    onCredentials: (c) => {
      saved.push(c);
      tv.credentials = { ...tv.credentials, ...c };
    },
  });

test('pairing stores the token the TV hands out, and reuses it', async () => {
  mode = 'allow';
  const tv = makeTv();
  const saved = [];
  const driver = makeDriver(tv, saved);
  await driver.pair();
  assert.deepEqual(saved, [{ token: 'tok-123' }]);
  assert.match(driver.url(), /&token=tok-123$/);
  await driver.stop();
});

test('keys are sent as ms.remote.control clicks', async () => {
  mode = 'allow';
  received.length = 0;
  const tv = { ...makeTv(), credentials: { token: 'tok-123' } };
  const driver = makeDriver(tv, []);
  await driver.key('volup');
  await driver.key('ok');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(
    received.map((m) => m.params.DataOfCmd),
    ['KEY_VOLUP', 'KEY_ENTER'],
  );
  assert.equal(received[0].method, 'ms.remote.control');
  await assert.rejects(driver.key('source-of-all-evil'), /isn't supported/);
  await driver.stop();
});

test('a held key is sent as Press then Release', async () => {
  mode = 'allow';
  received.length = 0;
  const tv = { ...makeTv(), credentials: { token: 'tok-123' } };
  const driver = makeDriver(tv, []);
  await driver.key('ok', { hold: 60 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(received.map((m) => [m.params.Cmd, m.params.DataOfCmd]), [['Press', 'KEY_ENTER'], ['Release', 'KEY_ENTER']]);
  await driver.stop();
});

test('apps are listed and launched with the right action type', async () => {
  mode = 'allow';
  received.length = 0;
  const tv = { ...makeTv(), credentials: { token: 'tok-123' } };
  const driver = makeDriver(tv, []);
  const apps = await driver.apps();
  assert.deepEqual(apps.map((a) => a.title), ['Netflix', 'YouTube']);
  await driver.launch('3201907018807');
  await new Promise((r) => setTimeout(r, 50));
  const launch = received.find((m) => m.params?.event === 'ed.apps.launch');
  assert.deepEqual(launch.params.data, { appId: '3201907018807', action_type: 'DEEP_LINK' });
  await driver.stop();
});

test('a declined prompt surfaces as a 403', async () => {
  mode = 'deny';
  const driver = makeDriver(makeTv(), []);
  await assert.rejects(driver.pair(), (err) => err.status === 403);
  await driver.stop();
});

test('power state comes from the REST poll', async () => {
  const tv = { ...makeTv(), credentials: { token: 'tok-123' } };
  const driver = new SamsungDriver(tv, { port, secure: false, fetchInfo: async () => ({ device: { PowerState: 'standby' } }) });
  const state = new Promise((r) => driver.once('state', r));
  driver.start();
  assert.deepEqual(await state, { online: true, power: 'standby', volume: null, muted: null, app: null });
  await driver.stop();
});
