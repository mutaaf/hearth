import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { atvMode, getBridge, setBridge } from '../src/atv-bridge.js';
import { hkdf, open, seal, SessionCipher } from '../src/atv/hap.js';
import { FRAME, FrameReader, header, MSG } from '../src/atv/link.js';
import * as opack from '../src/atv/opack.js';
import * as srp from '../src/atv/srp.js';
import { decode as readTlv, encode as tlv, TLV } from '../src/atv/tlv8.js';
import { JsAtvTransport, setJsTransport } from '../src/atv/transport.js';
import * as airplay from '../src/atv/airplay.js';
import * as bplist from '../src/atv/bplist.js';
import { HapFraming, HttpLink } from '../src/atv/http.js';
import * as mrp from '../src/atv/mrp.js';
import { AppleTvDriver } from '../src/drivers/appletv.js';
import * as proto from '../src/proto.js';
import { FakeAirPlay } from './fixtures/fake-airplay.js';
import { Hub } from '../src/hub.js';
import { Store } from '../src/store.js';

const hex = (s) => Buffer.from(s.replace(/\s/g, ''), 'hex');
const b = (...bytes) => Buffer.from(bytes);
const ascii = (s) => Buffer.from(s, 'latin1');

// ── OPACK, against pyatv's tests/support/test_opack.py ────
test('opack: packs like pyatv', () => {
  const p = (v) => opack.pack(v);
  assert.deepEqual(p(true), b(0x01));
  assert.deepEqual(p(false), b(0x02));
  assert.deepEqual(p(null), b(0x04));
  assert.deepEqual(p(new opack.Uuid(hex('12345678123456781234567812345678'))), Buffer.concat([b(0x05), hex('12345678123456781234567812345678')]));
  assert.deepEqual(p(0), b(0x08));
  assert.deepEqual(p(0xf), b(0x17));
  assert.deepEqual(p(0x27), b(0x2f));
  assert.deepEqual(p(0x28), b(0x30, 0x28));
  assert.deepEqual(p(0x1ff), b(0x31, 0xff, 0x01));
  assert.deepEqual(p(0x1ffffff), b(0x32, 0xff, 0xff, 0xff, 0x01));
  assert.deepEqual(p(0x1ffffffffffffffn), b(0x33, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01));
  assert.deepEqual(p(opack.float(1)), b(0x36, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f));
  assert.deepEqual(p('a'), b(0x41, 0x61));
  assert.deepEqual(p('abc'), b(0x43, 0x61, 0x62, 0x63));
  assert.deepEqual(p('a'.repeat(0x20)), Buffer.concat([b(0x60), ascii('a'.repeat(0x20))]));
  assert.deepEqual(p('a'.repeat(33)), Buffer.concat([b(0x61, 0x21), ascii('a'.repeat(33))]));
  assert.deepEqual(p('a'.repeat(256)), Buffer.concat([b(0x62, 0x00, 0x01), ascii('a'.repeat(256))]));
  assert.deepEqual(p(b(0xac)), b(0x71, 0xac));
  assert.deepEqual(p(b(0x12, 0x34, 0x56)), b(0x73, 0x12, 0x34, 0x56));
  assert.deepEqual(p(Buffer.alloc(0x20, 0xad)), Buffer.concat([b(0x90), Buffer.alloc(0x20, 0xad)]));
  assert.deepEqual(p(Buffer.alloc(33, 0x61)), Buffer.concat([b(0x91, 0x21), Buffer.alloc(33, 0x61)]));
  assert.deepEqual(p(Buffer.alloc(256, 0x61)), Buffer.concat([b(0x92, 0x00, 0x01), Buffer.alloc(256, 0x61)]));
  assert.deepEqual(p(Buffer.alloc(65536, 0x61)), Buffer.concat([b(0x93, 0x00, 0x00, 0x01, 0x00), Buffer.alloc(65536, 0x61)]));
  assert.deepEqual(p([]), b(0xd0));
  assert.deepEqual(p([1, 'test', false]), hex('d309447465737402'));
  assert.deepEqual(p([[true]]), hex('d1d101'));
  assert.deepEqual(p(Array(15).fill('a')), Buffer.concat([hex('df4161'), Buffer.alloc(14, 0xa0), b(0x03)]));
  assert.deepEqual(p({}), b(0xe0));
  assert.deepEqual(p(new Map([['a', 12], [false, null]])), hex('e2416114 0204'));
  assert.deepEqual(p(new Map([[true, { a: 2 }]])), hex('e101e141610a'));
  const endless = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [String.fromCharCode(97 + 2 * i), String.fromCharCode(98 + 2 * i)]));
  // b"\xef" + b"\x41" + b"\x41".join(bytes([x]) for x in range(97, 127)) + b"\x03"
  assert.deepEqual(p(endless), Buffer.concat([b(0xef), ...Array.from({ length: 30 }, (_, i) => b(0x41, 97 + i)), b(0x03)]));
  // references to repeated values
  assert.deepEqual(p(['a', 'a']), hex('d24161a0'));
  assert.deepEqual(p(['foo', 'bar', 'foo', 'bar']), hex('d443666f6f43626172a0a1'));
  assert.deepEqual(p({ a: 'b', c: { d: 'a' }, d: true }), hex('e3416141624163e14164a0a301'));
});

// pyatv's test_pack_more_ptr / test_unpack_more_ptr, generated: 257 one-char
// byte strings twice → each once, then 0xA0-0xC0 and 0xC1/0xC2 references.
function morePtr() {
  const data = Array.from({ length: 257 }, (_, x) => Buffer.from(String.fromCharCode(x), 'utf8'));
  const parts = [b(0xdf)];
  for (const d of data) parts.push(b(0x70 + d.length), d);
  for (let i = 0; i < 257; i++) parts.push(i < 0x21 ? b(0xa0 + i) : i <= 0xff ? b(0xc1, i) : b(0xc2, i & 0xff, i >> 8));
  parts.push(b(0x03));
  return { data: [...data, ...data], bytes: Buffer.concat(parts) };
}

test('opack: references past 0x20 use 0xC1/0xC2 (pyatv more_ptr)', () => {
  const { data, bytes } = morePtr();
  assert.equal(bytes.subarray(0, 8).toString('hex'), 'df71007101710271');
  assert.ok(bytes.includes(hex('72c4 80a0a1a2')), 'pyatv vector: ...\\x72\\xc4\\x80\\xa0\\xa1\\xa2...');
  assert.ok(bytes.subarray(-6).equals(hex('c1ffc2000103')));
  assert.deepEqual(opack.pack(data), bytes);
  assert.deepEqual(opack.unpack(bytes)[0], data);
});

test('opack: unpacks like pyatv', () => {
  const u = (bytes) => opack.unpack(bytes);
  assert.deepEqual(u(b(0x01)), [true, Buffer.alloc(0)]);
  assert.equal(u(b(0x02))[0], false);
  assert.equal(u(b(0x04))[0], null);
  assert.equal(String(u(hex('0512345678123456781234567812345678'))[0]), '12345678-1234-5678-1234-567812345678');
  assert.equal(u(hex('060100000000000000'))[0], 1); // absolute time, read as a number
  assert.equal(u(b(0x08))[0], 0);
  assert.equal(u(b(0x2f))[0], 0x27);
  assert.equal(u(b(0x30, 0x28))[0], 0x28);
  assert.equal(u(b(0x31, 0xff, 0x01))[0], 0x1ff);
  assert.equal(u(b(0x32, 0xff, 0xff, 0xff, 0x01))[0], 0x1ffffff);
  assert.equal(u(hex('33ffffffffffffff01'))[0], 0x1ffffffffffffffn, 'past 2^53: a BigInt');
  assert.equal(u(hex('350000803f'))[0], 1); // float32
  assert.equal(u(hex('36000000000000f03f'))[0], 1);
  assert.equal(u(hex('4161'))[0], 'a');
  assert.equal(u(Buffer.concat([b(0x62, 0x00, 0x01), ascii('a'.repeat(256))]))[0], 'a'.repeat(256));
  assert.deepEqual(u(hex('73123456'))[0], hex('123456'));
  assert.deepEqual(u(Buffer.concat([b(0x93, 0, 0, 1, 0), Buffer.alloc(65536, 0x61)]))[0], Buffer.alloc(65536, 0x61));
  assert.deepEqual(u(hex('d309447465737402'))[0], [1, 'test', false]);
  assert.deepEqual(u(hex('d1d101'))[0], [[true]]);
  const list1 = Buffer.concat([hex('df4161'), Buffer.alloc(15, 0xa0), b(0x03)]);
  const list2 = Buffer.concat([hex('df4162'), Buffer.alloc(15, 0xa1), b(0x03)]);
  assert.deepEqual(u(list1)[0], Array(16).fill('a'));
  assert.deepEqual(u(Buffer.concat([b(0xd2), list1, list2]))[0], [Array(16).fill('a'), Array(16).fill('b')]);
  assert.deepEqual(u(hex('e2416114 0204'))[0], { a: 12, false: null });
  assert.deepEqual(u(hex('e101e141610a'))[0], { true: { a: 2 } });
  assert.deepEqual(u(hex('d24161a0'))[0], ['a', 'a']);
  assert.deepEqual(u(hex('e3416141624163e14164a0a301'))[0], { a: 'b', c: { d: 'a' }, d: true });
  // pyatv test_unpack_uid: 0xC1-0xC4 + a 1-4 byte little-endian index (1 = the second value)
  for (const v of ['df30013002c10103', 'df30013002c2010003', 'df30013002c301000003', 'df30013002c40100000003']) {
    assert.deepEqual(u(hex(v))[0], [1, 2, 2]);
  }
  assert.throws(() => u(b(0x00)), TypeError);
  assert.throws(() => u(b(0x43, 0x61)), RangeError, 'truncated input is an error, not garbage');
});

test('opack: the golden _systemInfo message round-trips (pyatv test_golden)', () => {
  const msg = {
    _i: '_systemInfo',
    _x: 1254122577,
    _btHP: false,
    _c: {
      _pubID: 'AA:BB:CC:DD:EE:FF',
      _sv: '230.1',
      _bf: 0,
      _siriInfo: { collectorElectionVersion: opack.float(1), deviceCapabilities: { seymourEnabled: 1, voiceTriggerEnabled: 2 }, sharedDataProtoBuf: Buffer.alloc(512, 0x08) },
      _stA: ['com.apple.LiveAudio', 'com.apple.siri.wakeup', 'com.apple.Seymour', 'com.apple.announce', 'com.apple.coreduet.sync', 'com.apple.SeymourSession'],
      _i: '6c62fca18b11',
      _clFl: 128,
      _idsID: '44E14ABC-DDDD-4188-B661-11BAAAF6ECDE',
      _hkUID: [new opack.Uuid(hex('17ed160a81f84488962c6b1a83eb0081'))],
      _dC: '1',
      _sf: 256,
      model: 'iPhone10,6',
      name: 'iPhone',
    },
    _t: 2,
  };
  const [back, rest] = opack.unpack(opack.pack(msg));
  assert.equal(rest.length, 0);
  assert.equal(back._c._siriInfo.collectorElectionVersion, 1);
  assert.equal(String(back._c._hkUID[0]), '17ed160a-81f8-4488-962c-6b1a83eb0081');
  back._c._siriInfo.collectorElectionVersion = msg._c._siriInfo.collectorElectionVersion;
  back._c._hkUID = msg._c._hkUID;
  assert.deepEqual(back, msg);
  assert.ok(opack.pack({ _i: 'x', _c: { _i: 'y' } }).includes(b(0xa0)), 'the repeated key "_i" goes out as a reference');
  assert.throws(() => opack.pack(-1), TypeError);
});

// ── TLV8 and SRP ───────────────────────────────────────────
test('tlv8: fragments values over 255 bytes and joins them back', () => {
  const big = randomBytes(384);
  const bytes = tlv([[TLV.SeqNo, 3], [TLV.PublicKey, big], [TLV.Proof, Buffer.alloc(64, 1)]]);
  assert.deepEqual(bytes.subarray(0, 5), b(0x06, 0x01, 0x03, 0x03, 0xff));
  assert.equal(bytes.length, 3 + (2 + 255) + (2 + 129) + (2 + 64));
  const back = readTlv(bytes);
  assert.deepEqual(back.get(TLV.SeqNo), b(3));
  assert.deepEqual(back.get(TLV.PublicKey), big);
  assert.deepEqual(back.get(TLV.Proof), Buffer.alloc(64, 1));
  assert.throws(() => readTlv(b(0x06, 0x05, 0x01)), RangeError);
});

test('srp: matches srptools (what pyatv uses) byte for byte', () => {
  // Computed once with srptools 1.0.1 (pyatv 0.18.0's) for these inputs.
  const salt = hex('00112233445566778899aabbccddeeff');
  const server = srp.server({ salt, v: srp.verifier(salt, '1234'), b: Buffer.alloc(32, 7) });
  const c = srp.client({ password: '1234', salt, B: server.B, a: Buffer.alloc(32, 3) });
  assert.equal(c.A.subarray(0, 32).toString('hex'), 'ba8925dbc3a760839deb57436b1a32128121a6b483cb672f75f6e8bb1d66e81e');
  assert.equal(c.M1.toString('hex'), '433d6137279134f6b04a2f96e364a5ed6568dcec79d3fad3556f0ab5041437c6bb91c5387046578cb83ed316c010ca24609825eba4b741760f46a53a9361ac4c');
  assert.equal(c.K.toString('hex'), '34079057e2f4bd969677133c20fcee016177f5e4bf9588562192ae8f1fa6d4efdb76806b48fabb3b1340ffeab3e5c39d4ae1d15c8a0d39a8af772bb5e043af84');
  assert.equal(c.M2.toString('hex'), '377d60a42bc7c40872de5bd94d66ca950eaa3060b9706198834777715d47952d4bb122590643a81b25a251a3f9871b09e15f0a3969e55dfa998d6e71b3076a3a');
  const ok = server.finish(c.A, c.M1);
  assert.ok(ok.K.equals(c.K) && ok.M2.equals(c.M2));
  const wrong = srp.client({ password: '9999', salt, B: server.B, a: Buffer.alloc(32, 3) });
  assert.equal(server.finish(wrong.A, wrong.M1), null, 'a wrong PIN gives a proof the server rejects');
});

// ── a pretend Apple TV, Companion server side, on 127.0.0.1 ─
// Real pair-setup (SRP verifier from its PIN, its own Ed25519 identity),
// pair-verify (X25519 + signatures), the encrypted session, and a record of
// every request. Built from the same primitives, server side.
class FakeAppleTv {
  pin = '1234';
  seed = randomBytes(32);
  id = Buffer.from('5D797FD3-3538-427E-A47B-A32FC6CF3A6A');
  clients = new Map(); // paired clientId (hex) → Ed25519 public key
  requests = []; // [name, content]
  frames = []; // frame types seen, for "the probe never pairs"
  names = []; // pairing names from M5
  attention = 3; // awake
  apps = { 'com.netflix.Netflix': 'Netflix', 'com.google.ios.youtube': 'YouTube', 'com.apple.TVWatchList': 'TV' };
  refuse = new Set(['TVRCSessionStart']); // like an older tvOS
  sockets = new Set();

  async listen() {
    this.server = net.createServer((s) => this.#serve(s));
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    return this;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((r) => this.server.close(r));
  }

  get ltpk() {
    return Buffer.from(ed25519.getPublicKey(this.seed));
  }

  sent(name) {
    return this.requests.filter(([n]) => n === name).map(([, c]) => c);
  }

  push(name, content) {
    for (const s of this.sockets) s.session?.cipher && this.#send(s, FRAME.E_OPACK, { _i: name, _t: MSG.Event, _c: content, _x: 1 });
  }

  #send(s, type, msg) {
    let payload = opack.pack(msg);
    const cipher = s.session.cipher;
    const head = header(type, payload.length + (cipher ? 16 : 0));
    if (cipher) payload = cipher.seal(payload, head);
    s.write(Buffer.concat([head, payload]));
  }

  #serve(s) {
    this.sockets.add(s);
    s.session = {};
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => {});
    const reader = new FrameReader();
    s.on('data', (chunk) => {
      for (const f of reader.push(chunk)) {
        this.frames.push(f.type);
        const data = s.session.cipher ? s.session.cipher.open(f.payload, f.header) : f.payload;
        const [msg] = opack.unpack(data);
        if (f.type === FRAME.PS_Start || f.type === FRAME.PS_Next) this.#setup(s, msg);
        else if (f.type === FRAME.PV_Start || f.type === FRAME.PV_Next) this.#verify(s, msg);
        else if (f.type === FRAME.E_OPACK) this.#message(s, msg);
      }
    });
  }

  #setup(s, msg) {
    const t = readTlv(msg._pd);
    const seq = t.get(TLV.SeqNo)[0];
    const reply = (items) => this.#send(s, FRAME.PS_Next, { _pd: tlv(items), _pwTy: 1 });
    if (seq === 1) {
      const salt = randomBytes(16);
      s.session.srp = { salt, ...srp.server({ salt, v: srp.verifier(salt, this.pin), b: randomBytes(32) }) };
      return reply([[TLV.SeqNo, 2], [TLV.Salt, salt], [TLV.PublicKey, s.session.srp.B]]);
    }
    if (seq === 3) {
      const done = s.session.srp.finish(t.get(TLV.PublicKey), t.get(TLV.Proof));
      if (!done) return reply([[TLV.SeqNo, 4], [TLV.Error, 2]]); // kTLVError_Authentication
      s.session.K = done.K;
      return reply([[TLV.SeqNo, 4], [TLV.Proof, done.M2]]);
    }
    if (seq === 5) {
      const K = s.session.K;
      const key = hkdf(K, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
      const inner = readTlv(open(key, 'PS-Msg05', t.get(TLV.EncryptedData)));
      const clientId = inner.get(TLV.Identifier);
      const clientPub = inner.get(TLV.PublicKey);
      const signedByClient = Buffer.concat([hkdf(K, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info'), clientId, clientPub]);
      assert.ok(ed25519.verify(inner.get(TLV.Signature), signedByClient, clientPub), 'M5 signature');
      this.names.push(opack.unpack(inner.get(TLV.Name))[0].name);
      this.clients.set(clientId.toString('hex'), clientPub);
      const signed = Buffer.concat([hkdf(K, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info'), this.id, this.ltpk]);
      const out = tlv([[TLV.Identifier, this.id], [TLV.PublicKey, this.ltpk], [TLV.Signature, ed25519.sign(signed, this.seed)]]);
      return reply([[TLV.SeqNo, 6], [TLV.EncryptedData, seal(key, 'PS-Msg06', out)]]);
    }
  }

  #verify(s, msg) {
    const t = readTlv(msg._pd);
    const seq = t.get(TLV.SeqNo)?.[0];
    const reply = (items) => this.#send(s, FRAME.PV_Next, { _pd: tlv(items) });
    if (seq === 1) {
      const secret = randomBytes(32);
      const pub = Buffer.from(x25519.getPublicKey(secret));
      const clientPub = t.get(TLV.PublicKey);
      const shared = Buffer.from(x25519.getSharedSecret(secret, clientPub));
      const key = hkdf(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
      s.session.verify = { pub, clientPub, shared, key };
      const sig = ed25519.sign(Buffer.concat([pub, this.id, clientPub]), this.seed);
      return reply([[TLV.SeqNo, 2], [TLV.PublicKey, pub], [TLV.EncryptedData, seal(key, 'PV-Msg02', tlv([[TLV.Identifier, this.id], [TLV.Signature, sig]]))]]);
    }
    if (seq === 3) {
      const v = s.session.verify;
      const inner = readTlv(open(v.key, 'PV-Msg03', t.get(TLV.EncryptedData)));
      const clientId = inner.get(TLV.Identifier);
      const ltpk = this.clients.get(clientId.toString('hex'));
      const ok = ltpk && ed25519.verify(inner.get(TLV.Signature), Buffer.concat([v.clientPub, clientId, v.pub]), ltpk);
      if (!ok) return reply([[TLV.SeqNo, 4], [TLV.Error, 2]]);
      reply([[TLV.SeqNo, 4]]);
      s.session.cipher = new SessionCipher(hkdf(v.shared, '', 'ServerEncrypt-main'), hkdf(v.shared, '', 'ClientEncrypt-main'));
    }
  }

  #message(s, msg) {
    this.requests.push([msg._i, msg._c]);
    if (msg._t !== MSG.Request) return;
    const answer = (c) => this.#send(s, FRAME.E_OPACK, { _i: msg._i, _t: MSG.Response, _c: c, _x: msg._x });
    if (this.refuse.has(msg._i)) return this.#send(s, FRAME.E_OPACK, { _em: 'No request handler', _t: MSG.Response, _x: msg._x });
    if (msg._i === '_sessionStart') return answer({ _sid: 77 });
    if (msg._i === 'FetchAttentionState') return answer({ state: this.attention });
    if (msg._i === 'FetchLaunchableApplicationsEvent') return answer(this.apps);
    if (msg._i === '_mcc' && msg._c._mcc === 5) return answer({ _vol: opack.float(0.35) });
    answer({});
    if (msg._i === '_hidC' && msg._c._hBtS === 2 && msg._c._hidC === 12) this.push('SystemStatus', { state: 1 }); // asleep
    if (msg._i === '_hidC' && msg._c._hBtS === 2 && msg._c._hidC === 13) this.push('SystemStatus', { state: 3 });
  }
}

const IP = '127.0.0.1';
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(5);
  }
}
const transportFor = (tv, extra = {}) => new JsAtvTransport({ ports: [tv.port], info: async () => ({ model: 'AppleTV11,1' }), holdMs: 20, probeMs: 500, ...extra });

async function pairedCredential(tv, t = transportFor(tv)) {
  await t.request('pair_begin', { key: 'k', ip: IP, protocol: 'companion' });
  const { credentials } = await t.request('pair_pin', { key: 'k', pin: tv.pin });
  return credentials;
}

test('pair-setup with the PIN, pair-verify, then an encrypted session', async () => {
  const tv = await new FakeAppleTv().listen();
  const t = transportFor(tv);
  try {
    const begun = await t.request('pair_begin', { key: 'k', ip: IP, protocol: 'companion' });
    assert.deepEqual(begun, { protocol: 'companion', devicePin: true, port: tv.port });
    const { credentials, port } = await t.request('pair_pin', { key: 'k', pin: '1234' });
    assert.equal(port, tv.port);
    // pyatv's credential string, so the Python bridge can use it too
    const [ltpk, ltsk, atvId, clientId] = credentials.split(':');
    assert.equal(ltpk, tv.ltpk.toString('hex'));
    assert.equal(ltsk.length, 64);
    assert.equal(Buffer.from(atvId, 'hex').toString(), tv.id.toString());
    assert.match(Buffer.from(clientId, 'hex').toString(), /^[0-9a-f-]{36}$/);
    assert.deepEqual(tv.names, ['Hearth'], 'the TV lists the pairing as "Hearth"');

    const res = await t.request('connect', { key: 'k', ip: IP, port: tv.port, credentials: { companion: credentials } });
    assert.equal(res.port, tv.port);
    assert.equal(res.state.power, 'on');
    assert.equal(res.state.online, true);
    // pyatv's handshake, in order, all over the encrypted session (the last
    // two _interest events are fire-and-forget)
    await until(() => tv.requests.length >= 9);
    assert.deepEqual(tv.requests.map(([n]) => n), ['_systemInfo', '_touchStart', '_sessionStart', 'TVRCSessionStart', '_tiStart', '_interest', 'FetchAttentionState', '_interest', '_interest']);
    const info = tv.sent('_systemInfo')[0];
    assert.equal(info.name, 'Hearth');
    assert.equal(Buffer.from(info._idsID).toString('hex'), clientId);
    assert.match(info._i, /^[0-9a-f]{12}$/);
    assert.deepEqual(tv.sent('_interest').map((c) => c._regEvents[0]), ['_iMC', 'SystemStatus', 'TVSystemStatus']);
    await t.request('disconnect', { key: 'k' });
  } finally {
    await t.close();
    await tv.close();
  }
});

test('a wrong PIN fails cleanly with a 401, and asking again works', async () => {
  const tv = await new FakeAppleTv().listen();
  const t = transportFor(tv);
  try {
    await t.request('pair_begin', { key: 'k', ip: IP, protocol: 'companion' });
    await assert.rejects(t.request('pair_pin', { key: 'k', pin: '9999' }), (e) => e.status === 401 && e.code === 'auth');
    await assert.rejects(t.request('pair_pin', { key: 'k', pin: '1234' }), (e) => e.status === 410 && e.code === 'expired', 'that code is used up');
    assert.equal(tv.clients.size, 0);
    await t.request('pair_begin', { key: 'k', ip: IP, protocol: 'companion' });
    await t.request('pair_pin', { key: 'k', pin: '1234' });
    assert.equal(tv.clients.size, 1);
  } finally {
    await t.close();
    await tv.close();
  }
});

test('keys the Apple TV no longer knows are refused (401), not retried on other ports', async () => {
  const tv = await new FakeAppleTv().listen();
  const t = transportFor(tv);
  try {
    const credentials = await pairedCredential(tv, t);
    tv.clients.clear(); // "Remove" in the Apple TV's Remotes and Devices settings
    await assert.rejects(t.request('connect', { key: 'k', ip: IP, port: tv.port, credentials: { companion: credentials } }), (e) => e.status === 401 && e.code === 'auth');
    const other = new FakeAppleTv();
    other.seed = randomBytes(32); // a different Apple TV at that address
    await other.listen();
    other.clients = new Map([[credentials.split(':')[3], Buffer.alloc(32)]]);
    await assert.rejects(t.request('connect', { key: 'k', ip: IP, port: other.port, credentials: { companion: credentials } }), (e) => e.status === 401);
    await other.close();
  } finally {
    await t.close();
    await tv.close();
  }
});

test('the port is found by probing: saved first, then the usual range; probes never pair', async () => {
  const tv = await new FakeAppleTv().listen();
  // Something else on the Apple TV that accepts and says nothing, and a closed port.
  const silent = net.createServer((s) => s.on('error', () => {}));
  await new Promise((r) => silent.listen(0, IP, r));
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, IP, r));
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  const t = transportFor(tv, { ports: [closedPort, silent.address().port, tv.port] });
  try {
    const info = await t.request('info', { ip: IP, port: closedPort });
    assert.deepEqual(info.services, { companion: { port: tv.port, pairing: 'Mandatory' } });
    assert.equal(info.model, 'AppleTV11,1');
    assert.ok(tv.frames.every((f) => f === FRAME.PV_Start), 'only pair-verify step 1 (no code shown, nothing stored)');
    assert.equal(tv.clients.size, 0);

    // A saved port that moved: connect finds the new one and says where.
    const credentials = await pairedCredential(tv, t);
    const res = await t.request('connect', { key: 'k', ip: IP, port: closedPort, credentials: { companion: credentials } });
    assert.equal(res.port, tv.port);
    await t.request('disconnect', { key: 'k' });

    const none = new JsAtvTransport({ ports: [closedPort], probeMs: 300, info: async () => null });
    await assert.rejects(none.request('info', { ip: IP }), (e) => e.status === 503 && e.code === 'offline');
  } finally {
    await t.close();
    silent.close();
    await tv.close();
  }
});

// ── the driver, end to end through the fake ───────────────
function driverOn(tv, transport, extra = {}) {
  const saved = [];
  const info = [];
  const t = { id: 'appletv-media', brand: 'appletv', name: 'Media Room', ip: IP, macs: [], ...extra };
  const driver = new AppleTvDriver(t, {
    bridge: transport,
    onCredentials: (c) => {
      t.credentials = { ...t.credentials, ...c };
      saved.push(c);
    },
    onInfo: (i) => {
      Object.assign(t, i);
      info.push(i);
    },
  });
  return { driver, tv: t, saved, info };
}

test('driver: one code, then keys, holds, apps, launch, power and pushed state', async () => {
  const atv = await new FakeAppleTv().listen();
  const transport = transportFor(atv);
  const { driver, tv, saved, info } = driverOn(atv, transport);
  try {
    assert.equal(driver.capabilities.keyboard, false, 'no typing without pyatv');
    const first = await driver.pair({ mode: 'pin' });
    assert.deepEqual(first, { needsPin: true, step: 1, steps: 1, label: 'remote control', protocol: 'companion' });
    assert.deepEqual(info, [{ atvPort: atv.port }]);
    assert.deepEqual(await driver.pair({ pin: '12-34' }), {}, 'Companion only: done after one code');
    assert.equal(saved.length, 1);
    assert.match(tv.credentials.companion, /^[0-9a-f]{64}:[0-9a-f]{64}:[0-9a-f]+:[0-9a-f]+$/);
    await until(() => driver.state.online);
    assert.equal(driver.state.power, 'on');

    await driver.key('up');
    await driver.key('ok', { hold: 900 });
    await driver.key('back');
    await driver.key('home');
    await driver.key('volup');
    await driver.key('menu'); // Control Center
    await driver.key('forward');
    await driver.key('play');
    const hid = atv.sent('_hidC').map((c) => [c._hidC, c._hBtS]);
    assert.deepEqual(hid, [[1, 1], [1, 2], [6, 1], [6, 2], [5, 1], [5, 2], [7, 1], [7, 2], [8, 1], [8, 2], [19, 1], [19, 2], [14, 1], [14, 2]]);
    assert.deepEqual(atv.sent('_mcc').at(-1), { _mcc: 7, _skpS: 10 }, 'skip forward 10 s (sent as a float)');
    await assert.rejects(driver.key('stop'), (e) => e.status === 501);
    await assert.rejects(driver.text({ text: 'bluey' }), (e) => e.status === 501);

    assert.deepEqual(await driver.apps(), [
      { id: 'com.netflix.Netflix', title: 'Netflix', icon: null },
      { id: 'com.apple.TVWatchList', title: 'TV', icon: null },
      { id: 'com.google.ios.youtube', title: 'YouTube', icon: null },
    ]);
    await driver.launch('com.google.ios.youtube');
    assert.deepEqual(atv.sent('_launchApp'), [{ _bundleID: 'com.google.ios.youtube' }]);
    assert.equal(driver.state.app, 'com.google.ios.youtube');
    assert.equal(driver.state.appTitle, 'YouTube');

    await driver.powerOff();
    await until(() => driver.state.power === 'off');
    assert.equal(driver.state.app, null, 'asleep means no app');
    await driver.powerOn();
    await until(() => driver.state.power === 'on');
    assert.deepEqual(atv.sent('_hidC').slice(-2), [{ _hBtS: 2, _hidC: 12 }, { _hBtS: 2, _hidC: 13 }], 'Sleep/Wake: just the "up", as pyatv');

    // HomePods: the Apple TV says it has a volume; the level arrives.
    atv.push('_iMC', { _mcF: 0x100 });
    await until(() => driver.capabilities.volumeLevel);
    assert.equal(driver.state.volume, 35);
    await driver.setVolume(50);
    assert.equal(atv.sent('_mcc').at(-1)._vol, 0.5);
  } finally {
    await driver.stop();
    await transport.close();
    await atv.close();
  }
});

test('driver: a wrong code says "Show the number again"; a dropped link reconnects', async () => {
  const atv = await new FakeAppleTv().listen();
  const transport = transportFor(atv);
  const { driver, tv } = driverOn(atv, transport);
  try {
    await driver.pair({ mode: 'pin' });
    await assert.rejects(driver.pair({ pin: '0000' }), (e) => e.status === 401 && /Show the number again/.test(e.message));
    await assert.rejects(driver.pair({ pin: '1234' }), (e) => e.status === 409, 'no code pending');
    await driver.pair({ mode: 'pin' });
    await driver.pair({ pin: '1234' });
    await until(() => driver.state.online);
    assert.ok(tv.credentials.companion);

    for (const s of atv.sockets) s.destroy(); // Wi-Fi blip
    await until(() => !driver.state.online);
    await until(() => driver.state.online, 15_000); // the retry timer (5 s)
    await driver.key('down');
    assert.deepEqual(atv.sent('_hidC').at(-1), { _hBtS: 2, _hidC: 2 });
  } finally {
    await driver.stop();
    await transport.close();
    await atv.close();
  }
});

test('a garbage frame from the TV drops that link only', async () => {
  const evil = net.createServer((s) => {
    s.on('error', () => {});
    s.on('data', () => s.write(Buffer.from([FRAME.PV_Next, 0xff, 0xff, 0xff]))); // a 16 MB frame
  });
  await new Promise((r) => evil.listen(0, IP, r));
  const t = new JsAtvTransport({ ports: [evil.address().port], probeMs: 300, info: async () => null });
  try {
    await assert.rejects(t.request('info', { ip: IP }), (e) => e.status === 503);
  } finally {
    evil.close();
  }
});

test('hub: an Apple TV paired over JS keeps its keys server-side', async () => {
  const atv = await new FakeAppleTv().listen();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hearth-atvjs-'));
  const transport = transportFor(atv);
  setBridge(transport);
  const hub = await new Hub({ store: new Store(dir), forbiddenIp: () => false }).init();
  hub.watchMs = 3_600_000;
  try {
    const added = await hub.add({ brand: 'appletv', name: 'Media Room', model: '4K (2nd gen)', ip: IP });
    const step = await hub.pair(added.id, { mode: 'pin' });
    assert.equal(step.needsPin, true);
    assert.equal(step.steps, 1);
    const done = await hub.pair(added.id, { pin: '1234' });
    assert.equal(done.paired, true);
    const onDisk = JSON.parse(readFileSync(path.join(dir, 'tvs.json'), 'utf8')).tvs[0];
    assert.match(onDisk.credentials.companion, /^[0-9a-f]{64}:/);
    assert.equal(onDisk.atvPort, atv.port);
    const secretBits = onDisk.credentials.companion.split(':');
    const seen = JSON.stringify([hub.list(), step, done]);
    for (const bit of secretBits) assert.ok(!seen.includes(bit), 'pairing keys never reach clients');
    assert.ok(!seen.includes('atvPort'));
  } finally {
    await hub.close();
    setBridge(null);
    await transport.close();
    await atv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a venv whose Python can’t start pyatv: the driver carries on in JS', async () => {
  const atv = await new FakeAppleTv().listen();
  const venv = mkdtempSync(path.join(os.tmpdir(), 'hearth-venv-'));
  mkdirSync(path.join(venv, 'bin'));
  writeFileSync(path.join(venv, 'bin', 'python'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const env = { venv: process.env.HEARTH_VENV, atv: process.env.HEARTH_ATV };
  process.env.HEARTH_VENV = venv;
  delete process.env.HEARTH_ATV;
  setBridge(null);
  const transport = transportFor(atv);
  setJsTransport(transport);
  const t = { id: 'appletv-den', brand: 'appletv', name: 'Den', ip: IP, macs: [] };
  const driver = new AppleTvDriver(t, { onCredentials: (c) => (t.credentials = { ...t.credentials, ...c }), onInfo: (i) => Object.assign(t, i) });
  try {
    assert.equal(atvMode(), 'auto');
    assert.notEqual(driver.bridge, transport, 'starts on the bridge');
    const first = await driver.pair({ mode: 'pin' });
    assert.equal(driver.bridge, transport, 'the bridge said "not installed", so JS took over');
    assert.equal(first.steps, 1);
    await driver.pair({ pin: '1234' });
    await until(() => driver.state.online);
    await driver.key('right');
    assert.deepEqual(atv.sent('_hidC').at(-1), { _hBtS: 2, _hidC: 4 });
  } finally {
    await driver.stop();
    await transport.close();
    setJsTransport(null);
    await getBridge().close();
    setBridge(null);
    for (const [k, v] of [['HEARTH_VENV', env.venv], ['HEARTH_ATV', env.atv]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(venv, { recursive: true, force: true });
    await atv.close();
  }
});

test('atvMode: HEARTH_ATV picks the transport; the phone is always JS', () => {
  assert.equal(atvMode({ HEARTH_ATV: 'js' }), 'js');
  assert.equal(atvMode({ HEARTH_ATV: 'python' }), 'bridge');
  assert.ok(['auto', 'js'].includes(atvMode({})), 'here: the bridge if its venv exists, else JS');
  const real = process.platform;
  Object.defineProperty(process, 'platform', { value: 'ios' });
  try {
    assert.equal(atvMode({}), 'js');
  } finally {
    Object.defineProperty(process, 'platform', { value: real });
  }
});

// ── AirPlay + MRP: "what's playing" without Python ─────────
// Vectors made by pyatv 0.18 itself (test/fixtures/pyatv-airplay-vectors.py
// → .json): Hearth's bytes must equal pyatv's.
const V = JSON.parse(readFileSync(new URL('./fixtures/pyatv-airplay-vectors.json', import.meta.url), 'utf8'));
const vec = (name) => Buffer.from(V[name], 'hex');
const U = '11111111-2222-3333-4444-555555555555';

test('mrp: the opening messages are byte-identical to pyatv’s', () => {
  assert.deepEqual(mrp.deviceInfo({ name: 'Hearth', uniqueIdentifier: 'AAAA-BBBB', identifier: 'ID-1', uid: U }), vec('deviceInfo'));
  assert.deepEqual(mrp.setConnectionState({ uniqueIdentifier: U }), vec('setConnectionState'));
  assert.deepEqual(mrp.clientUpdatesConfig({ identifier: 'ID-2', uniqueIdentifier: U }), vec('clientUpdatesConfig'));
  assert.deepEqual(mrp.getKeyboardSession({ identifier: 'ID-3', uniqueIdentifier: U }), vec('getKeyboardSession'));
  assert.deepEqual(mrp.sendCommand(mrp.COMMAND.TogglePlayPause, { identifier: 'ID-4', uniqueIdentifier: U }), vec('sendCommandToggle'));
  const parsed = mrp.parseMessage(vec('deviceInfo'));
  assert.equal(parsed.type, mrp.TYPE.DEVICE_INFO);
  assert.equal(parsed.identifier, 'ID-1');
});

test('mrp: reads pyatv’s SET_STATE and SET_NOW_PLAYING_CLIENT like pyatv does', () => {
  const np = new mrp.NowPlaying();
  np.handle(mrp.parseMessage(vec('setNowPlayingClient')));
  np.handle(mrp.parseMessage(vec('setState')));
  // elapsed 61.25 s at Cocoa time 800000000, playing at rate 1: 10 s later is 71
  const at = (800000000 + 978307200 + 10) * 1000;
  assert.deepEqual(np.snapshot(at), {
    app: 'com.example.tv', appTitle: 'Example TV', title: 'Porch Lights: The Long Night In', playing: 'playing', position: 71, duration: 2640,
  });
});

// Builds MRP messages the way an Apple TV sends them, for the rules below.
const playerPath = (bundle, player = 'MediaRemote-DefaultPlayer', displayName) => ({ 2: { 2: bundle, 7: displayName }, 3: { 1: player } });
const meta = (m) => ({ 1: m.title, 14: m.duration != null ? proto.double(m.duration) : undefined, 35: m.elapsed != null ? proto.double(m.elapsed) : undefined, 39: m.rate != null ? proto.float(m.rate) : undefined, 63: m.series, 74: m.at != null ? proto.double(m.at) : undefined });
const setState = ({ bundle, state, item, location = 0 }) => mrp.message(mrp.TYPE.SET_STATE, { 3: item ? { 1: location, 2: [{ 1: 'i1', 2: meta(item) }] } : undefined, 6: state, 9: playerPath(bundle) });
const nowPlayingClient = (bundle, name) => mrp.message(mrp.TYPE.SET_NOW_PLAYING_CLIENT, { 1: { 2: bundle, 7: name } });

test('mrp: pyatv’s play-state rules, content updates, removed clients', () => {
  const np = new mrp.NowPlaying();
  const feed = (...msgs) => msgs.forEach((m) => np.handle(mrp.parseMessage(m)));
  assert.deepEqual(np.snapshot(), { app: null, appTitle: null, title: null, playing: null, position: null, duration: null });
  feed(nowPlayingClient('com.netflix.Netflix', 'Netflix'));
  assert.equal(np.snapshot().app, 'com.netflix.Netflix');
  assert.equal(np.snapshot().playing, null, 'no state yet: idle');
  feed(setState({ bundle: 'com.netflix.Netflix', state: mrp.PLAYBACK.Paused }));
  assert.equal(np.snapshot().playing, null, 'paused with nothing queued counts as idle');
  feed(setState({ bundle: 'com.netflix.Netflix', state: mrp.PLAYBACK.Paused, item: { title: 'Pilot', series: 'Pilot Season', duration: 1800, elapsed: 30, rate: 0, at: 1000 } }));
  assert.deepEqual(np.snapshot(), { app: 'com.netflix.Netflix', appTitle: 'Netflix', title: 'Pilot Season: Pilot', playing: 'paused', position: 30, duration: 1800 });
  feed(setState({ bundle: 'com.netflix.Netflix', state: mrp.PLAYBACK.Interrupted }));
  assert.equal(np.snapshot().playing, 'loading');
  feed(setState({ bundle: 'com.netflix.Netflix', state: mrp.PLAYBACK.Playing }));
  feed(mrp.message(mrp.TYPE.UPDATE_CONTENT_ITEM, { 1: [{ 1: 'i1', 2: { 39: proto.float(2) } }], 2: playerPath('com.netflix.Netflix') }));
  assert.equal(np.snapshot().playing, 'playing', 'seeking (rate 2) reads as playing');
  assert.equal(np.snapshot().title, 'Pilot Season: Pilot', 'an update merges into the item');
  feed(setState({ bundle: 'com.netflix.Netflix', state: mrp.PLAYBACK.Stopped }));
  assert.equal(np.snapshot().playing, null);
  feed(mrp.message(mrp.TYPE.UPDATE_CLIENT, { 1: { 2: 'com.netflix.Netflix', 7: 'Netflix Kids' } }));
  assert.equal(np.snapshot().appTitle, 'Netflix Kids');
  feed(mrp.message(mrp.TYPE.REMOVE_CLIENT, { 1: { 2: 'com.netflix.Netflix' } }));
  assert.equal(np.snapshot().app, null, 'the app went away');
  // A title that already names the series isn't doubled.
  feed(nowPlayingClient('com.apple.TVWatchList', 'TV'), setState({ bundle: 'com.apple.TVWatchList', state: 1, item: { title: 'Harbor Town: Episode 3', series: 'Harbor Town' } }));
  assert.equal(np.snapshot().title, 'Harbor Town: Episode 3');
  assert.doesNotThrow(() => np.handle(mrp.parseMessage(Buffer.from([0x08, 0x04, 0x4a, 0x05, 0xff]))), 'a truncated SET_STATE is skipped');
});

test('bplist: writes exactly what plistlib writes, reads it back, refuses junk', () => {
  const event = { isRemoteControlOnly: true, osName: 'iPhone OS', sourceVersion: '550.10', timingProtocol: 'None', model: 'iPhone10,6', deviceID: 'FF:70:79:61:74:76', osVersion: '14.7.1', osBuildVersion: '18G82', macAddress: '02:70:79:61:74:76', sessionUUID: 'AAAAAAAA-0000-4000-8000-000000000001', name: 'Hearth' };
  assert.deepEqual(bplist.encode(event), vec('eventSetup'));
  const stream = (seed) => ({ streams: [{ controlType: 2, channelID: 'C0000000-0000-4000-8000-000000000002', seed, clientUUID: 'C0000000-0000-4000-8000-000000000003', type: 130, wantsDedicatedSocket: true, clientTypeUUID: '1910A70F-DBC0-4242-AF95-115DB30604E1' }] });
  assert.deepEqual(bplist.encode(stream(12345678901234567890n)), vec('dataSetup'), 'a seed past 2^63 is a 128-bit integer');
  assert.deepEqual(bplist.encode(stream(4611686018427387904n)), vec('dataSetupSmallSeed'));
  assert.deepEqual(bplist.encode({ a: [1, true, bplist.real(1), 1.5, -3, 300, 70000, 2 ** 40, b(0, 1), 'x', 'é', 'x'], z: { k: 'x' } }), vec('mixed'));
  assert.deepEqual(bplist.encode({ list: Array.from({ length: 300 }, (_, i) => `s${i}`) }), vec('big'), 'two-byte references');
  assert.deepEqual(bplist.decode(vec('mixed')), { a: [1, true, 1, 1.5, -3, 300, 70000, 2 ** 40, b(0, 1), 'x', 'é', 'x'], z: { k: 'x' } });
  assert.equal(bplist.decode(vec('dataSetup')).streams[0].seed, 12345678901234567890n);
  assert.throws(() => bplist.decode(Buffer.from('not a plist at all, not even close....')));
  // An array that contains itself must not recurse forever.
  const loop = Buffer.concat([ascii('bplist00'), b(0xa1, 0x00), b(0x08), Buffer.from([0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x0a])]);
  assert.throws(() => bplist.decode(loop), RangeError);
});

test('airplay framing: data-stream frames and HAP blocks match pyatv', () => {
  const pb = mrp.setConnectionState({ uniqueIdentifier: U });
  assert.deepEqual(airplay.encodeDataFrame({ type: 'sync', command: ascii('comm'), seqno: 0x123456789n, payload: airplay.protobufPayload([pb]) }), vec('dataFrame'));
  assert.deepEqual(airplay.encodeDataFrame({ type: 'rply', seqno: 0x123456789n }), vec('replyFrame'));
  const [frame] = new airplay.DataFrameReader().push(vec('dataFrame'));
  assert.equal(frame.type, 'sync');
  assert.deepEqual(airplay.splitProtobufs(bplist.decode(frame.payload).params.data), [pb]);
  assert.throws(() => new airplay.DataFrameReader().push(Buffer.concat([b(0x7f, 0xff, 0xff, 0xff), Buffer.alloc(28)])), RangeError, 'a 2 GB frame is refused');

  const keys = [Buffer.from([...Array(32).keys()]), Buffer.from([...Array(32).keys()].map((i) => i + 32))];
  const out = new HapFraming(keys[0], keys[1]);
  const sealed = Buffer.concat([out.encrypt(vec('hapPlain')), out.encrypt(ascii('second'))]);
  assert.deepEqual(sealed, vec('hapSealed'), '1024-byte blocks, 4 zero bytes + 8-byte counter nonces');
  const back = new HapFraming(Buffer.alloc(32), keys[0]);
  const plain = Buffer.concat([back.decrypt(sealed.subarray(0, 700)), back.decrypt(sealed.subarray(700))]);
  assert.deepEqual(plain, Buffer.concat([vec('hapPlain'), ascii('second')]));
});

// The fake Apple TV with its AirPlay side (same identity), and a transport
// that finds AirPlay there.
async function fakeWithAirPlay() {
  const atv = await new FakeAppleTv().listen();
  const ap = await new FakeAirPlay({ seed: atv.seed, id: atv.id }).listen();
  return { atv, ap, close: async () => Promise.all([atv.close(), ap.close()]) };
}
const airplayTransport = ({ atv, ap }, extra = {}) => transportFor(atv, { info: airplay.airplayInfo, airplayPort: ap.port, feedbackMs: 100, airplayRetry: { min: 50, max: 400 }, mrpTimeout: 500, ...extra });

test('transport: info offers AirPlay; its code pairs separately, in pyatv’s format', async () => {
  const fakes = await fakeWithAirPlay();
  const t = airplayTransport(fakes);
  try {
    const info = await t.request('info', { ip: IP });
    assert.deepEqual(info.services, { companion: { port: fakes.atv.port, pairing: 'Mandatory' }, airplay: { port: fakes.ap.port, pairing: 'Mandatory' } });
    assert.equal(info.model, 'AppleTV11,1', 'the model comes from GET /info, over the raw socket');

    assert.deepEqual(await t.request('pair_begin', { key: 'k', ip: IP, protocol: 'airplay' }), { protocol: 'airplay', devicePin: true });
    assert.equal(fakes.ap.pinStarts, 1, 'POST /pair-pin-start put the code on screen');
    await assert.rejects(t.request('pair_pin', { key: 'k', pin: '1234' }), (e) => e.status === 401, 'the Companion code isn’t the AirPlay one');
    await t.request('pair_begin', { key: 'k', ip: IP, protocol: 'airplay' });
    const { protocol, credentials, port } = await t.request('pair_pin', { key: 'k', pin: '5678' });
    assert.equal(protocol, 'airplay');
    assert.equal(port, undefined, 'never a Companion port');
    const [ltpk, ltsk, atvId, clientId] = credentials.split(':');
    assert.equal(ltpk, fakes.atv.ltpk.toString('hex'));
    assert.equal(ltsk.length, 64);
    assert.equal(Buffer.from(atvId, 'hex').toString(), fakes.atv.id.toString());
    assert.match(Buffer.from(clientId, 'hex').toString(), /^[0-9a-f-]{36}$/);
    assert.deepEqual(fakes.ap.names, ['Hearth']);
    assert.equal(fakes.atv.clients.size, 0, 'a separate pairing from Companion’s');

    // No AirPlay answer (a non-Apple box, or :7000 closed): Companion only.
    const closed = net.createServer();
    await new Promise((r) => closed.listen(0, IP, r));
    const closedPort = closed.address().port;
    await new Promise((r) => closed.close(r));
    assert.equal(await airplay.airplayInfo(IP, { port: closedPort, timeout: 300 }), null);
  } finally {
    await t.close();
    await fakes.close();
  }
});

test('transport: AirPlay + MRP push what’s playing; a drop reconnects; refused keys leave the remote working', async () => {
  const fakes = await fakeWithAirPlay();
  const t = airplayTransport(fakes);
  const states = [];
  t.on('state', (m) => states.push(m.state));
  try {
    const companion = await pairedCredential(fakes.atv, t);
    await t.request('pair_begin', { key: 'k', ip: IP, protocol: 'airplay' });
    const { credentials: air } = await t.request('pair_pin', { key: 'k', pin: '5678' });
    const res = await t.request('connect', { key: 'k', ip: IP, port: fakes.atv.port, credentials: { companion, airplay: air } });
    assert.equal(res.state.app, null);
    await until(() => t.airplayStatus('k').connected);

    // pyatv's order on the wire
    const order = fakes.ap.requests.filter(([, u]) => u !== '/feedback').map(([m, u]) => (m === 'SETUP' || m === 'RECORD' ? m : `${m} ${u}`));
    assert.deepEqual(order.slice(-5), ['POST /pair-verify', 'POST /pair-verify', 'SETUP', 'RECORD', 'SETUP']);
    assert.equal(fakes.ap.setups[0].isRemoteControlOnly, true);
    assert.equal(fakes.ap.setups[0].name, 'Hearth');
    assert.equal(fakes.ap.setups[1].streams[0].type, 130);
    assert.deepEqual(fakes.ap.mrp.map((m) => m.type), [mrp.TYPE.DEVICE_INFO, mrp.TYPE.SET_CONNECTION_STATE, mrp.TYPE.CLIENT_UPDATES_CONFIG, mrp.TYPE.GET_KEYBOARD_SESSION]);
    assert.equal(fakes.ap.mrp[0].deviceName, 'Hearth');
    assert.equal(proto.str(fakes.ap.mrp[0].inner, 1), Buffer.from(air.split(':')[3], 'hex').toString(), 'the pairing’s client id');
    await until(() => fakes.ap.feedbacks >= 2); // the keep-alive

    fakes.ap.push(vec('setNowPlayingClient'), vec('setState'));
    await until(() => states.at(-1)?.title);
    assert.deepEqual({ ...states.at(-1), position: undefined }, {
      online: true, power: 'on', volume: null, volumeLevel: false,
      app: 'com.example.tv', appTitle: 'Example TV', title: 'Porch Lights: The Long Night In', playing: 'playing', position: undefined, duration: 2640,
    });
    assert.equal(t.op_state({ key: 'k' }).app, 'com.example.tv');

    // Stop goes over MRP (Companion has no stop).
    await t.request('remote', { key: 'k', method: 'stop' });
    assert.deepEqual(fakes.ap.commands, [mrp.COMMAND.Stop]);

    // AirPlay drops (Companion stays): what's playing clears, then comes back.
    const before = fakes.ap.mrpOf(mrp.TYPE.DEVICE_INFO).length;
    fakes.ap.drop();
    await until(() => states.at(-1)?.app === null);
    assert.equal(states.at(-1).power, 'on', 'the remote is still there');
    await until(() => fakes.ap.mrpOf(mrp.TYPE.DEVICE_INFO).length > before && t.airplayStatus('k').connected, 5000);
    fakes.ap.push(vec('setNowPlayingClient'));
    await until(() => states.at(-1)?.app === 'com.example.tv');

    // The Apple TV forgot the AirPlay pairing: no retry loop, remote fine.
    await t.request('disconnect', { key: 'k' });
    fakes.ap.clients.clear();
    const verifies = () => fakes.ap.requests.filter(([, u]) => u === '/pair-verify').length;
    await t.request('connect', { key: 'k', ip: IP, port: fakes.atv.port, credentials: { companion, airplay: air } });
    await until(() => /didn’t accept/.test(t.airplayStatus('k').reason));
    const n = verifies();
    await tick(300);
    assert.equal(verifies(), n, 'refused keys aren’t retried');
    await t.request('remote', { key: 'k', method: 'up' });
    assert.deepEqual(fakes.atv.sent('_hidC').at(-1), { _hBtS: 2, _hidC: 1 });
  } finally {
    await t.close();
    await fakes.close();
  }
});

test('transport: an Apple TV that never answers MRP, or sends garbage, can’t hurt the remote', async () => {
  const fakes = await fakeWithAirPlay();
  const t = airplayTransport(fakes);
  try {
    const companion = await pairedCredential(fakes.atv, t);
    await t.request('pair_begin', { key: 'k', ip: IP, protocol: 'airplay' });
    const { credentials: air } = await t.request('pair_pin', { key: 'k', pin: '5678' });
    await t.request('connect', { key: 'k', ip: IP, port: fakes.atv.port, credentials: { companion, airplay: air } });
    await until(() => t.airplayStatus('k').connected);
    // Junk on the data stream: unreadable protobufs, a plist that isn't one,
    // then a frame that doesn't decrypt. The stream drops; nothing throws.
    fakes.ap.push(Buffer.from([0x08, 0xff, 0xff, 0xff]), Buffer.from('garbage'));
    for (const s of fakes.ap.dataSockets) s.write(Buffer.concat([b(0x40, 0x00), randomBytes(100)]));
    await until(() => !t.airplayStatus('k').connected);
    await t.request('remote', { key: 'k', method: 'down' });
    assert.deepEqual(fakes.atv.sent('_hidC').at(-1), { _hBtS: 2, _hidC: 2 });
    await t.request('disconnect', { key: 'k' });

    fakes.ap.silentMrp = true;
    const quiet = airplayTransport(fakes);
    await quiet.request('connect', { key: 'q', ip: IP, port: fakes.atv.port, credentials: { companion, airplay: air } });
    await until(() => /too long/.test(quiet.airplayStatus('q').reason));
    assert.equal(quiet.op_state({ key: 'q' }).power, 'on');
    await quiet.close();
  } finally {
    await t.close();
    await fakes.close();
  }
});

test('http: a reply with a huge Content-Length drops that connection only', async () => {
  const evil = net.createServer((s) => {
    s.on('error', () => {});
    s.on('data', () => s.write('HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n'));
  });
  await new Promise((r) => evil.listen(0, IP, r));
  try {
    assert.equal(await airplay.airplayInfo(IP, { port: evil.address().port, timeout: 500 }), null);
    const link = new HttpLink({ host: IP, port: evil.address().port, timeout: 500 });
    await link.open();
    await assert.rejects(link.request('GET', '/info'), (e) => e.status === 503);
    assert.equal(link.closed, true);
  } finally {
    evil.close();
  }
});

test('driver: two codes on the phone too, then the app, title and play state from MRP', async () => {
  const fakes = await fakeWithAirPlay();
  const transport = airplayTransport(fakes);
  const { driver, tv } = driverOn(fakes.atv, transport);
  try {
    const first = await driver.pair({ mode: 'pin' });
    assert.deepEqual(first, { needsPin: true, step: 1, steps: 2, label: 'remote control', protocol: 'companion' });
    const second = await driver.pair({ pin: '1234' });
    assert.deepEqual(second, { needsPin: true, step: 2, steps: 2, label: 'what’s playing', protocol: 'airplay' });
    assert.equal(tv.atvPort, fakes.atv.port, 'the AirPlay step leaves the Companion port alone');
    assert.deepEqual(await driver.pair({ pin: '5678' }), {});
    assert.ok(tv.credentials.companion && tv.credentials.airplay);
    assert.notEqual(tv.credentials.companion, tv.credentials.airplay);
    await until(() => transport.airplayStatus(tv.id).connected, 5000);

    fakes.ap.push(nowPlayingClient('com.netflix.Netflix', 'Netflix'), setState({ bundle: 'com.netflix.Netflix', state: mrp.PLAYBACK.Playing, item: { title: 'The Quiet Lighthouse', duration: 5400, elapsed: 120, rate: 1, at: (Date.now() / 1000) - 978307200 } }));
    await until(() => driver.state.nowPlaying);
    assert.equal(driver.state.app, 'com.netflix.Netflix');
    assert.equal(driver.state.appTitle, 'Netflix');
    assert.equal(driver.state.nowPlaying, 'The Quiet Lighthouse');
    assert.equal(driver.state.playing, 'playing');
    assert.equal(driver.state.media.state, 'playing');
    assert.equal(driver.state.media.duration, 5400_000);
    assert.ok(driver.state.media.position >= 120_000);

    // play while playing does nothing; pause sends the one toggle
    const hid = () => fakes.atv.sent('_hidC').length;
    const n = hid();
    await driver.key('play');
    assert.equal(hid(), n);
    await driver.key('pause');
    assert.deepEqual(fakes.atv.sent('_hidC').slice(-2).map((c) => c._hidC), [14, 14]);
    fakes.ap.push(setState({ bundle: 'com.netflix.Netflix', state: mrp.PLAYBACK.Paused }));
    await until(() => driver.state.playing === 'paused');
    await driver.key('stop');
    assert.deepEqual(fakes.ap.commands, [mrp.COMMAND.Stop]);

    // Asleep: no app, whatever MRP last said.
    await driver.powerOff();
    await until(() => driver.state.power === 'off');
    assert.equal(driver.state.app, null);
    assert.equal(driver.state.nowPlaying, null);
  } finally {
    await driver.stop();
    await transport.close();
    await fakes.close();
  }
});
