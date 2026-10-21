import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Driver } from '../src/drivers/base.js';
import { Hub } from '../src/hub.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

// The whole HTTP API against a fake brand, so it runs anywhere with no TV.
const sent = [];
class FakeDriver extends Driver {
  static brand = 'lg';
  capabilities = { volumeLevel: true, inputs: true, toast: true, appIcons: false };
  start() { this.setState({ online: true, power: 'on', volume: 12 }); }
  async pair() { this.onCredentials({ clientKey: 'secret-key' }); this.start(); }
  async key(name) { sent.push(['key', name]); }
  async powerOff() { sent.push(['off', this.tv.id]); }
  async apps() { return [{ id: 'netflix', title: 'Netflix', icon: null }]; }
  async launch(id) { sent.push(['launch', id]); }
}

let dir;
let base;
let server;
let hub;

before(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-test-'));
  hub = await new Hub({
    store: new Store(dir),
    drivers: { lg: FakeDriver, samsung: FakeDriver },
    discoverFn: async () => [{ id: 'lg-aabbcc000001', brand: 'lg', name: 'Den TV', model: 'X', ip: '10.0.0.5', macs: ['aa:bb:cc:00:00:01'] }],
    probeFn: async (ip) => (ip === '10.0.0.9' ? { brand: 'samsung', name: 'Kitchen', model: 'Q', ip, macs: [] } : null),
  }).init();
  server = createServer(hub);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await hub.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (method, p, body) => {
  const init = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + p, init);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('health and the app shell are served', async () => {
  assert.equal((await call('GET', '/api/health')).body.name, 'hearth');
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /<title>Hearth<\/title>/);
  // unknown client routes fall back to the shell; traversal does not escape web/
  assert.equal((await fetch(base + '/tv/anything')).status, 200);
  assert.equal((await fetch(base + '/..%2Fpackage.json')).status, 404);
});

test('scan → add → pair → control, and keys never leak', async () => {
  const found = (await call('POST', '/api/scan', {})).body;
  assert.equal(found[0].added, false);

  const added = await call('POST', '/api/tvs', found[0]);
  assert.equal(added.status, 200);
  assert.equal(added.body.id, 'lg-aabbcc000001');
  assert.equal(added.body.paired, false);
  assert.equal((await call('POST', '/api/scan', {})).body[0].added, true);

  const paired = await call('POST', '/api/tvs/lg-aabbcc000001/pair', {});
  assert.equal(paired.body.paired, true);
  assert.equal(paired.body.state.volume, 12);

  // The key is persisted on disk but never sent to the browser.
  const onDisk = JSON.parse(readFileSync(path.join(dir, 'tvs.json'), 'utf8'));
  assert.equal(onDisk.tvs[0].credentials.clientKey, 'secret-key');
  assert.doesNotMatch(JSON.stringify((await call('GET', '/api/tvs')).body), /secret-key/);

  assert.equal((await call('POST', '/api/tvs/lg-aabbcc000001/key', { key: 'volup' })).status, 200);
  assert.equal((await call('POST', '/api/tvs/lg-aabbcc000001/launch', { id: 'netflix' })).status, 200);
  assert.deepEqual(sent.slice(-2), [['key', 'volup'], ['launch', 'netflix']]);
  assert.equal((await call('GET', '/api/tvs/lg-aabbcc000001/apps')).body[0].title, 'Netflix');
  // Unsupported features say so instead of failing silently.
  assert.equal((await call('POST', '/api/tvs/lg-aabbcc000001/toast', { message: 'hi' })).status, 501);
});

test('add by IP probes the address, and rejects junk', async () => {
  const added = await call('POST', '/api/tvs', { ip: '10.0.0.9' });
  assert.equal(added.body.brand, 'samsung');
  assert.equal(added.body.name, 'Kitchen');
  assert.equal((await call('POST', '/api/tvs', { ip: '10.0.0.10' })).status, 404);
  assert.equal((await call('POST', '/api/tvs', { ip: 'not-an-ip' })).status, 400);
  assert.equal((await call('POST', '/api/tvs', { ip: '10.0.0.11', brand: 'roku' })).status, 400);
});

test('rename, all-off and forget', async () => {
  const renamed = await call('PATCH', '/api/tvs/lg-aabbcc000001', { name: '  Den  ', room: 'Downstairs' });
  assert.equal(renamed.body.name, 'Den');
  assert.equal(renamed.body.room, 'Downstairs');

  const off = await call('POST', '/api/all/power', { on: false });
  assert.equal(off.body.ok, true);
  assert.deepEqual(off.body.results.map((r) => r.id), ['lg-aabbcc000001']); // only paired TVs

  assert.equal((await call('DELETE', '/api/tvs/lg-aabbcc000001')).status, 200);
  assert.equal((await call('GET', '/api/tvs/lg-aabbcc000001/apps')).status, 404);
});

test('commands require a JSON content type (blocks drive-by cross-site POSTs)', async () => {
  const res = await fetch(base + '/api/all/power', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"on":false}' });
  assert.equal(res.status, 415);
});

test('icon proxy only fetches from the TV itself', async () => {
  const tv = (await call('GET', '/api/tvs')).body[0];
  const res = await fetch(`${base}/api/tvs/${tv.id}/icon?u=${encodeURIComponent('http://example.com/x.png')}`);
  assert.equal(res.status, 400);
});
