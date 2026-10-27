// TLV8, the HomeKit pairing container: tag, length (0-255), value. A value
// longer than 255 bytes is split into consecutive items with the same tag,
// which a reader joins back together (SRP public keys are 384 bytes).
export const TLV = {
  Method: 0x00,
  Identifier: 0x01,
  Salt: 0x02,
  PublicKey: 0x03,
  Proof: 0x04,
  EncryptedData: 0x05,
  SeqNo: 0x06,
  Error: 0x07,
  BackOff: 0x08,
  Signature: 0x0a,
  Name: 0x11,
};
export const TLV_ERROR = { Unknown: 1, Authentication: 2, BackOff: 3, MaxPeers: 4, MaxTries: 5, Unavailable: 6, Busy: 7 };

// items: [[tag, bytes | number], …] in order (a number is one byte).
export function encode(items) {
  const out = [];
  for (const [tag, raw] of items) {
    const value = typeof raw === 'number' ? Buffer.from([raw]) : Buffer.from(raw);
    for (let at = 0; at < value.length; at += 255) {
      const chunk = value.subarray(at, at + 255);
      out.push(Buffer.from([tag, chunk.length]), chunk);
    }
  }
  return Buffer.concat(out);
}

// → Map(tag → Buffer). A repeated tag is joined onto the earlier value, as
// pyatv's read_tlv does (pairing messages never repeat a tag otherwise).
export function decode(data) {
  const buf = Buffer.from(data);
  const map = new Map();
  let at = 0;
  while (at < buf.length) {
    if (at + 2 > buf.length) throw new RangeError('TLV8 ends early');
    const tag = buf[at];
    const len = buf[at + 1];
    if (at + 2 + len > buf.length) throw new RangeError('TLV8 ends early');
    const value = buf.subarray(at + 2, at + 2 + len);
    map.set(tag, map.has(tag) ? Buffer.concat([map.get(tag), value]) : Buffer.from(value));
    at += 2 + len;
  }
  return map;
}
