import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { neighbours, wake } from '../src/wol.js';

const iface = (address) => ({ en0: [{ address, netmask: '255.255.255.0', family: 'IPv4', internal: false }] });

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

test('neighbours: the /22 around this machine, nearest first, without itself', () => {
  const list = neighbours(iface('192.168.5.20'));
  assert.equal(list.length, 1021);
  assert.deepEqual(list.slice(0, 2).sort(), ['192.168.5.19', '192.168.5.21']);
  assert.ok(!list.includes('192.168.5.20'));
  assert.ok(list.includes('192.168.4.1') && list.includes('192.168.7.254'));
  assert.ok(!list.includes('192.168.4.0') && !list.includes('192.168.7.255'));
  assert.deepEqual(neighbours({}), []);
});

test('wake: broadcast refused → a unicast magic packet to every neighbour, twice', async () => {
  const { sock, sent } = fakeSocket({ refuse: true });
  const m = mock.method(dgram, 'createSocket', () => sock);
  try {
    await wake(['aa:bb:cc:dd:ee:ff'], '192.168.4.45', { hosts: () => ['192.168.4.46', '192.168.4.45', '192.168.6.9'], gapMs: 1 });
  } finally {
    m.mock.restore();
  }
  assert.equal(sent.filter((s) => s === '192.168.6.9:9').length, 2);
  assert.equal(sent.filter((s) => s === '192.168.4.46:9').length, 2);
  assert.equal(sent.filter((s) => s === '192.168.4.45:9').length, 3); // its own rounds only
});

test('wake: broadcast works → no knocking on the neighbours', async () => {
  const { sock, sent } = fakeSocket();
  const m = mock.method(dgram, 'createSocket', () => sock);
  try {
    await wake(['aa:bb:cc:dd:ee:ff'], '192.168.4.45', { hosts: () => ['192.168.6.9'], gapMs: 1 });
  } finally {
    m.mock.restore();
  }
  assert.ok(!sent.includes('192.168.6.9:9'));
});

test('wake: spray on (the phone) knocks even when nothing complains', async () => {
  const { sock, sent } = fakeSocket();
  const m = mock.method(dgram, 'createSocket', () => sock);
  try {
    await wake(['aa:bb:cc:dd:ee:ff'], '192.168.4.45', { spray: true, hosts: () => ['192.168.6.9'], gapMs: 1 });
  } finally {
    m.mock.restore();
  }
  assert.equal(sent.filter((s) => s === '192.168.6.9:9').length, 2);
});
