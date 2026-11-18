import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { LgDriver } from '../src/drivers/lg.js';

// The phone app calls reconnect() every time it comes back from the
// background. A connection that still answers must be kept (the TV never
// flickers to "Off"); one that went silent is replaced, and the old socket's
// late events must not touch the new one.
async function fakeTv() {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((r) => server.once('listening', r));
  const tv = { server, connections: 0, silent: false };
  server.on('connection', (ws) => {
    tv.connections++;
    const mine = tv.connections;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'register') return ws.send(JSON.stringify({ type: 'registered', id: msg.id, payload: { 'client-key': 'k' } }));
      // A socket iOS froze: the TV side is gone, nothing comes back.
      if (tv.silent && mine === 1) return;
      ws.send(JSON.stringify({ type: 'response', id: msg.id, payload: { returnValue: true, state: 'Active' } }));
    });
  });
  tv.url = `ws://127.0.0.1:${server.address().port}`;
  tv.close = async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise((r) => server.close(r));
  };
  return tv;
}

function driverFor(tv) {
  const driver = new LgDriver({ id: 'lg-r', brand: 'lg', name: 'Den', ip: '127.0.0.1', macs: [], credentials: { clientKey: 'k' } }, { url: tv.url });
  const powers = [];
  driver.on('state', (s) => powers.push(s.online));
  const connected = new Promise((r) => driver.once('connect', r));
  driver.start();
  return { driver, powers, connected };
}

test('reconnect keeps a connection that still answers: no new socket, never shown off', async () => {
  const tv = await fakeTv();
  const { driver, powers, connected } = driverFor(tv);
  try {
    await connected;
    powers.length = 0;
    await driver.reconnect();
    assert.equal(tv.connections, 1, 'same socket');
    assert.ok(!powers.includes(false), 'never flickered offline');
    assert.equal(driver.state.online, true);
  } finally {
    await driver.stop();
    await tv.close();
  }
});

test('reconnect replaces a silent connection, waits for the new one, and the old one can’t mark it off', async () => {
  const tv = await fakeTv();
  const { driver, connected } = driverFor(tv);
  const crashes = [];
  const onRejection = (err) => crashes.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    await connected;
    tv.silent = true;
    await driver.reconnect({ probeMs: 200, waitMs: 3000 });
    assert.equal(tv.connections, 2, 'a fresh socket');
    assert.equal(driver.state.online, true, 'connected when reconnect returns');
    // The old socket's close lands late: it must not flip the new connection.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(driver.state.online, true);
    assert.deepEqual(crashes, []);
  } finally {
    process.off('unhandledRejection', onRejection);
    await driver.stop();
    await tv.close();
  }
});
