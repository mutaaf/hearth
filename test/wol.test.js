import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { canBroadcast, configureWake, wake } from '../src/wol.js';

// A socket that records where packets went; broadcasts fail like an iPhone
// without the multicast entitlement when `refuse` is set.
function fakeSocket({ refuse = false } = {}) {
  const sent = [];
  const sock = new EventEmitter();
  Object.assign(sock, {
    bind: (cb) => setImmediate(cb),
    setBroadcast() {},
    send(_p, port, host, cb) {
      sent.push(`${host}:${port}`);
      const blocked = refuse && (host === '255.255.255.255' || host.endsWith('.255'));
      setImmediate(() => cb?.(blocked ? Object.assign(new Error('send EHOSTUNREACH'), { code: 'EHOSTUNREACH' }) : undefined));
    },
    close() {},
  });
  return { sock, sent };
}

async function wakeWith(opts) {
  const { sock, sent } = fakeSocket(opts);
  const m = mock.method(dgram, 'createSocket', () => sock);
  try {
    await wake(['aa:bb:cc:dd:ee:ff'], '192.168.4.45');
  } finally {
    m.mock.restore();
  }
  return sent;
}

test('wake: broadcast and the TV itself, three rounds, ports 9 and 7', async () => {
  const sent = await wakeWith();
  assert.equal(sent.filter((s) => s === '255.255.255.255:9').length, 3);
  assert.equal(sent.filter((s) => s === '192.168.4.45:7').length, 3);
  assert.equal(canBroadcast(), true);
});

test('wake: a refused broadcast is remembered, and the host can say so first', async () => {
  await wakeWith({ refuse: true });
  assert.equal(canBroadcast(), false);
  await wakeWith();
  assert.equal(canBroadcast(), true);
  configureWake({ broadcast: false });
  assert.equal(canBroadcast(), false);
  configureWake({ broadcast: null });
});
