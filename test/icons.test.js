import assert from 'node:assert/strict';
import test from 'node:test';
import { iconData } from '../src/icons.js';

const hub = {
  get: () => ({ id: 'roku-1', ip: '10.0.0.7' }),
  forbiddenIp: () => false,
  cachedApps: () => [{ id: '12', title: 'Netflix', icon: 'http://10.0.0.7:8060/query/icon/12' }],
  apps: async () => [],
};
const png = (bytes = 8) => async () => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } });

test('icon data: only an icon the TV listed, only from the TV, only images', async () => {
  const ok = await iconData(hub, 'roku-1', 'http://10.0.0.7:8060/query/icon/12', { fetchFn: png() });
  assert.equal(ok.type, 'image/png');
  assert.equal(Buffer.from(ok.data, 'base64').length, 8);
  await assert.rejects(iconData(hub, 'roku-1', 'http://10.0.0.7:8060/query/device-info', { fetchFn: png() }), /listed/);
  await assert.rejects(iconData(hub, 'roku-1', 'http://10.0.0.99:8060/query/icon/12', { fetchFn: png() }), /from the TV/);
  await assert.rejects(
    iconData(hub, 'roku-1', 'http://10.0.0.7:8060/query/icon/12', { fetchFn: async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }) }),
    /unavailable/,
  );
  await assert.rejects(iconData(hub, 'roku-1', 'http://10.0.0.7:8060/query/icon/12', { fetchFn: png(500_000) }), /too big/);
});
