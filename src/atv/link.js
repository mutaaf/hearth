import { EventEmitter } from 'node:events';
import net from 'node:net';
import { HearthError } from '../errors.js';
import { SessionCipher } from './hap.js';
import * as opack from './opack.js';

// The Companion link: TCP frames of [type (1 byte)][length (3 bytes, BE)]
// [payload]. Pairing frames carry plain OPACK; once pair-verify is done
// every payload is ChaCha20-Poly1305 sealed with the header as AAD, and the
// length counts the 16-byte tag. (pyatv companion/connection.py.)
export const FRAME = { NoOp: 1, PS_Start: 3, PS_Next: 4, PV_Start: 5, PV_Next: 6, U_OPACK: 7, E_OPACK: 8, P_OPACK: 9 };
export const MSG = { Event: 1, Request: 2, Response: 3 };
const AUTH = new Set([FRAME.PS_Start, FRAME.PS_Next, FRAME.PV_Start, FRAME.PV_Next]);
const OPACK = new Set([FRAME.U_OPACK, FRAME.E_OPACK, FRAME.P_OPACK]);
const TAG = 16;
export const MAX_FRAME = 1 << 21; // an app list is tens of KB; 2 MB is plenty

export function header(type, length) {
  return Buffer.from([type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}

// Splits a byte stream into frames; throws on a frame over MAX_FRAME.
export class FrameReader {
  #buf = Buffer.alloc(0);
  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : Buffer.from(chunk);
    const frames = [];
    while (this.#buf.length >= 4) {
      const len = (this.#buf[1] << 16) | (this.#buf[2] << 8) | this.#buf[3];
      if (len > MAX_FRAME) throw new Error('Companion frame too large');
      if (this.#buf.length < 4 + len) break;
      frames.push({ type: this.#buf[0], header: this.#buf.subarray(0, 4), payload: this.#buf.subarray(4, 4 + len) });
      this.#buf = this.#buf.subarray(4 + len);
    }
    return frames;
  }
}

export const linkError = (code, message) => Object.assign(new HearthError({ offline: 503, auth: 401, refused: 502, timeout: 504 }[code] ?? 502, message), { code });

// One TCP connection to an Apple TV's Companion port. request() is a _t=2
// request answered by the _t=3 response with the same _x; 'event' carries
// pushed _t=1 events (name, content). 'close' fires once.
export class CompanionLink extends EventEmitter {
  #socket = null;
  #reader = new FrameReader();
  #cipher = null;
  #auth = null; // the one pairing/verify exchange in flight
  #waiting = new Map(); // _x → { resolve, reject, timer }
  #xid = Math.floor(Math.random() * 0x10000);
  #closed = false;

  constructor({ host, port, timeout = 5000, connect = net.connect }) {
    super();
    Object.assign(this, { host, port, timeout, connectFn: connect });
  }

  get closed() {
    return this.#closed;
  }

  open({ timeout = 3000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = this.connectFn({ host: this.host, port: this.port });
      this.#socket = socket;
      let up = false;
      const timer = setTimeout(() => {
        reject(linkError('offline', 'The Apple TV didn’t answer'));
        this.close();
      }, timeout);
      socket.on('connect', () => {
        up = true;
        clearTimeout(timer);
        socket.setNoDelay?.(true);
        socket.setKeepAlive?.(true, 15_000);
        resolve(this);
      });
      // Persistent: a socket can error more than once.
      socket.on('error', (err) => {
        if (!up) {
          clearTimeout(timer);
          reject(Object.assign(linkError('offline', 'The Apple TV didn’t answer'), { cause: err }));
        }
        this.close(err);
      });
      socket.on('close', () => this.close());
      socket.on('data', (chunk) => {
        try {
          for (const f of this.#reader.push(chunk)) this.#onFrame(f);
        } catch {
          this.close(new Error('bad frame')); // a bad frame drops this link only
        }
      });
    });
  }

  enableEncryption({ output, input }) {
    this.#cipher = new SessionCipher(output, input);
  }

  #onFrame({ type, header: head, payload }) {
    let data = payload;
    if (this.#cipher && data.length) data = this.#cipher.open(data, head);
    if (!AUTH.has(type) && !OPACK.has(type)) return; // NoOp and friends
    const [msg] = opack.unpack(data);
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (AUTH.has(type)) {
      const waiter = this.#auth;
      this.#auth = null;
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
      return;
    }
    if (msg._t === MSG.Event) this.emit('event', msg._i, msg._c ?? {});
    else if (msg._t === MSG.Response) {
      const waiter = this.#waiting.get(msg._x);
      if (!waiter) return;
      this.#waiting.delete(msg._x);
      clearTimeout(waiter.timer);
      if (msg._em != null) waiter.reject(linkError('refused', `The Apple TV said no (${msg._em})`));
      else waiter.resolve(msg);
    }
  }

  send(type, message) {
    if (this.#closed || !this.#socket) throw linkError('offline', 'Not connected to that Apple TV');
    if (message._x == null) message._x = this.#xid++;
    let payload = opack.pack(message);
    const sealed = this.#cipher && payload.length;
    const head = header(type, payload.length + (sealed ? TAG : 0));
    if (sealed) payload = this.#cipher.seal(payload, head);
    this.#socket.write(Buffer.concat([head, payload]));
  }

  // A pairing/verify message; the answer is the next PS_Next/PV_Next frame.
  auth(type, message, timeout = this.timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#auth = null;
        reject(linkError('timeout', 'The Apple TV took too long to answer'));
      }, timeout);
      timer.unref?.();
      this.#auth = { resolve, reject, timer };
      try {
        this.send(type, message);
      } catch (err) {
        clearTimeout(timer);
        this.#auth = null;
        reject(err);
      }
    });
  }

  request(id, content = {}, timeout = this.timeout) {
    const xid = this.#xid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(xid);
        reject(linkError('timeout', 'The Apple TV took too long to answer'));
      }, timeout);
      timer.unref?.();
      this.#waiting.set(xid, { resolve, reject, timer });
      try {
        this.send(FRAME.E_OPACK, { _i: id, _t: MSG.Request, _c: content, _x: xid });
      } catch (err) {
        this.#waiting.delete(xid);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  event(id, content = {}) {
    this.send(FRAME.E_OPACK, { _i: id, _t: MSG.Event, _c: content });
  }

  close(err) {
    if (this.#closed) return;
    this.#closed = true;
    const gone = () => linkError('offline', 'The Apple TV connection closed');
    if (this.#auth) {
      clearTimeout(this.#auth.timer);
      this.#auth.reject(gone());
      this.#auth = null;
    }
    for (const w of this.#waiting.values()) {
      clearTimeout(w.timer);
      w.reject(gone());
    }
    this.#waiting.clear();
    try {
      this.#socket?.destroy();
    } catch {
      // already gone
    }
    this.emit('close', err);
  }
}
