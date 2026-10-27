import { randomBytes, randomUUID } from 'node:crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf as nobleHkdf } from '@noble/hashes/hkdf.js';
import { sha512 } from '@noble/hashes/sha2.js';
import * as opack from './opack.js';
import * as srp from './srp.js';
import { decode, encode, TLV, TLV_ERROR } from './tlv8.js';

// HomeKit (HAP) pairing as the Apple TV's Companion service speaks it,
// following pyatv's auth/hap_srp.py. Pair-setup (once, with the PIN) swaps
// long-term Ed25519 keys; pair-verify (every connection) proves both sides
// still hold them and yields the session keys.

const utf8 = (s) => Buffer.from(s, 'utf8');
export const hkdf = (secret, salt, info) => Buffer.from(nobleHkdf(sha512, secret, utf8(salt), utf8(info), 32));

// Pairing messages use a fixed 8-byte label as the nonce ("PS-Msg05"),
// left-padded with four zero bytes to ChaCha20-Poly1305's 12.
const labelNonce = (label) => Buffer.concat([Buffer.alloc(4), utf8(label)]);
export const seal = (key, label, data) => Buffer.from(chacha20poly1305(key, labelNonce(label)).encrypt(data));
export function open(key, label, data) {
  try {
    return Buffer.from(chacha20poly1305(key, labelNonce(label)).decrypt(data));
  } catch {
    throw new PairingError('auth', 'The Apple TV’s reply didn’t decrypt');
  }
}

export class PairingError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'auth' (wrong PIN / keys refused) | 'busy' | 'protocol'
  }
}

// A TLV reply with kTLVError_* in it → a PairingError the driver can explain.
export function checkTlv(data) {
  const tlv = decode(data ?? Buffer.alloc(0));
  const err = tlv.get(TLV.Error);
  if (err) {
    const code = err[0];
    if (code === TLV_ERROR.Authentication) throw new PairingError('auth', 'The Apple TV didn’t accept that code');
    if (code === TLV_ERROR.BackOff || code === TLV_ERROR.MaxTries) throw new PairingError('busy', 'The Apple TV wants a short break before another code');
    if (code === TLV_ERROR.Busy || code === TLV_ERROR.MaxPeers) throw new PairingError('busy', 'The Apple TV is busy pairing with something else');
    throw new PairingError('protocol', `The Apple TV said no (error ${code})`);
  }
  return tlv;
}
const need = (tlv, tag, what) => {
  const v = tlv.get(tag);
  if (!v?.length) throw new PairingError('protocol', `The Apple TV left out the ${what}`);
  return v;
};

// Credentials in pyatv's string form, so a pairing made here also works in
// the Python bridge (and back): hex(ltpk):hex(ltsk):hex(atvId):hex(clientId).
//   ltpk = the Apple TV's Ed25519 public key, ltsk = our Ed25519 seed,
//   atvId = the Apple TV's pairing id, clientId = ours (a UUID string).
export function parseCredentials(str) {
  const parts = String(str ?? '').split(':');
  if (parts.length !== 4 || parts.some((p) => !/^[0-9a-f]+$/i.test(p))) throw new PairingError('auth', 'These Apple TV keys are unreadable; pair it again');
  const [ltpk, ltsk, atvId, clientId] = parts.map((p) => Buffer.from(p, 'hex'));
  if (ltpk.length !== 32 || ltsk.length !== 32) throw new PairingError('auth', 'These Apple TV keys are unreadable; pair it again');
  return { ltpk, ltsk, atvId, clientId };
}
export const formatCredentials = ({ ltpk, ltsk, atvId, clientId }) => [ltpk, ltsk, atvId, clientId].map((b) => Buffer.from(b).toString('hex')).join(':');

// ── pair-setup (client) ───────────────────────────────────
// m1() → [show the PIN] → m3(pin, m2) → m5(m4) → credentials(m6)
export class PairSetup {
  #seed = randomBytes(32);
  #pub = Buffer.from(ed25519.getPublicKey(this.#seed));
  #id = utf8(randomUUID());
  #srp = null;
  #key = null;

  constructor({ name = 'Hearth' } = {}) {
    this.name = name;
  }

  m1() {
    return encode([[TLV.Method, 0], [TLV.SeqNo, 1]]);
  }

  m3(pin, m2) {
    const tlv = checkTlv(m2);
    const salt = need(tlv, TLV.Salt, 'salt');
    const B = need(tlv, TLV.PublicKey, 'public key');
    const password = String(pin).replace(/\D/g, '').padStart(4, '0');
    this.#srp = srp.client({ password, salt, B, a: randomBytes(32) });
    return encode([[TLV.SeqNo, 3], [TLV.PublicKey, this.#srp.A], [TLV.Proof, this.#srp.M1]]);
  }

  m5(m4) {
    const tlv = checkTlv(m4);
    const M2 = need(tlv, TLV.Proof, 'proof');
    // A server that didn't know the PIN can't make this.
    if (!Buffer.from(M2).equals(this.#srp.M2)) throw new PairingError('auth', 'The Apple TV didn’t accept that code');
    const K = this.#srp.K;
    this.#key = hkdf(K, 'Pair-Setup-Encrypt-Salt', 'Pair-Setup-Encrypt-Info');
    const signed = Buffer.concat([hkdf(K, 'Pair-Setup-Controller-Sign-Salt', 'Pair-Setup-Controller-Sign-Info'), this.#id, this.#pub]);
    const inner = encode([
      [TLV.Identifier, this.#id],
      [TLV.PublicKey, this.#pub],
      [TLV.Signature, ed25519.sign(signed, this.#seed)],
      [TLV.Name, opack.pack({ name: this.name })],
    ]);
    return encode([[TLV.SeqNo, 5], [TLV.EncryptedData, seal(this.#key, 'PS-Msg05', inner)]]);
  }

  credentials(m6) {
    const tlv = checkTlv(m6);
    const inner = checkTlv(open(this.#key, 'PS-Msg06', need(tlv, TLV.EncryptedData, 'keys')));
    const atvId = need(inner, TLV.Identifier, 'identifier');
    const ltpk = need(inner, TLV.PublicKey, 'public key');
    const signature = need(inner, TLV.Signature, 'signature');
    // pyatv skips this check; HAP says the accessory signs its id and key.
    const signed = Buffer.concat([hkdf(this.#srp.K, 'Pair-Setup-Accessory-Sign-Salt', 'Pair-Setup-Accessory-Sign-Info'), atvId, ltpk]);
    if (ltpk.length !== 32 || !ed25519.verify(signature, signed, ltpk)) throw new PairingError('auth', 'The Apple TV’s keys didn’t check out');
    return { ltpk, ltsk: this.#seed, atvId, clientId: this.#id };
  }
}

// ── pair-verify (client) ──────────────────────────────────
// m1() → m3(m2) → [server answers seq 4] → sessionKeys()
export class PairVerify {
  #secret = randomBytes(32);
  #pub = Buffer.from(x25519.getPublicKey(this.#secret));
  #shared = null;

  constructor(credentials) {
    this.creds = credentials;
  }

  m1() {
    return encode([[TLV.SeqNo, 1], [TLV.PublicKey, this.#pub]]);
  }

  m3(m2) {
    const tlv = checkTlv(m2);
    const serverPub = need(tlv, TLV.PublicKey, 'public key');
    if (serverPub.length !== 32) throw new PairingError('protocol', 'The Apple TV sent a bad key');
    try {
      this.#shared = Buffer.from(x25519.getSharedSecret(this.#secret, serverPub));
    } catch {
      throw new PairingError('protocol', 'The Apple TV sent a bad key');
    }
    const key = hkdf(this.#shared, 'Pair-Verify-Encrypt-Salt', 'Pair-Verify-Encrypt-Info');
    const inner = checkTlv(open(key, 'PV-Msg02', need(tlv, TLV.EncryptedData, 'proof')));
    const id = need(inner, TLV.Identifier, 'identifier');
    const signature = need(inner, TLV.Signature, 'signature');
    if (!id.equals(this.creds.atvId)) throw new PairingError('auth', 'A different Apple TV answered; pair it again');
    const theirs = Buffer.concat([serverPub, id, this.#pub]);
    if (!ed25519.verify(signature, theirs, this.creds.ltpk)) throw new PairingError('auth', 'The Apple TV’s keys didn’t check out; pair it again');
    const ours = Buffer.concat([this.#pub, this.creds.clientId, serverPub]);
    const reply = encode([[TLV.Identifier, this.creds.clientId], [TLV.Signature, ed25519.sign(ours, this.creds.ltsk)]]);
    return encode([[TLV.SeqNo, 3], [TLV.EncryptedData, seal(key, 'PV-Msg03', reply)]]);
  }

  // Companion's session keys (pyatv companion/protocol.py: salt "",
  // ClientEncrypt-main / ServerEncrypt-main).
  sessionKeys() {
    return {
      output: hkdf(this.#shared, '', 'ClientEncrypt-main'),
      input: hkdf(this.#shared, '', 'ServerEncrypt-main'),
    };
  }
}

// Session encryption after verify: ChaCha20-Poly1305 with a 12-byte
// little-endian counter per direction, the 4-byte frame header as AAD.
export class SessionCipher {
  #out = 0n;
  #in = 0n;
  constructor(outKey, inKey) {
    this.outKey = outKey;
    this.inKey = inKey;
  }
  static nonce(n) {
    const b = Buffer.alloc(12);
    for (let i = 0, v = n; i < 8; i++, v >>= 8n) b[i] = Number(v & 0xffn);
    return b;
  }
  seal(data, aad) {
    return Buffer.from(chacha20poly1305(this.outKey, SessionCipher.nonce(this.#out++), aad).encrypt(data));
  }
  open(data, aad) {
    return Buffer.from(chacha20poly1305(this.inKey, SessionCipher.nonce(this.#in++), aad).decrypt(data));
  }
}
