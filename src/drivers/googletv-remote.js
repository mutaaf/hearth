import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';
import forge from 'node-forge';
import { asOffline, HearthError, offline } from '../errors.js';
import { decode, first, frame, str, sub, unframe } from '../proto.js';

// Google's Android TV Remote protocol v2 — the one the Google TV phone app
// uses. Optional on top of Cast: it unlocks arrow keys, OK, back, home and
// power, but Google always demands a one-time code shown on the TV first.
//
//   Pairing  TLS :6467  PairingMessage (protobuf, varint length-prefixed)
//   Remote   TLS :6466  RemoteMessage, same client certificate
//
// Both sides present self-signed certificates; the pairing secret binds our
// key, the TV's key and the code on screen together.

// Android KEYCODEs for Hearth's unified key names.
export const ANDROID_KEYS = {
  up: 19, down: 20, left: 21, right: 22, ok: 23, back: 4, home: 3, menu: 82, info: 165,
  volup: 24, voldown: 25, mute: 164, chup: 166, chdown: 167,
  play: 126, pause: 127, playpause: 85, rewind: 89, forward: 90, stop: 86,
  power: 26, source: 178, wakeup: 224, sleep: 223, exit: 4,
};
export const DIRECTION = { START_LONG: 1, END_LONG: 2, SHORT: 3 };
const STATUS_OK = 200;
const STATUS_BAD_SECRET = 402;
const FEATURES = 622; // ping, key, IME, power, volume, app-link

// A fresh RSA-2048 client identity, self-signed. Stored with the TV's
// credentials (server side only) once pairing succeeds.
export function makeIdentity(commonName = 'Hearth') {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }));
  cert.serialNumber = `01${crypto.randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = new Date(Date.now() - 864e5);
  cert.validity.notAfter = new Date(Date.now() + 20 * 365 * 864e5);
  const attrs = [{ name: 'commonName', value: commonName }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });
  cert.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: keyPem };
}

const hexBytes = (hex) => Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
const strip0 = (hex) => hex.replace(/^0+(?=.)/, '').toUpperCase();

// Public key numbers as the hex strings the protocol hashes:
// modulus without leading zeros, exponent with one leading "0" (65537 → 010001).
export function keyNumbersFromPem(certPem) {
  const jwk = new crypto.X509Certificate(certPem).publicKey.export({ format: 'jwk' });
  const n = strip0(Buffer.from(jwk.n, 'base64url').toString('hex'));
  const e = `0${BigInt(`0x${Buffer.from(jwk.e, 'base64url').toString('hex')}`).toString(16).toUpperCase()}`;
  return { n, e };
}

export function keyNumbersFromPeer(peer) {
  if (!peer?.modulus || !peer?.exponent) throw new HearthError(502, 'The TV didn’t present a usable certificate');
  return { n: strip0(peer.modulus), e: `0${String(peer.exponent).replace(/^0x/i, '').toUpperCase()}` };
}

export const isCode = (code) => /^[0-9a-f]{6}$/i.test(String(code ?? '').trim());

// secret = SHA256(client n ‖ client e ‖ server n ‖ server e ‖ code[1..]),
// and the first byte of the secret must equal the code's first byte — so a
// mistyped code is caught here, before anything goes to the TV.
export function pairingSecret(client, server, code) {
  if (!isCode(code)) throw new HearthError(400, 'Type the 6 letters and numbers shown on the TV (0–9, A–F).');
  const codeBytes = Buffer.from(String(code).trim(), 'hex');
  const secret = crypto
    .createHash('sha256')
    .update(hexBytes(client.n))
    .update(hexBytes(client.e))
    .update(hexBytes(server.n))
    .update(hexBytes(server.e))
    .update(codeBytes.subarray(1))
    .digest();
  return { secret, matches: secret[0] === codeBytes[0] };
}

// A socket that speaks varint-framed protobuf and lets us wait for messages.
class Channel extends EventEmitter {
  #sock = null;
  #buf = Buffer.alloc(0);
  #waiters = [];

  connect({ host, port, cert, key, timeout = 6000 }) {
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ host, port, cert, key, rejectUnauthorized: false, timeout });
      let done = false;
      sock.once('secureConnect', () => {
        done = true;
        this.#sock = sock;
        sock.setTimeout(0);
        resolve(this);
      });
      sock.on('data', (d) => {
        // A malformed frame drops this connection (it reconnects), never the process.
        try {
          this.#onData(d);
        } catch (err) {
          sock.destroy(err);
        }
      });
      sock.once('timeout', () => sock.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      // Persistent: a socket can emit 'error' more than once.
      sock.on('error', (err) => {
        if (!done) {
          done = true;
          // ECONNRESET in the handshake means "unknown certificate" here (see AtvRemote).
          reject(err.code === 'ECONNRESET' ? err : asOffline(err));
        }
      });
      sock.once('close', () => {
        this.#sock = null;
        for (const w of this.#waiters.splice(0)) w.reject(new HearthError(503, 'The TV closed the connection'));
        this.emit('close');
        if (!done) {
          done = true;
          reject(offline());
        }
      });
    });
  }

  get peer() {
    return this.#sock?.getPeerCertificate() ?? null;
  }

  get open() {
    return Boolean(this.#sock);
  }

  send(msg) {
    this.#sock?.write(frame(msg));
  }

  // Next message for which `match(decoded)` is true.
  next(match = () => true, timeout = 10_000) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject };
      w.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((x) => x !== w);
        reject(new HearthError(504, 'The TV didn’t answer'));
      }, timeout);
      this.#waiters.push(w);
    });
  }

  #onData(chunk) {
    const [msgs, rest] = unframe(Buffer.concat([this.#buf, chunk]));
    // Remote messages are tiny; a buffer this big is a garbage length prefix.
    if (rest.length > 64 * 1024) throw new Error('Remote frame too large');
    this.#buf = rest;
    for (const raw of msgs) {
      const msg = decode(raw);
      const w = this.#waiters.find((x) => x.match(msg));
      if (w) {
        clearTimeout(w.timer);
        this.#waiters = this.#waiters.filter((x) => x !== w);
        w.resolve(msg);
      } else {
        this.emit('message', msg);
      }
    }
  }

  close() {
    this.#sock?.destroy();
    this.#sock = null;
  }
}

// Step 1–3 open the code on the TV; finish(code) completes it.
export class AtvPairing {
  #ch = new Channel();

  constructor({ host, port = 6467, cert, key, clientName = 'Hearth' }) {
    Object.assign(this, { host, port, certPem: cert, keyPem: key, clientName });
  }

  async #exchange(msg, field) {
    this.#ch.send({ 1: 2, 2: STATUS_OK, ...msg });
    const reply = await this.#ch.next();
    const status = first(reply, 2);
    if (status !== STATUS_OK) {
      throw new HearthError(status === STATUS_BAD_SECRET ? 400 : 502, status === STATUS_BAD_SECRET ? 'That code didn’t work. Check the TV and try again.' : `The TV refused pairing (status ${status ?? '?'})`);
    }
    if (field && !reply[field]) throw new HearthError(502, 'The TV answered something unexpected');
    return reply;
  }

  async start() {
    await this.#ch.connect({ host: this.host, port: this.port, cert: this.certPem, key: this.keyPem });
    await this.#exchange({ 10: { 1: 'atvremote', 2: this.clientName } }, 11);
    await this.#exchange({ 20: { 1: [{ 1: 3, 2: 6 }], 3: 1 } }, 20);
    await this.#exchange({ 30: { 1: { 1: 3, 2: 6 }, 2: 1 } }, 31);
    // The TV now shows a 6-character code.
    return { needsCode: true };
  }

  get open() {
    return this.#ch.open;
  }

  async finish(code) {
    if (!this.#ch.open) throw new HearthError(409, 'The code expired. Tap “Show a new code”.');
    const { secret, matches } = pairingSecret(keyNumbersFromPem(this.certPem), keyNumbersFromPeer(this.#ch.peer), code);
    if (!matches) throw new HearthError(400, 'That code doesn’t match the TV. Check it and try again.');
    await this.#exchange({ 40: { 1: secret } }, 41);
    this.close();
  }

  close() {
    this.#ch.close();
  }
}

// The remote channel: handshake, pings, key presses, and state pushes.
export class AtvRemote extends EventEmitter {
  #ch = null;
  ready = false;

  #heardAt = 0;
  #watchdog = null;

  // The TV pings every ~5 s. With the socket timeout off, a TV that vanished
  // (Wi-Fi dropped, unplugged) leaves a half-open socket that still looks
  // "ready", so no message for `silenceMs` drops it and the driver reconnects.
  constructor({ host, port = 6466, cert, key, model = 'Hearth', vendor = 'Hearth', silenceMs = 15_000 }) {
    super();
    Object.assign(this, { host, port, certPem: cert, keyPem: key, model, vendor, silenceMs });
  }

  async connect(timeout = 8000) {
    const ch = new Channel();
    this.#ch = ch;
    this.#heardAt = Date.now();
    ch.on('message', (msg) => {
      this.#heardAt = Date.now();
      this.#onMessage(msg);
    });
    ch.on('close', () => {
      clearInterval(this.#watchdog);
      this.#watchdog = null;
      const was = this.ready;
      this.ready = false;
      if (this.#ch === ch) this.#ch = null;
      this.emit('close', { was });
    });
    try {
      await ch.connect({ host: this.host, port: this.port, cert: this.certPem, key: this.keyPem });
    } catch (err) {
      // A TV that doesn't know our certificate drops us during the handshake.
      if (err.code === 'ECONNRESET' || /handshake|certificate|alert/i.test(err.message)) {
        throw new HearthError(401, 'The TV no longer recognises Hearth. Unlock the full remote again.');
      }
      throw err;
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('ready', onReady);
        // Don't leave the half-set-up channel open behind us.
        ch.close();
        reject(new HearthError(401, 'The TV didn’t accept Hearth’s remote. Unlock the full remote again.'));
      }, timeout);
      const onReady = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('ready', onReady);
      ch.once('close', () => {
        clearTimeout(timer);
        if (!this.ready) reject(new HearthError(401, 'The TV no longer recognises Hearth. Unlock the full remote again.'));
      });
    });
    clearInterval(this.#watchdog);
    this.#watchdog = setInterval(() => {
      if (Date.now() - this.#heardAt > this.silenceMs) ch.close();
    }, Math.max(50, Math.min(5000, this.silenceMs / 3)));
    this.#watchdog.unref?.();
    return this;
  }

  #onMessage(msg) {
    const ch = this.#ch;
    if (!ch) return;
    if (msg[1]) {
      ch.send({ 1: { 1: FEATURES, 2: { 1: this.model, 2: this.vendor, 3: 1, 4: '1', 5: 'atvremote', 6: '1.0.0' } } });
    }
    if (msg[2]) {
      ch.send({ 2: { 1: FEATURES } });
      if (!this.ready) {
        this.ready = true;
        this.emit('ready');
      }
    }
    if (msg[8]) ch.send({ 9: { 1: first(sub(msg, 8), 1) ?? 0 } });
    if (msg[3]) this.emit('remote-error', sub(msg, 3));
    if (msg[40]) this.emit('state', { started: Boolean(first(sub(msg, 40), 1)) });
    if (msg[50]) {
      const v = sub(msg, 50);
      const max = first(v, 6) || 100;
      this.emit('state', { volume: Math.round(((first(v, 7) ?? 0) / max) * 100), muted: Boolean(first(v, 8)) });
    }
    if (msg[20]) {
      const app = str(sub(sub(msg, 20), 1), 12);
      if (app) this.emit('state', { app });
    }
  }

  key(code, direction = DIRECTION.SHORT) {
    if (!this.ready || !this.#ch) throw offline();
    this.#ch.send({ 10: { 1: code, 2: direction } });
  }

  launch(link) {
    if (!this.ready || !this.#ch) throw offline();
    this.#ch.send({ 90: { 1: link } });
  }

  close() {
    this.ready = false;
    clearInterval(this.#watchdog);
    this.#watchdog = null;
    this.#ch?.close();
    this.#ch = null;
  }
}
