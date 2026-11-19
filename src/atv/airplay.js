import { EventEmitter } from 'node:events';
import net from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { sha512 } from '@noble/hashes/sha2.js';
import * as bplist from './bplist.js';
import { checkTlv, formatCredentials, PairingError, PairSetup, PairVerify, parseCredentials } from './hap.js';
import { HapFraming, HttpLink, format, parse } from './http.js';
import { linkError } from './link.js';
import { varint } from '../proto.js';

// AirPlay 2 on an Apple TV, as far as "what's playing" needs it, following
// pyatv 0.18 (protocols/airplay/: auth/hap.py, ap2_session.py, channels.py):
//   pairing   POST /pair-pin-start, then HAP pair-setup over POST /pair-setup
//             (the second code; same SRP/TLV8 as Companion)
//   connect   POST /pair-verify ×2 → the connection turns HAP-encrypted →
//             RTSP SETUP (event channel) → RECORD → SETUP of a data stream
//             (type 130, "remote control") → POST /feedback every 2 s
//   MRP       protobuf messages tunnelled in that data stream (src/atv/mrp.js)

export const AIRPLAY_PORT = 7000;
const PAIR_HEADERS = { 'User-Agent': 'AirPlay/320.20', Connection: 'keep-alive', 'X-Apple-HKP': 3, 'Content-Type': 'application/octet-stream' };
const RTSP_AGENT = 'AirPlay/550.10';
const BPLIST = 'application/x-apple-binary-plist';
export const FEEDBACK_MS = 2000;

// The keys for each connection, from the one pair-verify (pyatv names).
export const KEYS = {
  control: ['Control-Salt', 'Control-Write-Encryption-Key', 'Control-Read-Encryption-Key'],
  // The event channel's write/read swap: the Apple TV is the one asking there.
  events: ['Events-Salt', 'Events-Read-Encryption-Key', 'Events-Write-Encryption-Key'],
  data: (seed) => [`DataStream-Salt${seed}`, 'DataStream-Output-Encryption-Key', 'DataStream-Input-Encryption-Key'],
};
// What iOS's Remote says it is in the SETUP (pyatv's InfoSettings defaults).
const CLIENT_TYPE_UUID = '1910A70F-DBC0-4242-AF95-115DB30604E1';
const INFO = { osName: 'iPhone OS', model: 'iPhone10,6', osVersion: '14.7.1', osBuildVersion: '18G82' };

const body = (res) => (res.body?.length ? res.body : Buffer.alloc(0));
function plistOf(res) {
  try {
    return bplist.decode(res.body);
  } catch {
    throw new PairingError('protocol', 'The Apple TV sent an AirPlay answer Hearth can’t read');
  }
}

// GET /info (no pairing needed): a binary plist with the model and flags.
// → { model, airplay } (airplay: it's an Apple TV, so remote control over
// AirPlay is there), or null when nothing answers.
export async function airplayInfo(ip, { port = AIRPLAY_PORT, timeout = 2000, connect = net.connect } = {}) {
  const link = new HttpLink({ host: ip, port, timeout, connect });
  try {
    await link.open({ timeout });
    const res = await link.request('GET', '/info', { headers: { 'User-Agent': RTSP_AGENT } });
    if (res.status !== 200) return null;
    let model = null;
    try {
      model = bplist.decode(res.body)?.model ?? null;
    } catch {
      model = res.body.toString('latin1').match(/AppleTV\d+,\d+/)?.[0] ?? null;
    }
    model = typeof model === 'string' ? model : null;
    return { model, airplay: Boolean(model?.startsWith('AppleTV')) };
  } catch {
    return null;
  } finally {
    link.close();
  }
}

// ── pairing (the second code) ────────────────────────────
async function post(link, path, data, timeout) {
  const res = await link.request('POST', path, { headers: PAIR_HEADERS, body: data, timeout });
  if (res.status === 470 || res.status === 401 || res.status === 403) throw new PairingError('auth', 'The Apple TV didn’t accept Hearth on AirPlay');
  if (res.status < 200 || res.status >= 300) throw new PairingError('protocol', `The Apple TV’s AirPlay said no (${res.status})`);
  return body(res);
}

export async function beginAirPlayPairing({ host, port = AIRPLAY_PORT, name = 'Hearth', timeout = 5000, connect }) {
  const link = new HttpLink({ host, port, timeout, connect });
  await link.open();
  const setup = new PairSetup({ name });
  try {
    await post(link, '/pair-pin-start', null, timeout); // the code appears now
    const m2 = await post(link, '/pair-setup', setup.m1(), timeout);
    checkTlv(m2);
    return new AirPlayPairing(link, setup, m2, timeout);
  } catch (err) {
    link.close();
    throw err;
  }
}

export class AirPlayPairing {
  constructor(link, setup, m2, timeout) {
    Object.assign(this, { link, setup, m2, timeout });
  }

  async finish(pin) {
    try {
      const m4 = await post(this.link, '/pair-setup', this.setup.m3(pin, this.m2), this.timeout);
      const m6 = await post(this.link, '/pair-setup', this.setup.m5(m4), this.timeout);
      return formatCredentials(this.setup.credentials(m6));
    } finally {
      this.link.close();
    }
  }

  close() {
    this.link.close();
  }
}

// ── HAP channels (the event and data connections) ────────
// A raw TCP connection whose bytes are HAP-framed both ways; 'data' carries
// plaintext, 'close' fires once.
export class HapChannel extends EventEmitter {
  #socket = null;
  #closed = false;

  constructor({ host, port, keys, timeout = 5000, connect = net.connect }) {
    super();
    this.framing = new HapFraming(keys.output, keys.input);
    Object.assign(this, { host, port, timeout, connectFn: connect });
  }

  get closed() {
    return this.#closed;
  }

  open() {
    return new Promise((resolve, reject) => {
      const socket = this.connectFn({ host: this.host, port: this.port });
      this.#socket = socket;
      let up = false;
      const timer = setTimeout(() => {
        reject(linkError('offline', 'The Apple TV didn’t open its AirPlay channel'));
        this.close();
      }, this.timeout);
      timer.unref?.();
      socket.on('connect', () => {
        up = true;
        clearTimeout(timer);
        socket.setNoDelay?.(true);
        resolve(this);
      });
      socket.on('error', (err) => {
        if (!up) {
          clearTimeout(timer);
          reject(Object.assign(linkError('offline', 'The Apple TV didn’t open its AirPlay channel'), { cause: err }));
        }
        this.close(err);
      });
      socket.on('close', () => this.close());
      socket.on('data', (chunk) => {
        try {
          const plain = this.framing.decrypt(chunk);
          if (plain.length) this.onPlain(plain);
        } catch (err) {
          this.close(err);
        }
      });
    });
  }

  onPlain(plain) {
    this.emit('data', plain);
  }

  send(bytes) {
    if (this.#closed || !this.#socket) return;
    this.#socket.write(this.framing.encrypt(bytes));
  }

  close(err) {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket?.destroy();
    } catch {
      // already gone
    }
    this.emit('close', err);
  }
}

// The event channel: the Apple TV sends RTSP-style requests; we just say OK
// (pyatv channels.py EventChannel). Nothing in them is used.
export class EventChannel extends HapChannel {
  #buf = Buffer.alloc(0);
  onPlain(plain) {
    this.#buf = Buffer.concat([this.#buf, plain]);
    for (let msg = parse(this.#buf); msg; msg = parse(this.#buf)) {
      this.#buf = Buffer.from(msg.rest);
      const protocol = msg.first.split(' ')[2] || 'RTSP/1.0';
      const headers = { 'Content-Length': 0, 'Audio-Latency': 0 };
      if (msg.headers.server) headers.Server = msg.headers.server;
      if (msg.headers.cseq) headers.CSeq = msg.headers.cseq;
      this.send(format(`${protocol} 200 OK`, headers));
    }
  }
}

// ── the data stream ──────────────────────────────────────
// Frames: [size u32 BE, header included][type 12 bytes: "sync"/"rply" + 8
// zeros][command 4 bytes: "comm" or zeros][seqno u64 BE][padding u32], then a
// binary plist {params: {data: <protobufs, each varint-length-prefixed>}}.
// A "sync" frame wants a "rply" with the same seqno.
export const DATA_HEADER = 32;
export const MAX_DATA_FRAME = 8 * 1024 * 1024;

export function encodeDataFrame({ type, command = Buffer.alloc(4), seqno, payload = Buffer.alloc(0) }) {
  const head = Buffer.alloc(DATA_HEADER);
  head.writeUInt32BE(DATA_HEADER + payload.length, 0);
  Buffer.from(type, 'latin1').copy(head, 4, 0, 4);
  Buffer.from(command).copy(head, 16, 0, 4);
  head.writeBigUInt64BE(BigInt(seqno), 20);
  return Buffer.concat([head, payload]);
}

export class DataFrameReader {
  #buf = Buffer.alloc(0);
  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : Buffer.from(chunk);
    const frames = [];
    while (this.#buf.length >= DATA_HEADER) {
      const size = this.#buf.readUInt32BE(0);
      if (size < DATA_HEADER || size > MAX_DATA_FRAME) throw new RangeError('bad AirPlay data frame');
      if (this.#buf.length < size) break;
      frames.push({
        type: this.#buf.toString('latin1', 4, 8),
        command: this.#buf.toString('latin1', 16, 20),
        seqno: this.#buf.readBigUInt64BE(20),
        payload: Buffer.from(this.#buf.subarray(DATA_HEADER, size)),
      });
      this.#buf = this.#buf.subarray(size);
    }
    return frames;
  }
}

// The data stream payload → each protobuf message's bytes. Mostly
// varint-length-prefixed; a message starting 0x08 (field 1, the type) isn't
// (pyatv: ConfigureConnectionMessage arrives like that).
export function splitProtobufs(data) {
  const out = [];
  let at = 0;
  while (at < data.length) {
    if (data[at] === 0x08) {
      out.push(data.subarray(at));
      break;
    }
    let len = 0;
    let mul = 1;
    let b;
    do {
      if (at >= data.length || mul > 2 ** 35) return out;
      b = data[at++];
      len += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    if (at + len > data.length) break;
    out.push(data.subarray(at, at + len));
    at += len;
  }
  return out;
}

export const protobufPayload = (messages) => bplist.encode({ params: { data: Buffer.concat(messages.flatMap((m) => [varint(m.length), m])) } });

export class DataChannel extends HapChannel {
  #reader = new DataFrameReader();
  // pyatv picks one random seqno per channel and sends every frame with it.
  seqno = 0x100000000n + BigInt(randomBytes(4).readUInt32BE(0));

  onPlain(plain) {
    for (const frame of this.#reader.push(plain)) {
      if (frame.payload.length) {
        let msg = null;
        try {
          msg = bplist.decode(frame.payload);
        } catch {
          // not a plist: nothing for us
        }
        const data = msg?.params?.data;
        if (Buffer.isBuffer(data)) for (const pb of splitProtobufs(data)) this.emit('protobuf', Buffer.from(pb));
      }
      if (frame.type === 'sync') this.send(encodeDataFrame({ type: 'rply', seqno: frame.seqno }));
    }
  }

  sendProtobuf(message) {
    this.send(encodeDataFrame({ type: 'sync', command: Buffer.from('comm'), seqno: this.seqno, payload: protobufPayload([message]) }));
  }
}

// ── the session ──────────────────────────────────────────
// connect(): pair-verify on :7000, encryption on, the event channel, RECORD,
// the data stream, feedback every 2 s. dataChannel then carries MRP.
// 'close' fires once, when any of its connections goes.
export class AirPlaySession extends EventEmitter {
  #link = null;
  #verify = null;
  #channels = [];
  #feedback = null;
  #cseq = 0;
  #closed = false;
  dataChannel = null;

  constructor({ host, port = AIRPLAY_PORT, credentials, name = 'Hearth', timeout = 5000, connect = net.connect, feedbackMs = FEEDBACK_MS }) {
    super();
    this.creds = parseCredentials(credentials);
    Object.assign(this, { host, port, name, timeout, connectFn: connect, feedbackMs });
    this.sessionId = randomBytes(4).readUInt32BE(0);
    this.dacpId = randomBytes(8).toString('hex').toUpperCase();
    this.activeRemote = randomBytes(4).readUInt32BE(0);
  }

  get closed() {
    return this.#closed;
  }

  async connect() {
    const link = new HttpLink({ host: this.host, port: this.port, timeout: this.timeout, connect: this.connectFn });
    this.#link = link;
    link.once('close', (err) => this.close(err));
    try {
      await link.open();
      await this.#pairVerify(link);
      const [salt, out, inp] = KEYS.control;
      const { output, input } = this.#verify.keys(salt, out, inp);
      link.enableEncryption(output, input);

      const events = await this.#setup(this.#eventSetup());
      await this.#channel(EventChannel, events.eventPort, KEYS.events);
      await this.#rtsp('RECORD');
      const seed = BigInt(`0x${randomBytes(8).toString('hex')}`) >> 1n; // < 2^63, as an int in the plist
      const streams = await this.#setup(this.#dataSetup(seed));
      const dataPort = streams.streams?.[0]?.dataPort;
      this.dataChannel = await this.#channel(DataChannel, dataPort, KEYS.data(seed));
      this.#startFeedback();
      return this;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  async #pairVerify(link) {
    const verify = new PairVerify(this.creds);
    const m2 = await post(link, '/pair-verify', verify.m1(), this.timeout);
    const m4 = await post(link, '/pair-verify', verify.m3(m2), this.timeout);
    if (m4.length) checkTlv(m4); // an Error here means the Apple TV forgot us
    this.#verify = verify;
  }

  // A stable identity per pairing, like the Companion side.
  #ids() {
    const h = Buffer.from(sha512(this.creds.clientId));
    const mac = (bytes) => bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    return { deviceId: mac([0xfe & (h[12] | 0x02), ...h.subarray(13, 18)]), mac: mac([0xfe & (h[18] | 0x02), ...h.subarray(19, 24)]) };
  }

  #eventSetup() {
    const { deviceId, mac } = this.#ids();
    return {
      isRemoteControlOnly: true,
      osName: INFO.osName,
      sourceVersion: '550.10',
      timingProtocol: 'None',
      model: INFO.model,
      deviceID: deviceId,
      osVersion: INFO.osVersion,
      osBuildVersion: INFO.osBuildVersion,
      macAddress: mac,
      sessionUUID: randomUUID().toUpperCase(),
      name: this.name,
    };
  }

  #dataSetup(seed) {
    return {
      streams: [{
        controlType: 2,
        channelID: randomUUID().toUpperCase(),
        seed,
        clientUUID: randomUUID().toUpperCase(),
        type: 130,
        wantsDedicatedSocket: true,
        clientTypeUUID: CLIENT_TYPE_UUID,
      }],
    };
  }

  async #rtsp(method, { uri, body } = {}) {
    if (!this.#link || this.#link.closed) throw linkError('offline', 'Not connected to that Apple TV');
    const headers = {
      'User-Agent': RTSP_AGENT,
      CSeq: this.#cseq++,
      'DACP-ID': this.dacpId,
      'Active-Remote': this.activeRemote,
      'Client-Instance': this.dacpId,
    };
    if (body) headers['Content-Type'] = BPLIST;
    const res = await this.#link.request(method, uri ?? `rtsp://${this.#link.localAddress}/${this.sessionId}`, {
      protocol: 'RTSP/1.0',
      headers,
      body: body ? bplist.encode(body) : null,
    });
    if (res.status === 470) throw new PairingError('auth', 'The Apple TV didn’t accept Hearth on AirPlay');
    if (res.status < 200 || res.status >= 300) throw linkError('refused', `The Apple TV’s AirPlay said no to ${method} (${res.status})`);
    return res;
  }

  async #setup(content) {
    const res = await this.#rtsp('SETUP', { body: content });
    const plist = plistOf(res);
    if (!plist || typeof plist !== 'object') throw new PairingError('protocol', 'The Apple TV sent an empty AirPlay SETUP answer');
    return plist;
  }

  async #channel(Kind, port, [salt, out, inp]) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new PairingError('protocol', 'The Apple TV didn’t say which AirPlay port to use');
    const channel = new Kind({ host: this.host, port, keys: this.#verify.keys(salt, out, inp), timeout: this.timeout, connect: this.connectFn });
    this.#channels.push(channel);
    channel.once('close', (err) => this.close(err));
    await channel.open();
    return channel;
  }

  // The keep-alive: POST /feedback every 2 s. A failed one ends the session.
  #startFeedback() {
    const beat = () => {
      this.#feedback = setTimeout(async () => {
        try {
          await this.#rtsp('POST', { uri: '/feedback' });
          if (!this.#closed) beat();
        } catch (err) {
          this.close(err);
        }
      }, this.feedbackMs);
      this.#feedback.unref?.();
    };
    beat();
  }

  close(err) {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#feedback);
    for (const c of this.#channels) c.close();
    this.#link?.close();
    this.emit('close', err);
  }
}
