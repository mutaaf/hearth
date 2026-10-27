// OPACK, Apple's compact binary format for Companion messages (pyatv's
// support/opack.py is the reference; its test vectors are in
// test/appletv-js.test.js). Values map to JS like this:
//   null 0x04 · true 0x01 · false 0x02 · integer 0x08-0x2F / 0x30-0x33 (LE)
//   float(x) / non-integer number 0x36 (float64; 0x35 float32 decodes)
//   string 0x40-0x64 · Buffer/Uint8Array 0x70-0x94 · array 0xD0-0xDF
//   object or Map 0xE0-0xEF · Uuid 0x05 · absolute time 0x06 decodes as a number
// Repeated strings, data and sized numbers are sent once and then referenced
// by index (0xA0-0xC0, then 0xC1-0xC4 + a 1-4 byte index). An entry is in that table when its
// encoding is longer than one byte and it isn't a list or dict, on both
// sides, so what we pack always unpacks to the same thing.

// A number that must go out as a float even when it's whole (pyatv sends
// _skpS: -10.0; a JS -10 would be an integer, and negatives can't be).
export class Float {
  constructor(value) {
    this.value = Number(value);
  }
}
export const float = (v) => new Float(v);

export class Uuid {
  constructor(bytes) {
    this.bytes = Buffer.from(bytes);
  }
  toString() {
    const h = this.bytes.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

const le = (n, size) => {
  const b = Buffer.alloc(size);
  let v = BigInt(n);
  for (let i = 0; i < size; i++, v >>= 8n) b[i] = Number(v & 0xffn);
  return b;
};
const readLe = (buf, at, size) => {
  let v = 0n;
  for (let i = size - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[at + i]);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
};
const isBytes = (v) => Buffer.isBuffer(v) || v instanceof Uint8Array;

function sized(lengths, short, base, len) {
  // short: one tag byte holds the length up to `short`; then base+1.. with a 1/2/3-4/8 byte length
  if (len <= short) return Buffer.from([base + len]);
  for (const [tag, size, max] of lengths) if (len <= max) return Buffer.concat([Buffer.from([tag]), le(len, size)]);
  throw new RangeError('OPACK value too long');
}
const STR_LEN = [[0x61, 1, 0xff], [0x62, 2, 0xffff], [0x63, 3, 0xffffff], [0x64, 4, 0xffffffff]];
const DATA_LEN = [[0x91, 1, 0xff], [0x92, 2, 0xffff], [0x93, 4, 0xffffffff]];

function packInt(n) {
  if (n < 0) throw new TypeError('OPACK has no negative integers (send a float)');
  if (n < 0x28) return Buffer.from([0x08 + Number(n)]);
  for (const [tag, size] of [[0x30, 1], [0x31, 2], [0x32, 4], [0x33, 8]]) {
    if (BigInt(n) < 1n << BigInt(size * 8)) return Buffer.concat([Buffer.from([tag]), le(n, size)]);
  }
  throw new RangeError('OPACK integer too large');
}

function packOne(v, table) {
  let out;
  let container = false;
  if (v === null || v === undefined) out = Buffer.from([0x04]);
  else if (v === true) out = Buffer.from([0x01]);
  else if (v === false) out = Buffer.from([0x02]);
  else if (v instanceof Uuid) out = Buffer.concat([Buffer.from([0x05]), v.bytes]);
  else if (v instanceof Float || (typeof v === 'number' && !Number.isInteger(v))) {
    out = Buffer.alloc(9);
    out[0] = 0x36;
    out.writeDoubleLE(v instanceof Float ? v.value : v, 1);
  } else if (typeof v === 'number' || typeof v === 'bigint') out = packInt(v);
  else if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    out = Buffer.concat([sized(STR_LEN, 0x20, 0x40, s.length), s]);
  } else if (isBytes(v)) {
    const b = Buffer.from(v);
    out = Buffer.concat([sized(DATA_LEN, 0x20, 0x70, b.length), b]);
  } else if (Array.isArray(v)) {
    container = true;
    const parts = v.map((x) => packOne(x, table));
    out = Buffer.concat([Buffer.from([0xd0 + Math.min(v.length, 0xf)]), ...parts, v.length >= 0xf ? Buffer.from([0x03]) : Buffer.alloc(0)]);
  } else if (typeof v === 'object') {
    container = true;
    const entries = v instanceof Map ? [...v] : Object.entries(v);
    const parts = entries.flatMap(([k, x]) => [packOne(k, table), packOne(x, table)]);
    out = Buffer.concat([Buffer.from([0xe0 + Math.min(entries.length, 0xf)]), ...parts, entries.length >= 0xf ? Buffer.from([0x03]) : Buffer.alloc(0)]);
  } else throw new TypeError(`OPACK can't pack ${typeof v}`);

  if (container || out.length <= 1) return out;
  const key = out.toString('latin1');
  const index = table.get(key);
  if (index === undefined) {
    table.set(key, table.size);
    return out;
  }
  if (index < 0x21) return Buffer.from([0xa0 + index]);
  for (const [tag, size] of [[0xc1, 1], [0xc2, 2], [0xc3, 3], [0xc4, 4]]) {
    if (index < 2 ** (size * 8)) return Buffer.concat([Buffer.from([tag]), le(index, size)]);
  }
  return out;
}

export function pack(value) {
  return packOne(value, new Map());
}

// → [value, bytes left over]
export function unpack(data) {
  const buf = Buffer.from(data);
  const table = []; // decoded values, by reference index
  const seen = new Set(); // their encodings, so a repeat isn't added twice
  let at = 0;
  const need = (n) => {
    if (at + n > buf.length) throw new RangeError('OPACK data ends early');
  };

  function one() {
    need(1);
    const start = at;
    const tag = buf[at++];
    let value;
    let ref = true;
    if (tag === 0x01 || tag === 0x02 || tag === 0x04) {
      value = tag === 0x01 ? true : tag === 0x02 ? false : null;
      ref = false;
    } else if (tag === 0x05) {
      need(16);
      value = new Uuid(buf.subarray(at, at + 16));
      at += 16;
    } else if (tag === 0x06) {
      need(8);
      value = readLe(buf, at, 8);
      at += 8;
    } else if (tag >= 0x08 && tag <= 0x2f) {
      value = tag - 8;
      ref = false;
    } else if (tag === 0x35) {
      need(4);
      value = buf.readFloatLE(at);
      at += 4;
    } else if (tag === 0x36) {
      need(8);
      value = buf.readDoubleLE(at);
      at += 8;
    } else if (tag >= 0x30 && tag <= 0x33) {
      const size = 2 ** (tag & 0xf);
      need(size);
      value = readLe(buf, at, size);
      at += size;
    } else if (tag >= 0x40 && tag <= 0x64) {
      let len = tag - 0x40;
      if (tag > 0x60) {
        const size = tag & 0xf;
        need(size);
        len = Number(readLe(buf, at, size));
        at += size;
      }
      need(len);
      value = buf.toString('utf8', at, at + len);
      at += len;
    } else if (tag >= 0x70 && tag <= 0x94) {
      let len = tag - 0x70;
      if (tag > 0x90) {
        const size = 1 << ((tag & 0xf) - 1);
        need(size);
        len = Number(readLe(buf, at, size));
        at += size;
      }
      need(len);
      value = Buffer.from(buf.subarray(at, at + len));
      at += len;
    } else if ((tag & 0xf0) === 0xd0) {
      value = [];
      const count = tag & 0xf;
      if (count === 0xf) {
        while ((need(1), buf[at] !== 0x03)) value.push(one());
        at++;
      } else for (let i = 0; i < count; i++) value.push(one());
      ref = false;
    } else if ((tag & 0xf0) === 0xe0) {
      value = {};
      const count = tag & 0xf;
      const entry = () => {
        const k = one();
        value[String(k)] = one();
      };
      if (count === 0xf) {
        while ((need(1), buf[at] !== 0x03)) entry();
        at++;
      } else for (let i = 0; i < count; i++) entry();
      ref = false;
    } else if (tag >= 0xa0 && tag <= 0xc0) {
      return lookup(tag - 0xa0);
    } else if (tag >= 0xc1 && tag <= 0xc4) {
      const size = tag - 0xc0; // 0xC1-0xC4: a 1-4 byte index (pyatv unpack)
      need(size);
      const index = Number(readLe(buf, at, size));
      at += size;
      return lookup(index);
    } else {
      throw new TypeError(`OPACK: unknown tag 0x${tag.toString(16)}`);
    }
    if (ref && at - start > 1) {
      const key = buf.toString('latin1', start, at);
      if (!seen.has(key)) {
        seen.add(key);
        table.push(value);
      }
    }
    return value;
  }

  function lookup(index) {
    if (index >= table.length) throw new RangeError('OPACK reference out of range');
    return table[index];
  }

  const value = one();
  return [value, buf.subarray(at)];
}
