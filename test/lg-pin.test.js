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
