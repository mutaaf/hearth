// Binary property lists ("bplist00"), as much as AirPlay needs: dicts,
// arrays, strings, integers, reals, booleans, data and null. The writer lays
// objects out the way Python's plistlib does (keys sorted, equal scalars
// shared, smallest sizes), so what Hearth sends matches pyatv byte for byte.
// The reader refuses anything that would loop or run past its input.

const MAX_OBJECTS = 100_000;
const MAX_DEPTH = 32;

// A real (float) that happens to be whole: plain JS numbers that are whole
// are written as integers.
export class Real {
  constructor(value) {
    this.value = value;
  }
}
export const real = (n) => new Real(n);

const isDict = (v) => v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Uint8Array) && !(v instanceof Real) && !(v instanceof Map);
const isScalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean' || Buffer.isBuffer(v) || v instanceof Uint8Array || v instanceof Real;

// plistlib dedups scalars by (type, value): True and 1 stay apart.
function scalarKey(v) {
  if (typeof v === 'string') return `s:${v}`;
  if (typeof v === 'boolean') return `b:${v}`;
  if (v instanceof Real) return `r:${v.value}`;
  if (typeof v === 'number' && !Number.isInteger(v)) return `r:${v}`;
  if (typeof v === 'number' || typeof v === 'bigint') return `i:${BigInt(v)}`;
  return `d:${Buffer.from(v).toString('hex')}`;
}

const sizeFor = (count) => (count < 1 << 8 ? 1 : count < 1 << 16 ? 2 : count < 2 ** 32 ? 4 : 8);

function uint(n, size) {
  const b = Buffer.alloc(size);
  if (size === 8) b.writeBigUInt64BE(BigInt(n));
  else b.writeUIntBE(Number(n), 0, size);
  return b;
}

function token(kind, size) {
  if (size < 15) return Buffer.from([kind | size]);
  if (size < 1 << 8) return Buffer.from([kind | 0xf, 0x10, size]);
  if (size < 1 << 16) return Buffer.concat([Buffer.from([kind | 0xf, 0x11]), uint(size, 2)]);
  if (size < 2 ** 32) return Buffer.concat([Buffer.from([kind | 0xf, 0x12]), uint(size, 4)]);
  return Buffer.concat([Buffer.from([kind | 0xf, 0x13]), uint(size, 8)]);
}

const entries = (dict) => Object.entries(dict).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export function encode(root) {
  const objects = [];
  const scalars = new Map();
  const ids = new Map();
  const flatten = (v) => {
    if (isScalar(v)) {
      const key = scalarKey(v);
      if (scalars.has(key)) return;
      scalars.set(key, objects.length);
    } else {
      if (ids.has(v)) return;
      ids.set(v, objects.length);
    }
    objects.push(v);
    if (isDict(v)) {
      const items = entries(v);
      for (const [k] of items) flatten(k);
      for (const [, val] of items) flatten(val);
    } else if (Array.isArray(v)) {
      for (const o of v) flatten(o);
    }
  };
  flatten(root);
  const refSize = sizeFor(objects.length);
  const ref = (v) => uint(isScalar(v) ? scalars.get(scalarKey(v)) : ids.get(v), refSize);

  const parts = [Buffer.from('bplist00', 'latin1')];
  let at = 8;
  const offsets = [];
  const put = (b) => {
    parts.push(b);
    at += b.length;
  };
  for (const v of objects) {
    offsets.push(at);
    if (v === null) put(Buffer.from([0x00]));
    else if (v === false) put(Buffer.from([0x08]));
    else if (v === true) put(Buffer.from([0x09]));
    else if (v instanceof Real || (typeof v === 'number' && !Number.isInteger(v))) {
      const b = Buffer.alloc(9);
      b[0] = 0x23;
      b.writeDoubleBE(v instanceof Real ? v.value : v, 1);
      put(b);
    } else if (typeof v === 'number' || typeof v === 'bigint') {
      const n = BigInt(v);
      if (n < 0n) {
        const b = Buffer.alloc(9);
        b[0] = 0x13;
        b.writeBigInt64BE(n, 1);
        put(b);
      } else if (n < 1n << 8n) put(Buffer.concat([Buffer.from([0x10]), uint(n, 1)]));
      else if (n < 1n << 16n) put(Buffer.concat([Buffer.from([0x11]), uint(n, 2)]));
      else if (n < 1n << 32n) put(Buffer.concat([Buffer.from([0x12]), uint(n, 4)]));
      else if (n < 1n << 63n) put(Buffer.concat([Buffer.from([0x13]), uint(n, 8)]));
      else if (n < 1n << 64n) put(Buffer.concat([Buffer.from([0x14]), Buffer.alloc(8), uint(n, 8)]));
      else throw new RangeError('integer too large for a plist');
    } else if (Buffer.isBuffer(v) || v instanceof Uint8Array) put(Buffer.concat([token(0x40, v.length), Buffer.from(v)]));
    else if (typeof v === 'string') {
      if (/^[\x00-\x7f]*$/.test(v)) put(Buffer.concat([token(0x50, v.length), Buffer.from(v, 'latin1')]));
      else {
        const le = Buffer.from(v, 'utf16le');
        const be = Buffer.alloc(le.length);
        for (let i = 0; i < le.length; i += 2) [be[i], be[i + 1]] = [le[i + 1], le[i]];
        put(Buffer.concat([token(0x60, be.length / 2), be]));
      }
    } else if (Array.isArray(v)) put(Buffer.concat([token(0xa0, v.length), ...v.map(ref)]));
    else if (isDict(v)) {
      const items = entries(v);
      put(Buffer.concat([token(0xd0, items.length), ...items.map(([k]) => ref(k)), ...items.map(([, val]) => ref(val))]));
    } else throw new TypeError(`can't put ${typeof v} in a plist`);
  }
  const tableAt = at;
  const offsetSize = sizeFor(tableAt);
  for (const o of offsets) put(uint(o, offsetSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(tableAt), 24);
  put(trailer);
  return Buffer.concat(parts);
}

// → the root object; dicts are plain objects, data is a Buffer, integers
// past 2^53 are BigInts. Throws on anything malformed.
export function decode(input) {
  const buf = Buffer.from(input);
  if (buf.length < 40 || buf.toString('latin1', 0, 8) !== 'bplist00') throw new TypeError('not a binary plist');
  const t = buf.subarray(buf.length - 32);
  const offsetSize = t[6];
  const refSize = t[7];
  const count = Number(t.readBigUInt64BE(8));
  const top = Number(t.readBigUInt64BE(16));
  const tableAt = Number(t.readBigUInt64BE(24));
  if (![1, 2, 4, 8].includes(offsetSize) || ![1, 2, 4, 8].includes(refSize)) throw new TypeError('bad plist trailer');
  if (count > MAX_OBJECTS || top >= count || tableAt + count * offsetSize > buf.length - 32) throw new RangeError('bad plist trailer');
  const readUint = (at, size) => {
    if (at + size > buf.length - 32) throw new RangeError('plist ends early');
    return size === 8 ? Number(buf.readBigUInt64BE(at)) : buf.readUIntBE(at, size);
  };
  const offsetOf = (i) => {
    if (i >= count) throw new RangeError('bad plist reference');
    return readUint(tableAt + i * offsetSize, offsetSize);
  };
  const lengthAt = (at) => {
    const low = buf[at] & 0xf;
    if (low !== 0xf) return [low, at + 1];
    const marker = buf[at + 1];
    if ((marker & 0xf0) !== 0x10) throw new TypeError('bad plist length');
    const size = 1 << (marker & 0xf);
    return [readUint(at + 2, size), at + 2 + size];
  };
  const read = (i, depth) => {
    if (depth > MAX_DEPTH) throw new RangeError('plist nested too deep');
    const at = offsetOf(i);
    if (at >= buf.length - 32) throw new RangeError('bad plist offset');
    const marker = buf[at];
    const kind = marker & 0xf0;
    if (marker === 0x00) return null;
    if (marker === 0x08) return false;
    if (marker === 0x09) return true;
    if (kind === 0x10) {
      const size = 1 << (marker & 0xf);
      if (size === 16) return small(BigInt.asIntN(128, BigInt(`0x${slice(at + 1, 16).toString('hex')}`)));
      if (at + 1 + size > buf.length - 32) throw new RangeError('plist ends early');
      if (size === 8) return small(buf.readBigInt64BE(at + 1));
      return buf.readUIntBE(at + 1, size);
    }
    if (marker === 0x22) return buf.readFloatBE(at + 1);
    if (marker === 0x23 || marker === 0x33) return buf.readDoubleBE(at + 1);
    if (kind === 0x80) return readUint(at + 1, (marker & 0xf) + 1); // UID
    const [len, start] = lengthAt(at);
    if (kind === 0x40) return Buffer.from(slice(start, len));
    if (kind === 0x50) return slice(start, len).toString('latin1');
    if (kind === 0x60) {
      const be = slice(start, len * 2);
      const le = Buffer.alloc(be.length);
      for (let j = 0; j < be.length; j += 2) [le[j], le[j + 1]] = [be[j + 1], be[j]];
      return le.toString('utf16le');
    }
    if (kind === 0xa0) return Array.from({ length: len }, (_, j) => read(readUint(start + j * refSize, refSize), depth + 1));
    if (kind === 0xd0) {
      const out = {};
      for (let j = 0; j < len; j++) {
        const k = read(readUint(start + j * refSize, refSize), depth + 1);
        out[String(k)] = read(readUint(start + (len + j) * refSize, refSize), depth + 1);
      }
      return out;
    }
    throw new TypeError(`unknown plist object 0x${marker.toString(16)}`);
  };
  const slice = (start, len) => {
    if (start + len > buf.length - 32) throw new RangeError('plist ends early');
    return buf.subarray(start, start + len);
  };
  return read(top, 0);
}

const small = (n) => (n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n);
