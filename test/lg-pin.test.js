import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { LgDriver } from '../src/drivers/lg.js';

// A pretend webOS TV that only knows PIN pairing: it "shows" 4321.
let server;
let url;
before(async () => {
  server = new WebSocketServer({ port: 0 });
  await new Promise((r) => server.once('listening', r));
  url = `ws://127.0.0.1:${server.address().port}`;
  server.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'register') {
        assert.equal(msg.payload.pairingType, 'PIN');
        assert.ok(msg.payload.manifest?.permissions?.length, 'sends the app manifest');
        ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { pairingType: 'PIN', returnValue: true } }));
      } else if (msg.uri === 'ssap://pairing/setPin') {
        const ok = msg.payload.pin === '4321';
        ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: ok } }));
        if (ok) ws.send(JSON.stringify({ type: 'registered', id: 'register', payload: { 'client-key': 'pin-key-1' } }));
      }
    });
  });
});
after(() => server.close());

const makeDriver = (saved) => {
  const tv = { id: 'lg-pin', brand: 'lg', name: 'Den', ip: '127.0.0.1', macs: [] };
  return new LgDriver(tv, { pinUrls: [url], onCredentials: (c) => saved.push(c) });
};

test('PIN pairing: first call asks for the number, second finishes with a key', async () => {
  const saved = [];
  const driver = makeDriver(saved);
  assert.deepEqual(await driver.pair({ mode: 'pin' }), { needsPin: true });
  await driver.pair({ pin: '4321' });
  assert.deepEqual(saved, [{ clientKey: 'pin-key-1' }]);
  await driver.stop();
});

test('PIN pairing: a wrong number is a friendly 400 and you can retry', async () => {
  const saved = [];
  const driver = makeDriver(saved);
  await driver.pair({ mode: 'pin' });
  await assert.rejects(driver.pair({ pin: '1111' }), (err) => err.status === 400);
  await driver.pair({ pin: '4321' });
  assert.equal(saved.length, 1);
  await driver.stop();
});

test('a TV that is already off when Hearth starts shows off, not unknown', async () => {
  // A port nothing listens on: the first connect fails and 'close' never fires.
  const spare = new WebSocketServer({ port: 0 });
  await new Promise((r) => spare.once('listening', r));
  const port = spare.address().port;
  await new Promise((r) => spare.close(r));
  const tv = { id: 'lg-off', brand: 'lg', name: 'Den', ip: '127.0.0.1', macs: [], credentials: { clientKey: 'k' } };
  const driver = new LgDriver(tv, { url: `ws://127.0.0.1:${port}` });
  assert.equal(driver.state.power, 'unknown');
  const off = new Promise((r) => driver.on('state', (s) => s.power === 'off' && r(s)));
  driver.start();
  const s = await off;
  assert.equal(s.online, false);
  assert.equal(s.app, null);
  await driver.stop();
});

test('a TV switched back on is reached by the next command, not the next backoff tick', async () => {
  const spare = new WebSocketServer({ port: 0 });
  await new Promise((r) => spare.once('listening', r));
  const port = spare.address().port;
  await new Promise((r) => spare.close(r));
  const tv = { id: 'lg-back', brand: 'lg', name: 'Den', ip: '127.0.0.1', macs: [], credentials: { clientKey: 'k' } };
  const driver = new LgDriver(tv, { url: `ws://127.0.0.1:${port}` });
  const off = new Promise((r) => driver.on('state', (s) => s.power === 'off' && r()));
  driver.start();
  await off;
  // Two failed tries: the backoff is now ~4 s.
  await new Promise((r) => setTimeout(r, 2600));
  // The TV comes on (someone used its own remote).
  const tvServer = new WebSocketServer({ port });
  await new Promise((r) => tvServer.once('listening', r));
  const got = [];
  tvServer.on('connection', (ws) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'register') ws.send(JSON.stringify({ type: 'registered', id: msg.id, payload: { 'client-key': 'k' } }));
      else if (msg.type === 'request') {
        got.push(msg.uri);
        ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: true } }));
      }
    });
  });
  const t = Date.now();
  await driver.setVolume(20);
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
  assert.ok(got.includes('ssap://audio/setVolume'));
  await driver.stop();
  await new Promise((r) => tvServer.close(r));
});

test('a TV that stays off fails a command quickly as offline', async () => {
  const spare = new WebSocketServer({ port: 0 });
  await new Promise((r) => spare.once('listening', r));
  const port = spare.address().port;
  await new Promise((r) => spare.close(r));
  const tv = { id: 'lg-gone', brand: 'lg', name: 'Den', ip: '127.0.0.1', macs: [], credentials: { clientKey: 'k' } };
  const driver = new LgDriver(tv, { url: `ws://127.0.0.1:${port}` });
  driver.start();
  await assert.rejects(driver.setVolume(20), (err) => err.status === 503);
  await driver.stop();
});
