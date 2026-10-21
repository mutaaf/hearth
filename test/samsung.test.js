import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { SamsungDriver } from '../src/drivers/samsung.js';

// A pretend Samsung TV on localhost, all three doors:
//  • ws: the samsung.remote.control channel (hands out a token, records what it was sent)
//  • REST :8001-style: /api/v2/ info and /api/v2/applications/<id> (GET status, POST run)
//  • UPnP DMR :9197-style: RenderingControl Get/SetVolume, Get/SetMute over SOAP
let server;
let port;
let web;
let base;
const received = [];
const soapCalls = [];
let mode = 'allow';
const fake = {};
const reset = () =>
  Object.assign(fake, {
    power: 'on', // REST PowerState for 2018+ sets; null = 2016-17 (no PowerState)
    apps: {
      '3201907018807': { name: 'Netflix', running: false, visible: false },
      '111299001912': { name: 'YouTube', running: false, visible: false },
      '3201707014489': { name: 'YouTube TV', running: false, visible: false },
    },
    volume: 19,
    muted: false,
    dmr: true,
    wsLaunch: true, // does ed.apps.launch actually bring the app up?
  });
reset();

const show = (id) => {
  for (const [k, a] of Object.entries(fake.apps)) a.visible = k === id;
  if (fake.apps[id]) fake.apps[id].running = true;
};

before(async () => {
  server = new WebSocketServer({ port: 0 });
  await new Promise((r) => server.once('listening', r));
  port = server.address().port;
  server.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    assert.equal(url.pathname, '/api/v2/channels/samsung.remote.control');
    assert.equal(Buffer.from(url.searchParams.get('name'), 'base64').toString(), 'Hearth');
    if (mode === 'deny') return ws.send(JSON.stringify({ event: 'ms.channel.unauthorized' }));
    const token = mode === 'notoken' ? undefined : url.searchParams.get('token') ?? 'tok-123';
    ws.send(JSON.stringify({ event: 'ms.channel.connect', data: token ? { token } : {} }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      received.push(msg);
      if (msg.params?.event === 'ed.installedApp.get') {
        ws.send(
          JSON.stringify({
            event: 'ed.installedApp.get',
            data: { data: Object.entries(fake.apps).map(([appId, a]) => ({ appId, name: a.name, app_type: 2 })) },
          }),
        );
      }
      if (msg.params?.event === 'ed.apps.launch' && fake.wsLaunch) show(msg.params.data.appId);
    });
  });

  web = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/api/v2/') return json(200, { device: { modelName: 'UN55KU6290', ...(fake.power ? { PowerState: fake.power } : {}) } });
    const app = req.url.match(/^\/api\/v2\/applications\/([^/]+)$/);
    if (app) {
      const id = decodeURIComponent(app[1]);
      const a = fake.apps[id];
      if (!a) return json(404, { status: 404, message: 'Not Found', code: 404 });
      if (req.method === 'POST') {
        received.push({ rest: 'run', id });
        show(id);
        return json(200, true);
      }
      return json(200, { id, version: '1.0', ...a });
    }
    if (req.url === '/upnp/control/RenderingControl1') {
      if (!fake.dmr) {
        res.writeHead(500);
        return res.end();
      }
      const action = req.headers.soapaction.match(/#(\w+)/)[1];
      soapCalls.push(action);
      const arg = (name) => body.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
      let inner = '';
      if (action === 'GetVolume') inner = `<CurrentVolume>${fake.volume}</CurrentVolume>`;
      if (action === 'GetMute') inner = `<CurrentMute>${fake.muted ? 1 : 0}</CurrentMute>`;
      if (action === 'SetVolume') fake.volume = Number(arg('DesiredVolume'));
      if (action === 'SetMute') fake.muted = arg('DesiredMute') === '1';
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end(
        `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">${inner} </u:${action}Response></s:Body></s:Envelope>`,
      );
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${web.address().port}`;
});

after(() => {
  for (const c of server.clients) c.terminate();
  server.close();
  web.close();
});

const makeTv = () => ({ id: 'samsung-test', brand: 'samsung', name: 'Test', ip: '127.0.0.1', macs: [] });
const makeDriver = (tv, saved = [], extra = {}) =>
  new SamsungDriver(tv, {
    port,
    secure: false,
    rest: base,
    dmr: base,
    screenProbe: async () => fake.power !== 'standby',
    launchWaitMs: 300,
    onCredentials: (c) => {
      saved.push(c);
      tv.credentials = { ...tv.credentials, ...c };
    },
    ...extra,
  });
const paired = () => ({ ...makeTv(), credentials: { token: 'tok-123' } });
const nextState = (driver, pred) =>
  new Promise((resolve) => {
    const on = (s) => {
      if (!pred(s)) return;
      driver.off('state', on);
      resolve(s);
    };
    driver.on('state', on);
  });
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('pairing stores the token the TV hands out, and reuses it', async () => {
  mode = 'allow';
  reset();
  const tv = makeTv();
  const saved = [];
  const driver = makeDriver(tv, saved);
  try {
    await driver.pair();
    assert.deepEqual(saved, [{ token: 'tok-123' }]);
    assert.match(driver.url(), /&token=tok-123$/);
  } finally {
    await driver.stop();
  }
});

test('keys are sent as ms.remote.control clicks', async () => {
  mode = 'allow';
  received.length = 0;
  const driver = makeDriver(paired());
  try {
    await driver.key('volup');
    await driver.key('ok');
    await tick();
    assert.deepEqual(
      received.map((m) => m.params.DataOfCmd),
      ['KEY_VOLUP', 'KEY_ENTER'],
    );
    assert.equal(received[0].method, 'ms.remote.control');
    await assert.rejects(driver.key('source-of-all-evil'), /isn't supported/);
  } finally {
    await driver.stop();
  }
});

test('a held key is sent as Press then Release', async () => {
  mode = 'allow';
  received.length = 0;
  const driver = makeDriver(paired());
  try {
    await driver.key('ok', { hold: 60 });
    await tick();
    assert.deepEqual(received.map((m) => [m.params.Cmd, m.params.DataOfCmd]), [['Press', 'KEY_ENTER'], ['Release', 'KEY_ENTER']]);
  } finally {
    await driver.stop();
  }
});

test('apps are listed and launched with the right action type, then confirmed on screen', async () => {
  mode = 'allow';
  reset();
  received.length = 0;
  const driver = makeDriver(paired());
  try {
    const apps = await driver.apps();
    assert.deepEqual(apps.map((a) => a.title), ['Netflix', 'YouTube', 'YouTube TV']);
    await driver.launch('3201907018807');
    const launch = received.find((m) => m.params?.event === 'ed.apps.launch');
    assert.deepEqual(launch.params.data, { appId: '3201907018807', action_type: 'DEEP_LINK' });
    assert.ok(!received.some((m) => m.rest === 'run'), 'no REST fallback when the websocket launch worked');
    assert.equal(fake.apps['3201907018807'].visible, true);
  } finally {
    await driver.stop();
  }
});

test('launch falls back to REST when the websocket launch does nothing, or the websocket is down', async () => {
  mode = 'allow';
  reset();
  fake.wsLaunch = false;
  received.length = 0;
  const driver = makeDriver(paired());
  try {
    await driver.launch('3201707014489');
    assert.deepEqual(received.filter((m) => m.rest).map((m) => m.id), ['3201707014489']);
    assert.equal(fake.apps['3201707014489'].visible, true);
  } finally {
    await driver.stop();
  }
  // Websocket refused (port 1): straight to REST.
  received.length = 0;
  const down = makeDriver(paired(), [], { port: 1 });
  try {
    await down.launch('111299001912');
    assert.deepEqual(received.filter((m) => m.rest).map((m) => m.id), ['111299001912']);
    await assert.rejects(down.launch('nope'), (err) => err.status === 404 && /isn’t installed/.test(err.message));
  } finally {
    await down.stop();
  }
});

test('with the websocket down, apps() still lists catalog apps the REST endpoint confirms', async () => {
  reset();
  const driver = makeDriver(paired(), [], { port: 1 });
  try {
    const apps = await driver.apps();
    assert.deepEqual(apps.map((a) => a.title).sort(), ['Netflix', 'YouTube', 'YouTube TV']);
  } finally {
    await driver.stop();
  }
});

test('the app on screen comes from the REST poll: visible app → state.app + appTitle', async () => {
  reset();
  fake.power = null; // a 2016-17 set
  show('111299001912');
  const driver = makeDriver(paired());
  try {
    const first = nextState(driver, (s) => s.online);
    driver.start();
    assert.deepEqual(await first, { online: true, power: 'on', volume: 19, muted: false, app: '111299001912', appTitle: 'YouTube' });
    // Back to the home screen: nothing visible, panel still on.
    show(null);
    const home = nextState(driver, (s) => s.app === null);
    driver.refresh();
    assert.equal((await home).power, 'on');
    // Opened from the TV's own remote: found on the next look.
    show('3201707014489');
    const ytv = nextState(driver, (s) => s.app === '3201707014489');
    driver.refresh();
    assert.equal((await ytv).appTitle, 'YouTube TV');
  } finally {
    await driver.stop();
  }
});

test('2016-17 power: on while the screen port answers, standby once it closes; 2018+ uses PowerState', async () => {
  reset();
  fake.power = null;
  const driver = makeDriver(paired(), [], { screenProbe: async () => screenOpen });
  let screenOpen = true;
  try {
    const on = nextState(driver, (s) => s.online);
    driver.start();
    assert.equal((await on).power, 'on');
    assert.equal(driver.powerToggles, false, 'power is known, so the button is not a blind toggle');
    screenOpen = false;
    show('111299001912');
    fake.apps['111299001912'].visible = false;
    const standby = nextState(driver, (s) => s.power === 'standby');
    driver.refresh();
    assert.equal((await standby).app, null);
  } finally {
    await driver.stop();
  }
  reset();
  fake.power = 'standby';
  const modern = makeDriver(paired());
  try {
    const state = nextState(modern, () => true);
    modern.start();
    assert.deepEqual(await state, { online: true, power: 'standby', volume: null, muted: null, app: null, appTitle: null });
  } finally {
    await modern.stop();
  }
});

test('volume and mute are real, over the UPnP renderer', async () => {
  reset();
  mode = 'allow';
  received.length = 0;
  soapCalls.length = 0;
  const driver = makeDriver(paired());
  try {
    assert.equal(driver.capabilities.volumeLevel, false, 'unknown until the renderer answers');
    const first = nextState(driver, (s) => s.volume != null);
    driver.start();
    assert.equal((await first).volume, 19);
    assert.equal(driver.capabilities.volumeLevel, true);
    await driver.setVolume(25);
    assert.equal(fake.volume, 25);
    assert.equal(driver.state.volume, 25);
    await driver.key('mute');
    assert.equal(fake.muted, true, 'SetMute, not a blind toggle');
    assert.ok(!received.some((m) => m.params?.DataOfCmd === 'KEY_MUTE'));
    assert.ok(soapCalls.includes('SetMute') && soapCalls.includes('SetVolume'));
  } finally {
    await driver.stop();
  }
});

test('an unreachable TV is offline/off and clears what was playing', async () => {
  const driver = makeDriver(paired(), [], { fetchInfo: async () => { throw new Error('EHOSTDOWN'); } });
  try {
    const state = nextState(driver, () => true);
    driver.start();
    assert.deepEqual(await state, { online: false, power: 'off', volume: null, muted: null, app: null, appTitle: null });
  } finally {
    await driver.stop();
  }
});

test('older sets that give no token still count as connected', async () => {
  mode = 'notoken';
  const tv = makeTv();
  const saved = [];
  const driver = makeDriver(tv, saved);
  try {
    await driver.pair();
    assert.deepEqual(saved, [{ legacy: true }]);
  } finally {
    await driver.stop();
  }
});

test('2016-17 sets (no TokenAuthSupport) are reached on ws :8001', async () => {
  const driver = new SamsungDriver(makeTv(), { rest: base, dmr: base, fetchInfo: async () => ({ device: { TokenAuthSupport: 'false' } }) });
  const modern = new SamsungDriver(makeTv(), { rest: base, dmr: base, fetchInfo: async () => ({ device: { TokenAuthSupport: 'true' } }) });
  try {
    await driver.key('ok').catch(() => {});
    assert.equal(driver.port, 8001);
    assert.equal(driver.secure, false);
    await modern.key('ok').catch(() => {});
    assert.equal(modern.port, 8002);
  } finally {
    await driver.stop();
    await modern.stop();
  }
});

test('a declined prompt surfaces as a 403', async () => {
  mode = 'deny';
  const driver = makeDriver(makeTv());
  try {
    await assert.rejects(driver.pair(), (err) => err.status === 403);
  } finally {
    await driver.stop();
    mode = 'allow';
  }
});
