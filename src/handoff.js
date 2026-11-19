// "Share this house": a family member's phone gets every paired TV (pairing
// keys included) and the scenes, with no Allow prompts or codes.
//
// The house is sealed here, on the hub (the phone app's in-app hub, or the
// home server), with XChaCha20-Poly1305 and a fresh random 256-bit key. Only
// the sealed box goes to Hearth Cloud (Worker POST /hearth/api/handoff), which
// keeps it for 24 h or until it's fetched once. The key travels only in the
// invite link's #fragment, which browsers never send to a server:
//
//   https://mutaafaziz.com/hearth/join#<id>.<key>     (QR code, Messages…)
//   hearth://join#<id>.<key>                          (opens the app)
//
// The receiving hub fetches the box (which deletes it), opens it, and shows
// what would change before anything is merged (planImport). The web UI never
// sees a credential: it gets names, rooms, brands and a status per TV.
import { randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { HearthError } from './errors.js';
import { isIPv4, isMac } from './discovery.js';
import { CLOUD } from './llm.js';
import { qrSvg } from './qr.js';

export const SITE = 'https://mutaafaziz.com/hearth';
export const MAX_BOX = 87_400; // base64url characters: about 64 KB sealed
const AAD = Buffer.from('hearth/house/v1', 'utf8');
const PENDING_MS = 30 * 60_000; // an opened invite waits this long for "Bring them over"
const ID_RE = /^[A-Za-z0-9_-]{22}$/; // 128 bits, made by the Worker
const INVITE_RE = /([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;

export const MESSAGES = {
  gone: 'This invite was already used or has expired. Ask them to make a new one.',
  broken: 'This invite doesn’t open. The link may be cut short or changed: ask them for a new one.',
  notInvite: 'That isn’t a Hearth invite. It looks like https://mutaafaziz.com/hearth/join#…',
  nothing: 'Connect a TV first: there’s nothing to share yet.',
  stale: 'That invite timed out on this phone. Ask them for a new one.',
  cloud: 'Couldn’t reach Hearth Cloud. Is the internet up?',
};

// ── the box ──
const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => new Uint8Array(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

export const newKey = () => new Uint8Array(randomBytes(32));
export const keyText = (key) => b64u(key);

// JSON → nonce ‖ ciphertext ‖ tag, as base64url.
export function seal(value, key) {
  const nonce = new Uint8Array(randomBytes(24));
  const ct = xchacha20poly1305(key, nonce, AAD).encrypt(new Uint8Array(Buffer.from(JSON.stringify(value), 'utf8')));
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return b64u(out);
}

// The other way. Anything wrong (a changed byte, a wrong key, a cut link)
// is one plain error, never a stack trace.
export function openBox(box, key) {
  try {
    if (typeof box !== 'string' || !/^[A-Za-z0-9_-]+$/.test(box)) throw new Error('shape');
    const raw = unb64u(box);
    if (raw.length < 24 + 16 || key?.length !== 32) throw new Error('short');
    const pt = xchacha20poly1305(key, raw.subarray(0, 24), AAD).decrypt(raw.subarray(24));
    return JSON.parse(Buffer.from(pt).toString('utf8'));
  } catch {
    throw new HearthError(400, MESSAGES.broken);
  }
}

// ── the invite ──
export const inviteLink = (id, key, site = SITE) => `${site}/join#${id}.${keyText(key)}`;
export const appLink = (id, key) => `hearth://join#${id}.${keyText(key)}`;

// The web link, the hearth:// link, "#house=…" or the bare "<id>.<key>".
export function parseInvite(text) {
  const m = INVITE_RE.exec(String(text ?? ''));
  if (!m) throw new HearthError(400, MESSAGES.notInvite);
  const key = unb64u(m[2]);
  if (key.length !== 32) throw new HearthError(400, MESSAGES.notInvite);
  return { id: m[1], key };
}

// ── what goes, what comes in ──
const json = (v) => JSON.parse(JSON.stringify(v ?? null));
const clean = (s, max = 60) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

// Paired TVs (their whole store record, keys included) and every scene.
export function exportHouse(tvs, scenes = []) {
  return {
    hearth: 'house',
    v: 1,
    at: new Date().toISOString(),
    tvs: tvs.filter((t) => t.credentials).map(json),
    scenes: scenes.map(json),
  };
}

// A TV record from someone else's phone: keep the record, but the fields
// the hub relies on must look right or the TV is left out.
export function sanitizeTv(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  if (typeof t.id !== 'string' || !/^[\w-]{1,80}$/.test(t.id)) return null;
  if (typeof t.brand !== 'string' || !/^[a-z]{2,20}$/.test(t.brand)) return null;
  if (!isIPv4(t.ip)) return null;
  if (!t.credentials || typeof t.credentials !== 'object' || Array.isArray(t.credentials)) return null;
  const tv = json(t);
  tv.name = clean(t.name) || 'TV';
  tv.room = clean(t.room);
  tv.model = clean(t.model);
  tv.macs = (Array.isArray(t.macs) ? t.macs : []).filter(isMac).map((m) => m.toLowerCase()).slice(0, 4);
  if (tv.wakeVia !== undefined && (typeof tv.wakeVia !== 'string' || !/^[\w-]{1,80}$/.test(tv.wakeVia))) delete tv.wakeVia;
  return tv;
}

export function checkHouse(house) {
  if (!house || house.hearth !== 'house' || house.v !== 1 || !Array.isArray(house.tvs)) throw new HearthError(400, MESSAGES.broken);
  return {
    at: typeof house.at === 'string' ? house.at : null,
    tvs: house.tvs.slice(0, 60).map(sanitizeTv).filter(Boolean),
    scenes: Array.isArray(house.scenes) ? house.scenes.slice(0, 60).filter((s) => s && typeof s === 'object') : [],
  };
}

// Which of ours each incoming TV is, and what bringing it over would do.
// A TV is the same TV by id, then a shared MAC, then the Apple TV id, then
// the address (same brand). Statuses:
//   new      not here: added, already paired
//   adopt    here but not paired: it takes their pairing
//   same     here, paired with the same keys: nothing to do
//   have     here and paired with other keys: left alone unless `replace` names it
//   replace  …and they agreed to use the incoming pairing instead
//   skip     left out (`only` didn't pick it), or a brand this hub can't drive
export function planImport(existing, incoming, { replace = [], only = null, supported = null } = {}) {
  const taken = new Set();
  const want = only ? new Set(only) : null;
  const swap = new Set(replace);
  const shares = (a, b) => (a.macs ?? []).some((m) => (b.macs ?? []).includes(String(m).toLowerCase()));
  return incoming.map((inc) => {
    const free = existing.filter((t) => !taken.has(t));
    const match =
      free.find((t) => t.id === inc.id) ??
      free.find((t) => t.brand === inc.brand && shares(t, inc)) ??
      free.find((t) => t.brand === inc.brand && inc.atvId && t.atvId === inc.atvId) ??
      free.find((t) => t.brand === inc.brand && t.ip === inc.ip) ??
      null;
    if (match) taken.add(match);
    let status;
    if (supported && !supported.has(inc.brand)) status = 'skip';
    else if (!match) status = 'new';
    else if (!match.credentials) status = 'adopt';
    else if (JSON.stringify(match.credentials) === JSON.stringify(inc.credentials)) status = 'same';
    else status = swap.has(inc.id) ? 'replace' : 'have';
    const reason = supported && !supported.has(inc.brand) ? 'unsupported' : null;
    if (want && !want.has(inc.id) && (status === 'new' || status === 'adopt' || status === 'replace')) return { inc, match, status: 'skip', reason: 'not-picked' };
    return { inc, match, status, reason };
  });
}

// What the UI may see of a plan: no keys, no addresses.
export function planView(plan) {
  return plan.map(({ inc, match, status, reason }) => ({
    ref: inc.id,
    name: inc.name,
    room: inc.room ?? '',
    brand: inc.brand,
    model: inc.model ?? '',
    status,
    ...(reason ? { reason } : {}),
    ...(match ? { as: match.name } : {}),
  }));
}

// The hub's side of it: make an invite, open one, bring the TVs in.
export class Handoff {
  #pending = new Map(); // token → { house, at }

  constructor({ hub, cloud = CLOUD, fetchFn = (...a) => fetch(...a), now = () => Date.now(), site = SITE } = {}) {
    this.hub = hub;
    this.cloud = cloud;
    this.fetch = fetchFn;
    this.now = now;
    this.site = site;
  }

  async #call(path, init, timeout) {
    let res;
    try {
      res = await this.fetch(`${this.cloud}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
    } catch {
      throw new HearthError(502, MESSAGES.cloud);
    }
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  // → { link, appLink, expires, tvs, scenes, names, qr }
  async create() {
    const house = this.hub.exportHouse();
    if (!house.tvs.length) throw new HearthError(409, MESSAGES.nothing);
    const key = newKey();
    const box = seal(house, key);
    if (box.length > MAX_BOX) throw new HearthError(413, 'That’s more than one invite can carry. Share fewer scenes, or ask us for help.');
    const { res, data } = await this.#call('/handoff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ box }) }, 20_000);
    if (!res.ok || !ID_RE.test(data.id ?? '')) throw new HearthError(res.status === 429 ? 429 : 502, data.error || `Hearth Cloud said ${res.status}`);
    const link = inviteLink(data.id, key, this.site);
    return {
      link,
      appLink: appLink(data.id, key),
      expires: data.expires ?? null,
      tvs: house.tvs.length,
      scenes: house.scenes.length,
      names: house.tvs.map((t) => t.name),
      qr: qrSvg(link, { margin: 1 }),
    };
  }

  #sweep() {
    for (const [token, p] of this.#pending) if (this.now() - p.at > PENDING_MS) this.#pending.delete(token);
  }

  // Fetch (which uses it up), open, and say what it would do. → preview()
  async open(invite) {
    const { id, key } = parseInvite(invite);
    const { res, data } = await this.#call(`/handoff/${id}`, { method: 'GET' }, 15_000);
    if (res.status === 404 || res.status === 410) throw new HearthError(410, MESSAGES.gone);
    if (!res.ok) throw new HearthError(res.status === 429 ? 429 : 502, data.error || `Hearth Cloud said ${res.status}`);
    const house = checkHouse(openBox(data.box, key));
    this.#sweep();
    const token = Buffer.from(randomBytes(16)).toString('hex');
    this.#pending.set(token, { house, at: this.now() });
    return this.preview(token);
  }

  #get(token) {
    this.#sweep();
    const p = this.#pending.get(String(token ?? ''));
    if (!p) throw new HearthError(410, MESSAGES.stale);
    return p;
  }

  // → { token, tvs: [{ ref, name, room, brand, model, status, as? }], scenes, from }
  preview(token, opts = {}) {
    const { house } = this.#get(token);
    return { token, tvs: planView(this.hub.planHouse(house, opts)), scenes: house.scenes.length, from: house.at };
  }

  // How many TVs bringing them over would add (the phone app's room check).
  adds(token, opts = {}) {
    return this.hub.planHouse(this.#get(token).house, opts).filter((p) => p.status === 'new').length;
  }

  // → { added, updated, kept, skipped, scenes }
  async accept(token, opts = {}) {
    const { house } = this.#get(token);
    const result = await this.hub.importHouse(house, opts);
    this.#pending.delete(token);
    return result;
  }

  forget(token) {
    this.#pending.delete(String(token ?? ''));
    return { ok: true };
  }
}
