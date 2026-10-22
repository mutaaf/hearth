import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { parseRokuDeviceInfo, rokuFromInfo, RokuDriver } from '../src/drivers/roku.js';

// A pretend Roku: answers ECP on localhost, records what it was sent.
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const DEVICE_INFO = fixture('roku-device-info.xml');
const APPS = fixture('roku-apps.xml');

const received = [];
const fake = { power: 'PowerOn', isTv: false, active: '<active-app><app>Roku</app></active-app>', forbid: false, player: '<player error="false" state="none"/>' };
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url, at: Date.now() });
    if (fake.forbid) {
      res.writeHead(403);
      return res.end();
    }
    if (req.url === '/query/device-info') {
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end(
        DEVICE_INFO.replace('PowerOn', fake.power).replace('<is-tv>false', `<is-tv>${fake.isTv}`),
      );
    }
    if (req.url === '/query/apps') return res.end(APPS);
    if (req.url === '/query/active-app') return res.end(fake.active);
    if (req.url === '/query/media-player') return res.end(fake.player);
    if (req.method === 'POST') return res.end();
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const makeTv = () => ({ id: 'roku-test', brand: 'roku', name: 'Den', ip: '127.0.0.1', macs: [] });
const reset = () => {
  received.length = 0;
  Object.assign(fake, { power: 'PowerOn', isTv: false, active: '<active-app><app>Roku</app></active-app>', forbid: false, player: '<player error="false" state="none"/>' });
};

test('parseRokuDeviceInfo reads name, model, kind and MACs', () => {
  const info = parseRokuDeviceInfo(DEVICE_INFO);
  assert.deepEqual(info, {
    name: 'Den Roku & Co',
    model: 'Roku Streaming Stick 4K 3820X',
    isTv: false,
    macs: ['aa:bb:cc:00:00:10'],
    power: 'on',
  });
  assert.deepEqual(rokuFromInfo('192.168.1.60', info), {
    id: 'roku-aabbcc000010', brand: 'roku', name: 'Den Roku & Co', model: 'Roku Streaming Stick 4K 3820X', ip: '192.168.1.60', macs: ['aa:bb:cc:00:00:10'],
  });
});

test('keys are ECP keypresses', async () => {
  reset();
  const driver = new RokuDriver(makeTv(), { base });
  await driver.key('ok');
  await driver.key('volup');
  assert.deepEqual(received.map((r) => `${r.method} ${r.url}`), ['POST /keypress/Select', 'POST /keypress/VolumeUp']);
  await assert.rejects(driver.key('nope'), (err) => err.status === 501);
});

test('a held key is keydown, a pause, then keyup', async () => {
  reset();
  const driver = new RokuDriver(makeTv(), { base });
  await driver.key('right', { hold: 120 });
  assert.deepEqual(received.map((r) => r.url), ['/keydown/Right', '/keyup/Right']);
  assert.ok(received[1].at - received[0].at >= 100);
});

test('apps skip menu entries and point icons at the Roku', async () => {
  reset();
  const driver = new RokuDriver(makeTv(), { base });
  const apps = await driver.apps();
  assert.deepEqual(apps.map((a) => a.title), ['Netflix', 'YouTube', 'HDMI 1']);
  assert.equal(apps[0].icon, `${base}/query/icon/12`);
  await driver.launch('12');
  assert.equal(received.at(-1).url, '/launch/12');
});

test('pairing just checks reach and marks it connected', async () => {
  reset();
  const tv = makeTv();
  const saved = [];
  const driver = new RokuDriver(tv, { base, onCredentials: (c) => saved.push(c) });
  await driver.pair();
  assert.deepEqual(saved, [{ ecp: true }]);
  assert.ok(!received.some((r) => r.method === 'POST'), 'pairing sends no keys');
  await driver.stop();
});

test('"Control by mobile apps" off surfaces a 403 with the fix', async () => {
  reset();
  fake.forbid = true;
  const driver = new RokuDriver(makeTv(), { base });
  await assert.rejects(driver.pair(), (err) => err.status === 403 && /Control by mobile apps/.test(err.message));
  await assert.rejects(driver.key('ok'), (err) => err.status === 403);
});

test('an unreachable Roku is offline (503)', async () => {
  const dead = http.createServer();
  await new Promise((r) => dead.listen(0, '127.0.0.1', r));
  const port = dead.address().port;
  await new Promise((r) => dead.close(r));
  const driver = new RokuDriver(makeTv(), { base: `http://127.0.0.1:${port}` });
  await assert.rejects(driver.pair(), (err) => err.status === 503);
});

test('polling reports the app on screen; standby and the home screen show nothing playing', async () => {
  reset();
  fake.active = '<active-app><app id="12" type="appl" version="5.0.98">Netflix</app></active-app>';
  const driver = new RokuDriver(makeTv(), { base });
  try {
    const state = new Promise((resolve) => driver.on('state', (s) => s.online && resolve(s)));
    driver.start();
    const { media, ...rest } = await state;
    assert.deepEqual(rest, { online: true, power: 'on', volume: null, muted: null, app: '12', appTitle: 'Netflix' });
    assert.equal(media.state, 'stopped');
    // Asleep: the Roku still names the last app, but nothing is playing.
    fake.power = 'DisplayOff';
    await driver.refresh();
    assert.deepEqual([driver.state.power, driver.state.app], ['standby', null]);
    // Newer Roku OS calls its home screen "Roku Dynamic Menu".
    fake.power = 'PowerOn';
    fake.active = '<active-app><app id="562859" type="appl">Roku Dynamic Menu</app></active-app>';
    await driver.refresh();
    assert.deepEqual([driver.state.power, driver.state.app, driver.state.appTitle, driver.state.media], ['on', null, null, null]);
  } finally {
    await driver.stop();
  }
});

test('inputs: Roku TVs list HDMI, sticks say not supported', async () => {
  reset();
  const stick = new RokuDriver(makeTv(), { base });
  await assert.rejects(stick.inputs(), (err) => err.status === 501);
  assert.equal(stick.capabilities.inputs, false);
  await assert.rejects(stick.key('source'), (err) => err.status === 501);

  fake.isTv = true;
  const tv = new RokuDriver(makeTv(), { base });
  assert.deepEqual(await tv.inputs(), [{ id: 'tvinput.hdmi1', label: 'HDMI 1', connected: true }]);
  assert.equal(tv.capabilities.inputs, true);
  await tv.setInput('tvinput.hdmi1');
  assert.equal(received.at(-1).url, '/launch/tvinput.hdmi1');
});

test('inside an app, the media player says playing or paused, with position', async () => {
  reset();
  fake.active = '<active-app><app id="12" type="appl" version="5.0">Netflix</app></active-app>';
  fake.player = '<player error="false" state="play"><plugin bandwidth="1 bps" id="12" name="Netflix"/><position>51400 ms</position><duration>2700000 ms</duration><is_live blah="x">false</is_live></player>';
  const driver = new RokuDriver(makeTv(), { base });
  await driver.refresh();
  assert.equal(driver.state.app, '12');
  assert.deepEqual({ ...driver.state.media, at: 0 }, { state: 'playing', position: 51400, duration: 2700000, live: false, at: 0, source: 'roku' });
  // On the home screen nobody asks the player.
  fake.active = '<active-app><app>Roku</app></active-app>';
  received.length = 0;
  await driver.refresh();
  assert.equal(driver.state.media, null);
  assert.ok(!received.some((r) => r.url === '/query/media-player'));
});
