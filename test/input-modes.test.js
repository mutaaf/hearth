import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { Driver } from '../src/drivers/base.js';
import { LgDriver } from '../src/drivers/lg.js';
import { RokuDriver } from '../src/drivers/roku.js';
import { SamsungDriver } from '../src/drivers/samsung.js';
import { Hub } from '../src/hub.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

// Trackpad + keyboard for browsers and search boxes, against pretend TVs.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A pretend webOS TV: registers, hands out a pointer socket, takes IME text.
const lg = { requests: [], pointer: [] };
let lgServer;
let lgUrl;
before(async () => {
  lgServer = new WebSocketServer({ port: 0 });
  await new Promise((r) => lgServer.once('listening', r));
  const port = lgServer.address().port;
  lgUrl = `ws://127.0.0.1:${port}`;
  lgServer.on('connection', (ws, req) => {
    if (req.url === '/pointer') {
      ws.on('message', (raw) => lg.pointer.push(raw.toString()));
      return;
    }
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'register') return ws.send(JSON.stringify({ type: 'registered', id: msg.id, payload: { 'client-key': 'k1' } }));
      if (msg.type !== 'request' && msg.type !== 'subscribe') return;
      lg.requests.push(msg.uri);
      if (msg.uri.endsWith('getPointerInputSocket')) {
        return ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: true, socketPath: `${lgUrl}/pointer` } }));
      }
      if (msg.uri.endsWith('getExternalInputList')) {
        return ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: true, devices: [{ id: 'HDMI_2', appId: 'com.webos.app.hdmi2', label: 'PlayStation 5' }] } }));
      }
      if (msg.uri.endsWith('getForegroundAppInfo')) {
        return ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: true, appId: 'com.webos.app.hdmi2' } }));
      }
      ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: true } }));
    });
  });
});
after(() => lgServer.close());

test('LG: pointer moves/clicks/scrolls go over the input socket; text via the IME', async () => {
  const tv = { id: 'lg-t', brand: 'lg', name: 'Den', ip: '127.0.0.1', macs: ['aa:bb:cc:00:00:01'], credentials: { clientKey: 'k1' } };
  const driver = new LgDriver(tv, { url: lgUrl });
  driver.start();
  for (let i = 0; i < 50 && !driver.state.online; i++) await wait(20);
  assert.equal(driver.state.online, true);
  await driver.pointer({ type: 'move', dx: 12.4, dy: -3 });
  await driver.pointer({ type: 'click' });
  await driver.pointer({ type: 'scroll', dx: 0, dy: 40 });
  await driver.text({ text: 'hello' });
  await driver.text({ backspace: 2 });
  await driver.text({ enter: true });
  await wait(80);
  assert.deepEqual(lg.pointer, ['type:move\ndx:12\ndy:-3\ndown:0\n\n', 'type:click\n\n', 'type:scroll\ndx:0\ndy:40\n\n']);
  for (const uri of ['ssap://com.webos.service.ime/insertText', 'ssap://com.webos.service.ime/deleteCharacters', 'ssap://com.webos.service.ime/sendEnterKey']) {
    assert.ok(lg.requests.includes(uri), uri);
  }
  // It also learned the CEC name of the HDMI device on screen.
  for (let i = 0; i < 25 && driver.state.inputLabel !== 'PlayStation 5'; i++) await wait(20);
  assert.equal(driver.state.inputLabel, 'PlayStation 5');
  await driver.stop();
});

// ── A pretend Samsung on the remote-control channel.
const samsung = [];
let samServer;
let samPort;
before(async () => {
  samServer = new WebSocketServer({ port: 0 });
  await new Promise((r) => samServer.once('listening', r));
  samPort = samServer.address().port;
  samServer.on('connection', (ws) => {
    ws.send(JSON.stringify({ event: 'ms.channel.connect', data: { token: 't' } }));
    ws.on('message', (raw) => samsung.push(JSON.parse(raw.toString())));
  });
});
after(() => samServer.close());

test('Samsung: mouse moves/clicks and base64 text on the remote channel', async () => {
  const tv = { id: 'sam-t', brand: 'samsung', name: 'Den', ip: '127.0.0.1', macs: [], credentials: { token: 't' } };
  const driver = new SamsungDriver(tv, { port: samPort, secure: false, fetchInfo: async () => ({ device: {} }) });
  await driver.pointer({ type: 'move', dx: 5, dy: 7 });
  await driver.pointer({ type: 'click' });
  await driver.text({ text: 'cats' });
  await driver.text({ enter: true });
  await wait(60);
  const p = samsung.map((m) => m.params);
  assert.equal(p[0].Cmd, 'Move');
  assert.deepEqual([p[0].Position.x, p[0].Position.y, p[0].TypeOfRemote], [5, 7, 'ProcessMouseDevice']);
  assert.deepEqual([p[1].Cmd, p[1].TypeOfRemote], ['LeftClick', 'ProcessMouseDevice']);
  assert.deepEqual([Buffer.from(p[2].Cmd, 'base64').toString(), p[2].TypeOfRemote], ['cats', 'SendInputString']);
  assert.equal(p[3].TypeOfRemote, 'SendInputEnd');
  await assert.rejects(driver.text({ backspace: 1 }), (err) => err.status === 501);
  await driver.stop();
});

// ── A pretend Roku: typing is one Lit_ keypress per character.
const roku = [];
let rokuServer;
let rokuBase;
before(async () => {
  rokuServer = http.createServer((req, res) => {
    roku.push(`${req.method} ${req.url}`);
    res.end();
  });
  await new Promise((r) => rokuServer.listen(0, '127.0.0.1', r));
  rokuBase = `http://127.0.0.1:${rokuServer.address().port}`;
});
after(() => rokuServer.close());

test('Roku: types character by character, then Backspace / Enter', async () => {
  const driver = new RokuDriver({ id: 'roku-t', brand: 'roku', name: 'Den', ip: '127.0.0.1', macs: [] }, { base: rokuBase });
  await driver.text({ text: 'a b&' });
  await driver.text({ backspace: 2, enter: true });
  assert.deepEqual(roku, [
    'POST /keypress/Lit_a',
    'POST /keypress/Lit_%20',
    'POST /keypress/Lit_b',
    'POST /keypress/Lit_%26',
    'POST /keypress/Backspace',
    'POST /keypress/Backspace',
    'POST /keypress/Enter',
  ]);
  assert.equal(driver.capabilities.pointer, false);
  assert.equal(driver.capabilities.keyboard, true);
  await assert.rejects(driver.pointer({ type: 'move', dx: 1, dy: 1 }), (err) => err.status === 501);
});

// ── The API: validates input, and every TV view carries its activity.
class FakeLg extends Driver {
  static brand = 'lg';
  calls = [];
  capabilities = { pointer: true, keyboard: true };
  start() {
    this.setState({ online: true, power: 'on', app: 'com.webos.app.hdmi2', inputLabel: 'PlayStation 5' });
  }
  async pair() {
    this.onCredentials({ clientKey: 'x' });
    this.start();
  }
  async pointer(input) {
    this.calls.push(['pointer', input]);
  }
  async text(input) {
    this.calls.push(['text', input]);
  }
}

test('API: /pointer and /text validate, and views carry activity', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-modes-'));
  const hub = await new Hub({ store: new Store(dir), drivers: { lg: FakeLg }, probeFn: async () => null }).init();
  const server = createServer(hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const tv = await (await post('/tvs', { ip: '10.0.0.5', brand: 'lg', name: 'Game Room', macs: [] })).json();
    await post(`/tvs/${tv.id}/pair`, {});
    assert.equal((await post(`/tvs/${tv.id}/pointer`, { type: 'move', dx: 99999, dy: 3 })).status, 200);
    assert.equal((await post(`/tvs/${tv.id}/pointer`, { type: 'fly' })).status, 400);
    assert.equal((await post(`/tvs/${tv.id}/text`, { text: 'hi', enter: true })).status, 200);
    assert.equal((await post(`/tvs/${tv.id}/text`, {})).status, 400);
    const calls = hub.driver(tv.id).calls;
    assert.deepEqual(calls[0], ['pointer', { type: 'move', dx: 2000, dy: 3 }], 'dx is clamped');
    assert.deepEqual(calls[1], ['text', { text: 'hi', backspace: 0, enter: true }]);
    const [view] = await (await fetch(`${base}/tvs`)).json();
    assert.equal(view.activity.kind, 'console');
    assert.equal(view.activity.label, 'PlayStation 5');
    assert.ok(view.activity.since <= Date.now());
  } finally {
    server.close();
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
