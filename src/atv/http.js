import { EventEmitter } from 'node:events';
import net from 'node:net';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { linkError } from './link.js';

// AirPlay's control connection: HTTP/1.1 and RTSP/1.0 over one raw TCP
// socket (the same injectable `connect` as Companion, so it runs on the
// phone; fetch can't do RTSP or switch to encryption halfway). After
// pair-verify every byte is HAP-framed (pyatv auth/hap_session.py).

export const MAX_HEAD = 16 * 1024;
export const MAX_BODY = 4 * 1024 * 1024;

// ── HAP framing ──────────────────────────────────────────
// Blocks of at most 1024 bytes: [length, 2 bytes LE][ChaCha20-Poly1305 of
// the block, the length as AAD]. The nonce is 4 zero bytes and then a 64-bit
// little-endian counter per direction (pyatv Chacha20Cipher, 8-byte nonce).
// (Companion's SessionCipher puts its counter first instead.)
export class HapFraming {
  static BLOCK = 1024;
  #out = 0n;
  #in = 0n;
  #buf = Buffer.alloc(0);

  constructor(outKey, inKey) {
    this.outKey = outKey;
    this.inKey = inKey;
  }

  static nonce(n) {
    const b = Buffer.alloc(12);
    b.writeBigUInt64LE(n, 4);
    return b;
  }

  encrypt(data) {
    const out = [];
    for (let at = 0; at < data.length; at += HapFraming.BLOCK) {
      const block = data.subarray(at, at + HapFraming.BLOCK);
      const len = Buffer.alloc(2);
      len.writeUInt16LE(block.length);
      out.push(len, Buffer.from(chacha20poly1305(this.outKey, HapFraming.nonce(this.#out++), len).encrypt(block)));
    }
    return Buffer.concat(out);
  }

  // Bytes off the wire → whatever plaintext is complete so far. Throws when
  // a block doesn't authenticate (the caller drops the connection).
  decrypt(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : Buffer.from(chunk);
    const out = [];
    while (this.#buf.length >= 2) {
      const len = this.#buf.readUInt16LE(0);
      if (this.#buf.length < 2 + len + 16) break;
      const sealed = this.#buf.subarray(2, 2 + len + 16);
      out.push(Buffer.from(chacha20poly1305(this.inKey, HapFraming.nonce(this.#in++), this.#buf.subarray(0, 2)).decrypt(sealed)));
      this.#buf = this.#buf.subarray(2 + len + 16);
    }
    return Buffer.concat(out);
  }
}

// ── HTTP-style messages ──────────────────────────────────
export function format(firstLine, headers = {}, body = null) {
  const lines = [firstLine];
  const have = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  if (body?.length && !have.has('content-length')) lines.push(`Content-Length: ${body.length}`);
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && v !== null) lines.push(`${k}: ${v}`);
  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8'), body?.length ? Buffer.from(body) : Buffer.alloc(0)]);
}

// One complete message off the front of buf → { first, headers (lower-case
// keys), body, rest }, or null when more bytes are needed. Throws on a head
// or body over the caps.
export function parse(buf) {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) {
    if (buf.length > MAX_HEAD) throw new RangeError('HTTP head too large');
    return null;
  }
  if (end > MAX_HEAD) throw new RangeError('HTTP head too large');
  const [first, ...lines] = buf.subarray(0, end).toString('utf8').split('\r\n');
  const headers = {};
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const length = Number(headers['content-length'] ?? 0);
  if (!Number.isFinite(length) || length < 0 || length > MAX_BODY) throw new RangeError('HTTP body too large');
  if (buf.length < end + 4 + length) return null;
  return { first, headers, body: buf.subarray(end + 4, end + 4 + length), rest: buf.subarray(end + 4 + length) };
}

export function parseResponse(first) {
  const m = /^([A-Z]+)\/([0-9.]+) (\d{3})(?: (.*))?$/.exec(first);
  if (!m) throw new TypeError(`bad status line: ${first.slice(0, 80)}`);
  return { protocol: m[1], status: Number(m[3]), message: m[4] ?? '' };
}

// One TCP connection that sends requests and reads responses in order (one
// in flight at a time, as pyatv does). 'close' fires once.
export class HttpLink extends EventEmitter {
  #socket = null;
  #buf = Buffer.alloc(0);
  #framing = null;
  #waiting = null; // { resolve, reject, timer }
  #queue = Promise.resolve();
  #closed = false;

  constructor({ host, port, timeout = 5000, connect = net.connect }) {
    super();
    Object.assign(this, { host, port, timeout, connectFn: connect });
  }

  get closed() {
    return this.#closed;
  }

  get localAddress() {
    return this.#socket?.localAddress || '0.0.0.0';
  }

  open({ timeout = this.timeout } = {}) {
    return new Promise((resolve, reject) => {
      const socket = this.connectFn({ host: this.host, port: this.port });
      this.#socket = socket;
      let up = false;
      const timer = setTimeout(() => {
        reject(linkError('offline', 'The Apple TV didn’t answer on AirPlay'));
        this.close();
      }, timeout);
      timer.unref?.();
      socket.on('connect', () => {
        up = true;
        clearTimeout(timer);
        socket.setNoDelay?.(true);
        socket.setKeepAlive?.(true, 15_000);
        resolve(this);
      });
      socket.on('error', (err) => {
        if (!up) {
          clearTimeout(timer);
          reject(Object.assign(linkError('offline', 'The Apple TV didn’t answer on AirPlay'), { cause: err }));
        }
        this.close(err);
      });
      socket.on('close', () => this.close());
      socket.on('data', (chunk) => {
        try {
          this.#onData(chunk);
        } catch (err) {
          this.close(err); // a bad block or message drops this connection only
        }
      });
    });
  }

  // From here on, everything both ways is HAP-framed.
  enableEncryption(outKey, inKey) {
    this.#framing = new HapFraming(outKey, inKey);
  }

  #onData(chunk) {
    const data = this.#framing ? this.#framing.decrypt(chunk) : chunk;
    if (!data.length) return;
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, data]) : Buffer.from(data);
    for (;;) {
      const msg = parse(this.#buf);
      if (!msg) return;
      this.#buf = Buffer.from(msg.rest);
      const waiter = this.#waiting;
      this.#waiting = null;
      if (!waiter) continue; // nobody asked: ignore it
      clearTimeout(waiter.timer);
      try {
        waiter.resolve({ ...parseResponse(msg.first), headers: msg.headers, body: Buffer.from(msg.body) });
      } catch (err) {
        waiter.reject(err);
      }
    }
  }

  write(bytes) {
    if (this.#closed || !this.#socket) throw linkError('offline', 'Not connected to that Apple TV');
    this.#socket.write(this.#framing ? this.#framing.encrypt(bytes) : bytes);
  }

  // method + uri + protocol → { status, headers, body }. Requests queue up.
  request(method, uri, { protocol = 'HTTP/1.1', headers = {}, body = null, timeout = this.timeout } = {}) {
    const run = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.#waiting?.timer === timer) this.#waiting = null;
          reject(linkError('timeout', 'The Apple TV took too long to answer'));
        }, timeout);
        timer.unref?.();
        this.#waiting = { resolve, reject, timer };
        try {
          this.write(format(`${method} ${uri} ${protocol}`, headers, body));
        } catch (err) {
          clearTimeout(timer);
          this.#waiting = null;
          reject(err);
        }
      });
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => {});
    return p;
  }

  close(err) {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#waiting) {
      clearTimeout(this.#waiting.timer);
      this.#waiting.reject(linkError('offline', 'The Apple TV connection closed'));
      this.#waiting = null;
    }
    try {
      this.#socket?.destroy();
    } catch {
      // already gone
    }
    this.emit('close', err);
  }
}
