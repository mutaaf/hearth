// A pretend Apple TV's AirPlay side on 127.0.0.1, for test/appletv-js.test.js
// (and, by hand, pyatv's own client: see CLAUDE.md). Real HAP pair-setup
// (SRP from its PIN) and pair-verify over HTTP, the HAP-encrypted RTSP
// control connection, the event channel, the data stream (its own port and
// keys) and MRP over it: it answers DEVICE_INFO / CLIENT_UPDATES_CONFIG /
// GET_KEYBOARD_SESSION / SEND_COMMAND and pushes whatever push() is given.
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import * as bplist from '../../src/atv/bplist.js';
import { DataFrameReader, encodeDataFrame, KEYS, protobufPayload, splitProtobufs } from '../../src/atv/airplay.js';
import { hkdf, open, seal } from '../../src/atv/hap.js';
import { format, HapFraming, parse } from '../../src/atv/http.js';
import { message, parseMessage, TYPE } from '../../src/atv/mrp.js';
import * as opack from '../../src/atv/opack.js';
import * as srp from '../../src/atv/srp.js';
import { decode as readTlv, encode as tlv, TLV } from '../../src/atv/tlv8.js';
import { str as pbStr } from '../../src/proto.js';

export class FakeAirPlay {
  pin = '5678';
  clients = new Map(); // AirPlay pairings: clientId (hex) → Ed25519 public key
  names = [];
  requests = []; // [method, uri]
  pinStarts = 0;
  feedbacks = 0;
  commands = []; // SEND_COMMAND command numbers
  mrp = []; // MRP messages from the client: { type, identifier, inner, deviceName }
  setups = []; // SETUP bodies
  sockets = new Set();
  servers = [];
  dataSockets = new Set();
  model = 'AppleTV11,1';
  // What the next pair-verify M4 / control request answers, to test refusals.
  refuseVerify = false;
  silentMrp = false; // never answer DEVICE_INFO

  constructor({ seed = randomBytes(32), id = Buffer.from('5D797FD3-3538-427E-A47B-A32FC6CF3A6A') } = {}) {
    Object.assign(this, { seed, id });
  }

  get ltpk() {
    return Buffer.from(ed25519.getPublicKey(this.seed));
  }

  async listen() {
    this.port = await this.#server((s) => this.#control(s));
    return this;
  }

  async #server(onSocket) {
    const server = net.createServer((s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
      s.on('error', () => {});
      onSocket(s);
    });
    this.servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return server.address().port;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await Promise.all(this.servers.map((srv) => new Promise((r) => srv.close(r))));
  }

  // Drops every connection (a Wi-Fi blip on the AirPlay side only).
  drop() {
    for (const s of this.sockets) s.destroy();
  }

  mrpOf(type) {
    return this.mrp.filter((m) => m.type === type);
  }

  // MRP messages (bytes) to every open data stream.
  push(...messages) {
    for (const s of this.dataSockets) {
      s.send(encodeDataFrame({ type: 'sync', command: Buffer.from('comm'), seqno: 7n, payload: protobufPayload(messages) }));
    }
  }

  // ── the control connection (:7000) ─────────────────────
  #control(s) {
    let buf = Buffer.alloc(0);
    s.state = {};
    s.send = (bytes) => s.write(s.framing ? s.framing.encrypt(bytes) : bytes);
    s.on('data', (chunk) => {
      const data = s.framing ? s.framing.decrypt(chunk) : chunk;
      buf = Buffer.concat([buf, data]);
      for (let msg = parse(buf); msg; msg = parse(buf)) {
        buf = Buffer.from(msg.rest);
        this.#request(s, msg);
      }
    });
  }

  #request(s, msg) {
    const [method, uri, protocol] = msg.first.split(' ');
    this.requests.push([method, uri]);
    const reply = (status, body = null, headers = {}) => {
      const h = { ...headers };
      if (msg.headers.cseq != null) h.CSeq = msg.headers.cseq;
      if (body) h['Content-Length'] = body.length;
      else h['Content-Length'] = 0;
      s.send(format(`${protocol} ${status} ${status === 200 ? 'OK' : 'Error'}`, h, body));
    };
    const okTlv = (items) => reply(200, tlv(items), { 'Content-Type': 'application/octet-stream' });
    if (method === 'GET' && uri === '/info') {
      return reply(200, bplist.encode({ model: this.model, name: 'Media Room', features: 0x1c340445f8a00, statusFlags: 0x44, sourceVersion: '770.8.1' }), { 'Content-Type': 'application/x-apple-binary-plist' });
    }
    if (method === 'POST' && uri === '/pair-pin-start') {
      this.pinStarts++;
      return reply(200);
    }
    if (method === 'POST' && uri === '/pair-setup') return this.#pairSetup(s, readTlv(msg.body), okTlv);
    if (method === 'POST' && uri === '/pair-verify') return this.#pairVerify(s, readTlv(msg.body), okTlv, reply);
    if (!s.framing) return reply(470); // RTSP before pair-verify
    if (method === 'SETUP') return this.#setup(s, bplist.decode(msg.body), reply);
    if (method === 'RECORD') return reply(200, null, { 'Audio-Latency': 0 });
    if (method === 'POST' && uri === '/feedback') {
      this.feedbacks++;
      return reply(200);
    }
    return reply(404);
  }

  #pairSetup(s, t, okTlv) {
    const seq = t.get(TLV.SeqNo)[0];
    if (seq === 1) {
      const salt = randomBytes(16);
      s.state.srp = srp.server({ salt, v: srp.verifier(salt, this.pin), b: randomBytes(32) });
      return okTlv([[TLV.SeqNo, 2], [TLV.Salt, salt], [TLV.PublicKey, s.state.srp.B]]);
    }
    if (seq === 3) {
      const done = s.state.srp.finish(t.get(TLV.PublicKey), t.get(TLV.Proof));
      if (!done) return okTlv([[TLV.SeqNo, 4], [TLV.Error, 2]]);
      s.state.K = done.K;
      return okTlv([[TLV.SeqNo, 4], [TLV.Proof, done.M2]]);
    }
    if (seq === 5) {
      const K = s.state.K;
      const key = hkdf(K, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
      const inner = readTlv(open(key, 'PS-Msg05', t.get(TLV.EncryptedData)));
      const clientId = inner.get(TLV.Identifier);
      const clientPub = inner.get(TLV.PublicKey);
      const signedByClient = Buffer.concat([hkdf(K, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info'), clientId, clientPub]);
      if (!ed25519.verify(inner.get(TLV.Signature), signedByClient, clientPub)) return okTlv([[TLV.SeqNo, 6], [TLV.Error, 2]]);
      if (inner.get(TLV.Name)) this.names.push(opack.unpack(inner.get(TLV.Name))[0].name);
      this.clients.set(clientId.toString('hex'), clientPub);
      const signed = Buffer.concat([hkdf(K, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info'), this.id, this.ltpk]);
      const out = tlv([[TLV.Identifier, this.id], [TLV.PublicKey, this.ltpk], [TLV.Signature, ed25519.sign(signed, this.seed)]]);
      return okTlv([[TLV.SeqNo, 6], [TLV.EncryptedData, seal(key, 'PS-Msg06', out)]]);
    }
  }

  #pairVerify(s, t, okTlv, reply) {
    const seq = t.get(TLV.SeqNo)?.[0];
    if (seq === 1) {
      const secret = randomBytes(32);
      const pub = Buffer.from(x25519.getPublicKey(secret));
      const clientPub = t.get(TLV.PublicKey);
      const shared = Buffer.from(x25519.getSharedSecret(secret, clientPub));
      const key = hkdf(shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
      s.state.verify = { pub, clientPub, shared, key };
      const sig = ed25519.sign(Buffer.concat([pub, this.id, clientPub]), this.seed);
      return okTlv([[TLV.SeqNo, 2], [TLV.PublicKey, pub], [TLV.EncryptedData, seal(key, 'PV-Msg02', tlv([[TLV.Identifier, this.id], [TLV.Signature, sig]]))]]);
    }
    if (seq === 3) {
      const v = s.state.verify;
      const inner = readTlv(open(v.key, 'PV-Msg03', t.get(TLV.EncryptedData)));
      const clientId = inner.get(TLV.Identifier);
      const ltpk = this.clients.get(clientId.toString('hex'));
      const ok = !this.refuseVerify && ltpk && ed25519.verify(inner.get(TLV.Signature), Buffer.concat([v.clientPub, clientId, v.pub]), ltpk);
      if (!ok) return reply(470); // what pyatv reads as "invalid or missing credentials"
      okTlv([[TLV.SeqNo, 4]]);
      s.state.shared = v.shared;
      const [salt, clientOut, clientIn] = KEYS.control;
      s.framing = new HapFraming(hkdf(v.shared, salt, clientIn), hkdf(v.shared, salt, clientOut));
    }
  }

  async #setup(s, body, reply) {
    this.setups.push(body);
    const shared = s.state.shared;
    if (body.streams) {
      const [salt, clientOut, clientIn] = KEYS.data(body.streams[0].seed);
      const dataPort = await this.#server((d) => this.#data(d, new HapFraming(hkdf(shared, salt, clientIn), hkdf(shared, salt, clientOut))));
      return reply(200, bplist.encode({ streams: [{ type: 130, dataPort, streamID: 1 }] }), { 'Content-Type': 'application/x-apple-binary-plist' });
    }
    // The event channel: the client's "output" is Events-Read (pyatv swaps them).
    const [salt, clientOut, clientIn] = KEYS.events;
    const eventPort = await this.#server((e) => {
      const framing = new HapFraming(hkdf(shared, salt, clientIn), hkdf(shared, salt, clientOut));
      e.on('data', (chunk) => framing.decrypt(chunk)); // nothing to say on it
    });
    return reply(200, bplist.encode({ eventPort, timingPort: 0 }), { 'Content-Type': 'application/x-apple-binary-plist' });
  }

  // ── the data stream: MRP ──────────────────────────────
  #data(d, framing) {
    const reader = new DataFrameReader();
    d.send = (bytes) => d.write(framing.encrypt(bytes));
    this.dataSockets.add(d);
    d.on('close', () => this.dataSockets.delete(d));
    d.on('data', (chunk) => {
      for (const frame of reader.push(framing.decrypt(chunk))) {
        if (frame.type === 'sync') d.send(encodeDataFrame({ type: 'rply', seqno: frame.seqno }));
        if (!frame.payload.length) continue;
        const data = bplist.decode(frame.payload)?.params?.data;
        for (const pb of splitProtobufs(data)) this.#mrp(d, parseMessage(pb));
      }
    });
  }

  #mrp(d, msg) {
    const record = { ...msg };
    if (msg.type === TYPE.DEVICE_INFO) record.deviceName = pbStr(msg.inner, 2);
    this.mrp.push(record);
    const answer = (type, inner = null) => {
      const bytes = message(type, inner, { identifier: msg.identifier });
      d.send(encodeDataFrame({ type: 'sync', command: Buffer.from('comm'), seqno: 9n, payload: protobufPayload([bytes]) }));
    };
    if (msg.type === TYPE.DEVICE_INFO && !this.silentMrp) return answer(TYPE.DEVICE_INFO, { 1: 'FAKE-ATV', 2: 'Media Room', 3: 'Apple TV', 7: 1 });
    if (msg.type === TYPE.CLIENT_UPDATES_CONFIG) return answer(TYPE.GENERIC);
    if (msg.type === TYPE.GET_KEYBOARD_SESSION) return answer(23); // KEYBOARD_MESSAGE
    if (msg.type === TYPE.SEND_COMMAND) {
      this.commands.push(msg.inner[1]?.[0]);
      return answer(TYPE.SEND_COMMAND_RESULT, { 1: 0, 2: 0 });
    }
  }
}
