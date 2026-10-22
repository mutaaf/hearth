import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { HearthError } from './errors.js';
import { queue, readJson, writeJson } from './jsonfile.js';
import { hearthHome } from './store.js';

// Who's in the house. Being on the Wi-Fi isn't enough to work the TVs: a
// phone joins once, with the 6-digit house code or an invite (QR / link) from
// a phone that's already in, and from then on carries a device token (an
// HttpOnly cookie; the native app will send it as x-hearth-device).
//
//  - Tokens are stored hashed: household.json alone can't be replayed.
//  - Invites are one-time and expire after a day.
//  - Wrong codes are rate limited per client, and after too many misses in an
//    hour from anyone, typing a code stops working for a while (invites still
//    do), so 6 digits can't be brute-forced from the Wi-Fi.
//  - The house code and tokens are never logged.

export const COOKIE = 'hearth_device';
const INVITE_MS = 24 * 3600_000;
const MAX_DEVICES = 200;
const GLOBAL_MISSES = 20; // per hour, from anyone
const SEEN_SAVE_MS = 10 * 60_000; // lastSeen is saved at most this often per phone

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const newToken = () => randomBytes(32).toString('base64url');
const newId = () => randomBytes(6).toString('hex');

// "iPhone · Safari": enough to tell phones apart in the list, nothing more.
export function deviceName(ua = '') {
  const s = String(ua);
  const kind = /iPad/.test(s) ? 'iPad' : /iPhone|iPod/.test(s) ? 'iPhone' : /Android/.test(s) ? (/Mobile/.test(s) ? 'Android phone' : 'Android tablet')
    : /Macintosh/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows PC' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : 'Device';
  const app = /Edg\//.test(s) ? 'Edge' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : '';
  return app ? `${kind} · ${app}` : kind;
}

const cleanName = (name, ua) => String(name ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || deviceName(ua);

export function cookieOf(req) {
  const m = String(req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]{20,100})`));
  return m?.[1] ?? null;
}

export class Household {
  constructor({ dir = hearthHome(), now = Date.now } = {}) {
    this.file = path.join(dir, 'household.json');
    this.now = now;
    this.data = null;
    this.save = queue();
    this.misses = []; // times of wrong codes (all clients), for the hourly cap
    this.listeners = new Set();
  }

  async init() {
    const pick = (d) => (d && typeof d.code === 'string' && Array.isArray(d.devices) ? d : undefined);
    this.data = await readJson(this.file, pick, null);
    if (!this.data) {
      this.data = { code: newCode(), devices: [], invites: [] };
      await this.#write();
    }
    this.data.invites ??= [];
    return this;
  }

  #write() {
    const snapshot = JSON.parse(JSON.stringify(this.data));
    return this.save(() => writeJson(this.file, snapshot));
  }

  get code() {
    return this.data.code;
  }

  // Tell the server when a phone is removed, so its live stream is cut.
  on(_event, fn) {
    this.listeners.add(fn);
  }

  // → the device this request comes from, or null.
  identify(req) {
    const token = cookieOf(req) ?? (typeof req.headers['x-hearth-device'] === 'string' ? req.headers['x-hearth-device'] : null);
    if (!token) return null;
    const h = sha(token);
    const d = this.data.devices.find((x) => same(x.hash, h));
    if (!d) return null;
    const t = this.now();
    if (t - (d.savedSeen ?? 0) > SEEN_SAVE_MS) {
      d.lastSeen = d.savedSeen = t;
      this.#write().catch(() => {});
    } else d.lastSeen = t;
    return d;
  }

  // Join with { code } or { invite }. → { token, device }. Throws 403/429.
  async join({ code, invite, name, ua } = {}) {
    const t = this.now();
    this.data.invites = this.data.invites.filter((i) => i.expires > t);
    let via = null;
    if (invite) {
      const h = sha(invite);
      const i = this.data.invites.find((x) => same(x.hash, h));
      if (!i) throw new HearthError(403, 'That invite has expired or was already used. Ask for a new one.');
      this.data.invites = this.data.invites.filter((x) => x !== i);
      via = 'invite';
    } else {
      this.misses = this.misses.filter((m) => t - m < 3600_000);
      if (this.misses.length >= GLOBAL_MISSES) {
        throw new HearthError(429, 'Too many wrong codes. Scan an invite from a phone that’s already in, or try again in an hour.');
      }
      const typed = String(code ?? '').replace(/\D/g, '');
      if (typed.length !== 6 || !same(typed, this.data.code)) {
        this.misses.push(t);
        throw new HearthError(403, 'That’s not the house code.');
      }
      via = 'code';
    }
    const token = newToken();
    const device = { id: newId(), name: cleanName(name, ua), hash: sha(token), addedAt: t, lastSeen: t, savedSeen: t, via };
    this.data.devices.push(device);
    // A house with hundreds of phones is a script, not a family: drop the stalest.
    if (this.data.devices.length > MAX_DEVICES) {
      this.data.devices.sort((a, b) => b.lastSeen - a.lastSeen);
      this.data.devices.length = MAX_DEVICES;
    }
    await this.#write();
    return { token, device: this.view(device) };
  }

  async invite() {
    const t = this.now();
    const token = newToken();
    this.data.invites = this.data.invites.filter((i) => i.expires > t).slice(-19);
    this.data.invites.push({ hash: sha(token), expires: t + INVITE_MS });
    await this.#write();
    return { token, expiresAt: t + INVITE_MS };
  }

  view(d, currentId = null) {
    return { id: d.id, name: d.name, addedAt: d.addedAt, lastSeen: d.lastSeen, current: d.id === currentId };
  }

  devices(currentId = null) {
    return [...this.data.devices].sort((a, b) => b.lastSeen - a.lastSeen).map((d) => this.view(d, currentId));
  }

  async rename(id, name) {
    const d = this.data.devices.find((x) => x.id === id);
    if (!d) throw new HearthError(404, 'That phone isn’t in the house');
    d.name = cleanName(name);
    await this.#write();
    return this.view(d);
  }

  async revoke(id) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    if (this.data.devices.length === before) throw new HearthError(404, 'That phone isn’t in the house');
    await this.#write();
    for (const fn of this.listeners) fn(id);
    return { ok: true };
  }

  // A new house code: phones already in stay in; only joining changes.
  async setCode(code) {
    const next = code == null ? newCode() : String(code).replace(/\D/g, '');
    if (next.length !== 6) throw new HearthError(400, 'The house code is 6 digits');
    this.data.code = next;
    this.misses = [];
    await this.#write();
    return { code: next };
  }
}
