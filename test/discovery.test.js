import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { lgFromDescriptions, parseDescription, parseSsdp, samsungFromInfo, tvId } from '../src/discovery.js';
import { keyCode, KEYS } from '../src/keys.js';
import { magicPacket } from '../src/wol.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parseSsdp reads ST, LOCATION and SERVER from a webOS answer', () => {
  const answer = [
    'HTTP/1.1 200 OK',
    'CACHE-CONTROL: max-age=1800',
    'LOCATION: http://192.168.1.45:1407/',
    'SERVER: WebOS/4.1.0 UPnP/1.0',
    'ST: urn:lge-com:service:webos-second-screen:1',
    '',
    '',
  ].join('\r\n');
  assert.deepEqual(parseSsdp(answer), {
    st: 'urn:lge-com:service:webos-second-screen:1',
    location: 'http://192.168.1.45:1407/',
    server: 'WebOS/4.1.0 UPnP/1.0',
  });
});

test('LG: the tv:1 description wins over the generic one', () => {
  const descs = [fixture('lg-generic-description.xml'), fixture('lg-tv-description.xml')].map(parseDescription);
  const tv = lgFromDescriptions('192.168.1.45', descs);
  assert.equal(tv.brand, 'lg');
  assert.equal(tv.name, 'Den TV');
  assert.equal(tv.model, '55UP7000PUA');
  assert.deepEqual(tv.macs, ['aa:bb:cc:00:00:01', 'aa:bb:cc:00:00:02']);
  assert.equal(tv.id, 'lg-aabbcc000001');
});

test('LG: generic description alone still yields the model number', () => {
  const tv = lgFromDescriptions('192.168.1.45', [parseDescription(fixture('lg-generic-description.xml'))]);
  assert.equal(tv.model, '55UP7000PUA');
  assert.deepEqual(tv.macs, []);
  assert.equal(tv.id, 'lg-192168145');
});

test('LG: junk model fields from the other UPnP services are skipped', () => {
  const junk = (modelName, modelNumber) =>
    parseDescription(`<root><device><manufacturer>LG Electronics</manufacturer><friendlyName>Den TV</friendlyName><modelName>${modelName}</modelName><modelNumber>${modelNumber}</modelNumber></device></root>`);
  const descs = [junk('LG TV', '1.0'), junk('LG smart TV', '6.5.3'), junk('55UP7000PUA', 'WEBOS')];
  assert.equal(lgFromDescriptions('192.168.1.45', descs).model, '55UP7000PUA');
  assert.equal(lgFromDescriptions('192.168.1.45', descs.slice(0, 2)).model, '');
});

test('LG: non-LG descriptions are ignored', () => {
  const denon = parseDescription('<root><device><manufacturer>Denon</manufacturer><friendlyName>Den</friendlyName></device></root>');
  assert.equal(lgFromDescriptions('192.168.1.24', [denon]), null);
});

test('Samsung: REST info becomes a TV, "[TV]" prefix stripped', () => {
  const tv = samsungFromInfo('192.168.1.50', {
    name: '[TV] Samsung 7 Series (55)',
    type: 'Samsung SmartTV',
    device: { type: 'Samsung SmartTV', name: '[TV] Samsung 7 Series (55)', modelName: 'UN55RU7100', wifiMac: 'AA:BB:CC:DD:EE:FF', PowerState: 'on' },
  });
  assert.deepEqual(tv, {
    id: 'samsung-aabbccddeeff',
    brand: 'samsung',
    name: 'Samsung 7 Series (55)',
    model: 'UN55RU7100',
    ip: '192.168.1.50',
    macs: ['aa:bb:cc:dd:ee:ff'],
  });
});

test('Samsung: something else answering on :8001 is not a TV', () => {
  assert.equal(samsungFromInfo('192.168.1.9', { device: { type: 'Printer', name: 'Office' } }), null);
  assert.equal(samsungFromInfo('192.168.1.9', {}), null);
});

test('tvId is stable and filesystem/URL safe', () => {
  assert.equal(tvId('lg', ['AA:BB:CC:00:00:01'], '1.2.3.4'), 'lg-aabbcc000001');
  assert.equal(tvId('samsung', [], '10.0.0.7'), 'samsung-10007');
});

test('every key has an LG or Samsung code', () => {
  for (const [name, codes] of Object.entries(KEYS)) assert.ok(codes.lg || codes.samsung, name);
  assert.equal(keyCode('lg', 'volup'), 'VOLUMEUP');
  assert.equal(keyCode('samsung', 'back'), 'KEY_RETURN');
  assert.equal(keyCode('lg', 'source'), null);
  assert.equal(keyCode('lg', 'nope'), null);
});

test('Wake-on-LAN magic packet is 6×FF + 16×MAC', () => {
  const pkt = magicPacket('aa:bb:cc:00:00:01');
  assert.equal(pkt.length, 102);
  assert.ok(pkt.subarray(0, 6).every((b) => b === 0xff));
  assert.equal(pkt.subarray(6, 12).toString('hex'), 'aabbcc000001');
  assert.equal(pkt.subarray(96).toString('hex'), 'aabbcc000001');
  assert.throws(() => magicPacket('nope'));
});

test('Google TVs: the TCL is kept, Nest Hubs are not, model comes from AirPlay', async () => {
  const { googleTvsFrom } = await import('../src/discovery.js');
  const e = (service, name, ip, txt) => ({ service: `${service}._tcp.local`, name, ip, port: 1, txt });
  const tvs = googleTvsFrom([
    e('_googlecast', 'Smart-TV-1', '10.0.0.48', { fn: 'Upstairs TV', md: 'Smart TV' }),
    e('_androidtvremote2', 'Upstairs TV', '10.0.0.48', {}),
    e('_airplay', 'Upstairs TV', '10.0.0.48', { manufacturer: 'TCL', model: '65A300W' }),
    e('_googlecast', 'Google-Nest-Hub-Max-1', '10.0.0.36', { fn: 'Study Cam', md: 'Google Nest Hub Max' }),
    e('_googlecast', 'Google-Nest-Hub-2', '10.0.0.44', { fn: 'Bedroom Display', md: 'Google Nest Hub' }),
  ]);
  assert.deepEqual(tvs, [{ brand: 'androidtv', name: 'Upstairs TV', model: 'TCL 65A300W', ip: '10.0.0.48', macs: [] }]);
});

test('Wake-on-LAN targets the real subnet broadcast (eero /22, home /24)', async () => {
  const { broadcastFor } = await import('../src/wol.js');
  const eero = { en0: [{ family: 'IPv4', internal: false, address: '192.168.4.29', netmask: '255.255.252.0' }] };
  assert.equal(broadcastFor('192.168.4.45', eero), '192.168.7.255');
  assert.equal(broadcastFor('192.168.6.10', eero), '192.168.7.255');
  const home = { en0: [{ family: 'IPv4', internal: false, address: '10.0.0.20', netmask: '255.255.255.0' }] };
  assert.equal(broadcastFor('10.0.0.77', home), '10.0.0.255');
  assert.equal(broadcastFor('172.16.0.5', home), null, 'not on any local network');
});
