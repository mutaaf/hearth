// Just enough protobuf for the Android TV remote protocol and Apple's MRP:
// varints, length-delimited and fixed-width fields, no schema compiler.
// Messages are written as { fieldNumber: value } where a value is a number
// (varint), a string or Buffer (bytes), a Fixed (double()/float()), a nested
// object (sub-message) or an array of those.

// A 64-bit double or 32-bit float field (wire types 1 and 5).
export class Fixed {
  constructor(bytes) {
    this.bytes = bytes;
  }
}
export function double(n) {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return new Fixed(b);
}
export function float(n) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n);
  return new Fixed(b);
}
// A decoded fixed field (a Buffer of 4 or 8 bytes) → number.
export const fixedNumber = (v) => (Buffer.isBuffer(v) && v.length === 8 ? v.readDoubleLE(0) : Buffer.isBuffer(v) && v.length === 4 ? v.readFloatLE(0) : null);

export function varint(n) {
  const out = [];
  let v = Math.floor(n);
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

function readVarint(buf, pos) {
  let result = 0;
  let mul = 1;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    result += (b & 0x7f) * mul;
    if (b < 128) return { value: result, pos };
    mul *= 128;
  }
}

export function encode(msg) {
  const parts = [];
  for (const [key, raw] of Object.entries(msg)) {
    const num = Number(key);
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      if (value === undefined || value === null) continue;
      if (value instanceof Fixed) {
        parts.push(varint(num * 8 + (value.bytes.length === 8 ? 1 : 5)), value.bytes);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        parts.push(varint(num * 8), varint(Number(value)));
      } else {
        const bytes = Buffer.isBuffer(value) ? value : typeof value === 'string' ? Buffer.from(value) : encode(value);
        parts.push(varint(num * 8 + 2), varint(bytes.length), bytes);
      }
    }
  }
  return Buffer.concat(parts);
}

// → { fieldNumber: [values] }; varints become numbers, everything
// length-delimited stays a Buffer (call decode() again for sub-messages), and
// fixed-width fields stay 8- or 4-byte Buffers (fixedNumber() reads them).
// A truncated field ends the message there.
export function decode(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    const key = readVarint(buf, pos);
    if (!key) break;
    pos = key.pos;
    const num = Math.floor(key.value / 8);
    const wire = key.value % 8;
    let value;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      if (!v) break;
      value = v.value;
      pos = v.pos;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      if (!len) break;
      if (len.pos + len.value > buf.length) break;
      value = buf.subarray(len.pos, len.pos + len.value);
      pos = len.pos + len.value;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (pos + size > buf.length) break;
      value = buf.subarray(pos, pos + size);
      pos += size;
    } else {
      break;
    }
    (out[num] ??= []).push(value);
  }
  return out;
}

// Each message on the wire is prefixed with its length as a varint.
export const frame = (msg) => {
  const body = Buffer.isBuffer(msg) ? msg : encode(msg);
  return Buffer.concat([varint(body.length), body]);
};

// Pull complete frames off a growing buffer: returns [messages, leftover].
export function unframe(buf) {
  const msgs = [];
  let pos = 0;
  for (;;) {
    const len = readVarint(buf, pos);
    if (!len || len.pos + len.value > buf.length) break;
    msgs.push(buf.subarray(len.pos, len.pos + len.value));
    pos = len.pos + len.value;
  }
  return [msgs, buf.subarray(pos)];
}

// Convenience readers for decoded messages.
export const first = (m, n) => m?.[n]?.[0];
export const sub = (m, n) => (m?.[n]?.[0] ? decode(m[n][0]) : null);
export const str = (m, n) => (m?.[n]?.[0] ? m[n][0].toString() : null);
