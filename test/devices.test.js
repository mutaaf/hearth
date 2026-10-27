import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceGuide } from '../src/devices.js';
import { modelYear } from '../src/health.js';

const BRANDS = ['samsung', 'lg', 'roku', 'androidtv', 'appletv'];
const MUST_COVER = ['refused', 'no-prompt', 'not-found', 'wont-wake'];
const WHENS = new Set([...MUST_COVER, 'drops', 'auto-off']);
const HOWS = new Set(['none', 'allow', 'pin', 'code', 'allow-or-pin']);

// Every string in the guide, wherever it sits, must say something.
function strings(x, out = []) {
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => strings(v, out));
  else if (x && typeof x === 'object') Object.values(x).forEach((v) => strings(v, out));
  return out;
}

function checkShape(g, label) {
  assert.ok(BRANDS.includes(g.brand), label);
  assert.equal(typeof g.known, 'boolean', label);
  assert.ok(g.family, label);
  assert.ok(g.year === null || Number.isInteger(g.year), label);
  assert.ok(g.os === null || typeof g.os === 'string', label);
  assert.ok(HOWS.has(g.connect.how), `${label}: how ${g.connect.how}`);
  assert.ok(g.connect.summary.length > 10, label);
  assert.ok(Array.isArray(g.connect.before), label);
  assert.ok(g.connect.onTv === null || typeof g.connect.onTv === 'string', label);
  assert.ok(g.keepReachable.length >= 1, `${label}: keepReachable`);
  for (const k of g.keepReachable) assert.ok(k.title && k.path, label);
  const whens = g.troubleshoot.map((t) => t.when);
  for (const w of MUST_COVER) assert.ok(whens.includes(w), `${label}: troubleshoot ${w}`);
  for (const t of g.troubleshoot) {
    assert.ok(WHENS.has(t.when), `${label}: when ${t.when}`);
    assert.ok(t.fix.length > 10, label);
  }
  assert.equal(new Set(whens).size, whens.length, `${label}: one fix per situation`);
  assert.ok(Array.isArray(g.quirks), label);
  // `model` echoes the input, which may be empty; everything else must say something.
  for (const s of strings({ ...g, model: null })) assert.ok(s.trim().length > 0, `${label}: empty string`);
  // Menu paths use the arrow, never ">" or "=>".
  for (const s of strings([g.connect.before, g.keepReachable, g.troubleshoot])) assert.ok(!/=>|\s>\s/.test(s), `${label}: ${s}`);
}

test('Samsung 2016 (UN55KU6290): connects with nothing to press', () => {
  const g = deviceGuide({ brand: 'samsung', model: ' UN55KU6290 ' });
  checkShape(g, 'KU6290');
  assert.equal(g.model, 'UN55KU6290');
  assert.equal(g.known, true);
  assert.equal(g.year, 2016);
  assert.equal(g.year, modelYear('samsung', g.model).year, 'agrees with the report card');
  assert.match(g.family, /Samsung 2016 .*K series.*Tizen/);
  assert.equal(g.connect.how, 'none');
  assert.equal(g.connect.onTv, null);
  assert.deepEqual(g.connect.before, []);
  assert.ok(g.quirks.some((q) => /power-state/.test(q)));
  assert.ok(g.keepReachable.some((k) => /Settings → General → Network → Expert Settings → Power On with Mobile/.test(k.path)));
  assert.match(g.troubleshoot.find((t) => t.when === 'auto-off').fix, /Settings → System → Eco Solution/);
  // The internal REST model name decodes too.
  assert.equal(deviceGuide({ brand: 'samsung', model: '16_JAZZM_UHD' }).connect.how, 'none');
});

test('Samsung 2020 (UN43TU7000): asks Allow; 2018-21 menus live under General', () => {
  const g = deviceGuide({ brand: 'samsung', model: 'UN43TU7000' });
  checkShape(g, 'TU7000');
  assert.equal(g.year, 2020);
  assert.equal(g.year, modelYear('samsung', g.model).year);
  assert.equal(g.connect.how, 'allow');
  assert.match(g.connect.onTv, /Allow/);
  assert.match(g.troubleshoot.find((t) => t.when === 'refused').fix, /Settings → General → External Device Manager → Device Connection Manager → Device List/);
  assert.match(g.troubleshoot.find((t) => t.when === 'no-prompt').fix, /Access Notification/);
  assert.match(g.troubleshoot.find((t) => t.when === 'auto-off').fix, /Settings → General → Eco Solution/);
});

test('Samsung by year: 2017 stays legacy, 2022+ moves to Connection, pre-2016 is unsupported', () => {
  assert.equal(deviceGuide({ brand: 'samsung', model: 'UN55MU6300' }).connect.how, 'none');
  assert.equal(deviceGuide({ brand: 'samsung', model: 'QN65Q7FAM' }).year, 2017);
  assert.equal(deviceGuide({ brand: 'samsung', model: 'QN65Q7FN' }).year, 2018);
  assert.equal(deviceGuide({ brand: 'samsung', model: 'UN55NU7100' }).connect.how, 'allow');
  const neo = deviceGuide({ brand: 'samsung', model: 'QN65QN90BAFXZA' });
  assert.equal(neo.year, 2022);
  assert.match(neo.family, /Neo QLED/);
  assert.ok(neo.keepReachable.some((k) => k.path.startsWith('Settings → All Settings → Connection → Network → Expert Settings → Power On with Mobile')));
  assert.ok(neo.keepReachable.some((k) => k.title === 'IP Remote'));
  assert.equal(deviceGuide({ brand: 'samsung', model: 'QN65S90C' }).year, 2023);
  assert.equal(deviceGuide({ brand: 'samsung', model: 'UN65DU7200' }).year, 2024);
  assert.equal(deviceGuide({ brand: 'samsung', model: 'UN55U8000F' }).year, 2025);
  const old = deviceGuide({ brand: 'samsung', model: 'UN55F6300' });
  assert.equal(old.year, 2013, 'an F right after the size is 2013, not 2025');
  assert.match(old.connect.summary, /can’t control/);
});

test('LG OLED55C2PUA (2022) and 55UP7000PUA (2021): Allow or a number, webOS menus by year', () => {
  const c2 = deviceGuide({ brand: 'lg', model: 'OLED55C2PUA' });
  checkShape(c2, 'C2');
  assert.equal(c2.year, 2022);
  assert.equal(c2.year, modelYear('lg', c2.model).year);
  assert.equal(c2.family, 'LG 2022 OLED (C2, webOS 22)');
  assert.equal(c2.os, 'webOS 22');
  assert.equal(c2.connect.how, 'allow-or-pin');
  assert.deepEqual(c2.connect.before, [], 'no LG Connect Apps switch on webOS 22');
  assert.ok(c2.keepReachable.some((k) => k.path === 'Settings → All Settings → General → Devices → External Devices → TV On With Mobile → Turn on via Wi-Fi: On'));
  assert.ok(c2.keepReachable.some((k) => k.path === 'Settings → All Settings → General → Devices → TV Management → Quick Start+: On'));

  const up = deviceGuide({ brand: 'lg', model: '55UP7000PUA' });
  checkShape(up, 'UP7000');
  assert.equal(up.year, 2021);
  assert.equal(up.year, modelYear('lg', up.model).year);
  assert.equal(up.os, 'webOS 6.0');
  assert.match(up.family, /LG 2021 .*UP7000/);

  // Older webOS: LG Connect Apps must be on first; Mobile TV On under General.
  const sk = deviceGuide({ brand: 'lg', model: '55SK8000PUA' });
  assert.equal(sk.year, 2018);
  assert.deepEqual(sk.connect.before, ['Settings → All Settings → Network → LG Connect Apps: On']);
  assert.ok(sk.keepReachable.some((k) => /General → Mobile TV On → Turn on via Wi-Fi/.test(k.path)));
  assert.ok(deviceGuide({ brand: 'lg', model: '65NANO80UNA' }).keepReachable.some((k) => /Mobile Connection Management/.test(k.path)));
  assert.equal(deviceGuide({ brand: 'lg', model: '55NANO75UPA' }).year, 2021);
  assert.equal(deviceGuide({ brand: 'lg', model: 'OLED65CXPUA' }).year, 2020);
  assert.ok(deviceGuide({ brand: 'lg', model: 'OLED65C3PUA' }).keepReachable.some((k) => k.path.startsWith('Settings → All Settings → General → External Devices')));
  // OLED…6: 2016 had a one-letter suffix; 2026 sets have a longer one.
  assert.equal(deviceGuide({ brand: 'lg', model: 'OLED55C6P' }).year, 2016);
  assert.equal(deviceGuide({ brand: 'lg', model: 'OLED65C6PUA' }).year, 2026);
});

test('LG firmware fills in the year when the model is missing', () => {
  const g = deviceGuide({ brand: 'lg', model: '', firmware: 'webOS 6.0' });
  assert.equal(g.known, true);
  assert.equal(g.year, 2021);
  assert.equal(deviceGuide({ brand: 'lg', firmware: 'webOSTV 23' }).year, 2023);
});

test('Roku 3820X: no pairing; a 403 points at Control by mobile apps', () => {
  const g = deviceGuide({ brand: 'roku', model: 'Roku Streaming Stick 4K 3820X' });
  checkShape(g, '3820X');
  assert.equal(g.known, true);
  assert.equal(g.family, 'Roku Streaming Stick 4K');
  assert.equal(g.year, 2021);
  assert.equal(g.os, 'Roku OS');
  assert.equal(g.connect.how, 'none');
  assert.match(g.troubleshoot.find((t) => t.when === 'refused').fix, /Settings → System → Advanced system settings → Control by mobile apps/);
  assert.ok(!g.keepReachable.some((k) => k.title === 'Fast TV start'), 'sticks have no Fast TV start');
  assert.ok(g.keepReachable.some((k) => k.title === 'Wall power'));
  assert.equal(deviceGuide({ brand: 'roku', model: '3820X' }).family, 'Roku Streaming Stick 4K');
  assert.equal(deviceGuide({ brand: 'roku', model: '3941X' }).family, 'Roku Express 4K+');
  assert.equal(deviceGuide({ brand: 'roku', model: '4800X' }).family, 'Roku Ultra');
  assert.equal(deviceGuide({ brand: 'roku', model: '3840R' }).year, 2025);
});

test('Roku TVs by other makers get Fast TV start', () => {
  const g = deviceGuide({ brand: 'roku', model: 'TCL•Roku TV 7105X' });
  checkShape(g, 'Roku TV');
  assert.equal(g.known, true);
  assert.equal(g.family, 'TCL Roku TV');
  assert.ok(g.keepReachable.some((k) => k.path.startsWith('Settings → System → Power → Fast TV start')));
  assert.equal(deviceGuide({ brand: 'roku', model: 'Hisense Roku TV' }).family, 'Hisense Roku TV');
});

test('Google TV: Cast needs nothing, the full remote shows a code', () => {
  const cc = deviceGuide({ brand: 'androidtv', model: 'Chromecast' });
  checkShape(cc, 'Chromecast');
  assert.equal(cc.known, true);
  assert.equal(cc.family, 'Chromecast with Google TV (4K)');
  assert.equal(cc.connect.how, 'code');
  assert.match(cc.connect.onTv, /code/);
  const tcl = deviceGuide({ brand: 'googletv', model: 'TCL 65A300W' });
  checkShape(tcl, 'TCL');
  assert.equal(tcl.brand, 'androidtv', 'aliases map to the hub’s brand id');
  assert.equal(tcl.family, 'TCL Google TV');
  assert.match(tcl.troubleshoot.find((t) => t.when === 'wont-wake').fix, /can’t be switched on/);
});

test('Apple TV: two 4-digit codes; names and identifiers both decode', () => {
  const g = deviceGuide({ brand: 'appletv', model: 'AppleTV11,1', firmware: '17.1' });
  checkShape(g, 'ATV');
  assert.equal(g.family, 'Apple TV 4K (2nd gen)');
  assert.equal(g.year, 2021);
  assert.equal(g.os, 'tvOS 17.1');
  assert.equal(g.connect.how, 'pin');
  assert.match(g.connect.onTv, /4-digit/);
  assert.equal(deviceGuide({ brand: 'appletv', model: '4K (2nd gen)' }).year, 2021);
  assert.equal(deviceGuide({ brand: 'appletv', model: 'Apple TV 4K (3rd generation)' }).year, 2022);
  assert.match(deviceGuide({ brand: 'appletv', model: 'AppleTV3,2' }).connect.summary, /can’t control/);
});

test('unknown models fall back to a useful brand guide', () => {
  const expect = { samsung: 'allow', lg: 'allow-or-pin', roku: 'none', androidtv: 'code', appletv: 'pin' };
  for (const brand of BRANDS) {
    const g = deviceGuide({ brand, model: 'ZZ-9000' });
    checkShape(g, `${brand} unknown`);
    assert.equal(g.known, false, brand);
    assert.equal(g.year, null, brand);
    assert.ok(g.os, brand);
    assert.equal(g.connect.how, expect[brand], brand);
    assert.ok(g.troubleshoot.length >= 4, brand);
    // No model at all works too.
    checkShape(deviceGuide({ brand }), `${brand} empty`);
  }
  assert.match(deviceGuide({ brand: 'samsung' }).connect.summary, /2016-17/, 'generic Samsung mentions both kinds');
  assert.throws(() => deviceGuide({ brand: 'vizio' }), TypeError);
});

test('no personal details or other apps’ names in the guides', () => {
  for (const brand of BRANDS) {
    for (const model of ['', 'UN55KU6290', 'OLED55C2PUA', '3820X', 'Chromecast', 'AppleTV11,1']) {
      const text = strings(deviceGuide({ brand, model })).join('\n');
      assert.ok(!/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text), 'no IPs');
      assert.ok(!/([0-9a-f]{2}:){5}[0-9a-f]{2}/i.test(text), 'no MACs');
      assert.ok(!/SmartThings|ThinQ|Google Home|Roku mobile app/i.test(text), 'no other apps');
    }
  }
});
