import { sha512 } from '@noble/hashes/sha2.js';

// SRP-6a as HomeKit pair-setup uses it: the RFC 5054 3072-bit group, g = 5,
// SHA-512, username "Pair-Setup", password = the 4 digits on the TV.
// Byte layout follows srptools (what pyatv uses against real Apple TVs):
// k and u hash the padded values; x, M1 and M2 hash numbers in their
// shortest big-endian form and the salt as raw bytes.
const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA6' +
  '3B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F2411' +
  '7C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08' +
  'CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D' +
  '04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D8760273' +
  '3EC86A64521F2B18177B200CBBE117577A615D6C770988C0BAD946E208E24FA074E5AB31' +
  '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';
export const N = BigInt(`0x${N_HEX}`);
export const g = 5n;
const N_BYTES = N_HEX.length / 2; // 384
export const USERNAME = 'Pair-Setup';

export const toInt = (bytes) => (bytes.length ? BigInt(`0x${Buffer.from(bytes).toString('hex')}`) : 0n);
export function toBytes(n) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, 'hex');
}
const pad = (n) => {
  const b = toBytes(n);
  return Buffer.concat([Buffer.alloc(N_BYTES - b.length), b]);
};
const H = (...parts) => Buffer.from(sha512(Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : typeof p === 'bigint' ? toBytes(p) : Buffer.from(p))))));
const Hn = (...parts) => toInt(H(...parts));
const mod = (a, m = N) => ((a % m) + m) % m;

export function modPow(base, exp, m = N) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

const k = Hn(N, pad(g));
const x = (salt, password) => Hn(salt, H(`${USERNAME}:${password}`));
const proof = (salt, A, B, K) => H(Hn(N) ^ Hn(g), Hn(USERNAME), salt, A, B, K);

// Client side. a: 32+ random bytes. → { A, M1, K, M2 } (M2 = what the
// server must answer, proving it knew the PIN too).
export function client({ password, salt, B: Bbytes, a: aBytes }) {
  const a = toInt(aBytes);
  const B = toInt(Bbytes);
  if (mod(B) === 0n) throw new Error('SRP: bad server key');
  const A = modPow(g, a);
  const u = Hn(pad(A), pad(B));
  if (u === 0n) throw new Error('SRP: bad server key');
  const xv = x(salt, password);
  const S = modPow(B - k * modPow(g, xv), a + u * xv);
  const K = H(S);
  const M1 = proof(salt, A, B, K);
  return { A: toBytes(A), M1, K, M2: H(A, M1, K) };
}

// Server side (the test's pretend Apple TV): v from the PIN, b random.
export function verifier(salt, password) {
  return modPow(g, x(salt, password));
}
export function server({ salt, v, b: bBytes }) {
  const b = toInt(bBytes);
  const B = mod(k * v + modPow(g, b));
  return {
    B: toBytes(B),
    // → { K, M2 } when the client's M1 checks out, else null (wrong PIN)
    finish(Abytes, M1) {
      const A = toInt(Abytes);
      if (mod(A) === 0n) return null;
      const u = Hn(pad(A), pad(B));
      const K = H(modPow(A * modPow(v, u), b));
      const expected = proof(salt, A, B, K);
      if (!expected.equals(Buffer.from(M1))) return null;
      return { K, M2: H(A, expected, K) };
    },
  };
}
