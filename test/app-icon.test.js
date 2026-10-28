import assert from 'node:assert/strict';
import test from 'node:test';
import { appIcon, artwork, pickApp } from '../src/worker/app-icon.js';

const R = (trackName, n = 0) => ({ trackName, artworkUrl512: `https://is1-ssl.mzstatic.com/image/thumb/x/${n}/512x512bb.jpg` });
const MAX = [R('HBO Max: Stream Movies & TV', 1), R('Max Fashion - ماكس فاشون', 2)];

test('catalog names match loosely (Max is HBO Max); TV-listed names must match exactly', () => {
  assert.equal(pickApp(MAX, 'Max').trackName, 'HBO Max: Stream Movies & TV');
  assert.equal(pickApp([R('Instagram'), R('Netflix')], 'Netflix').trackName, 'Netflix');
  assert.equal(pickApp(MAX, 'Max', true), null, 'strict: "HBO Max" is not "Max"');
  assert.equal(pickApp([R('LG Channels: Free TV')], 'LG Channels', true).trackName, 'LG Channels: Free TV');
  assert.equal(pickApp([R('Hulu: Stream TV shows & movies')], 'Sling TV'), null);
  assert.equal(artwork(MAX[0]), 'https://is1-ssl.mzstatic.com/image/thumb/x/1/256x256bb.png');
});

test('the endpoint asks the App Store once, then answers from its cache; misses are 404', async () => {
  const rows = new Map();
  const DB = { prepare: (sql) => ({ bind: (...a) => ({ first: async () => (sql.startsWith('SELECT') ? rows.get(a[0]) ?? null : null), run: async () => (sql.startsWith('INSERT') && rows.set(a[0], { url: a[1], at: a[2] }), {}) }) }) };
  let asked = 0;
  const fetchFn = async () => (asked++, { ok: true, json: async () => ({ results: MAX }) });
  const u = (q) => new URL(`https://x/hearth/api/app-icon?${q}`);
  const a = await appIcon(u('name=Max'), { DB }, { fetchFn });
  assert.equal(a.status, 302);
  assert.match(a.headers.get('location'), /256x256bb\.png$/);
  await appIcon(u('name=Max'), { DB }, { fetchFn });
  assert.equal(asked, 1);
  assert.equal((await appIcon(u('name=Max&strict=1'), { DB }, { fetchFn })).status, 404);
  assert.equal((await appIcon(u('name=x'), { DB }, { fetchFn })).status, 400);
});
