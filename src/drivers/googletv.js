import tls from 'node:tls';
import { CATALOG } from '../catalog.js';
import { HearthError, offline, unsupported } from '../errors.js';
import { decode, encode, str } from '../proto.js';
import { Driver } from './base.js';

// Google TV / Android TV / Chromecast via Cast (TLS on :8009). No pairing,
// no codes: any phone on the Wi-Fi may cast, so Hearth can too. Cast covers
// volume, mute, launching apps and what's on screen. Arrow keys and power
// live in Google's separate remote protocol, which demands a one-time code
// shown on the TV — deliberately not required here.
const NS = {
  connection: 'urn:x-cast:com.google.cast.tp.connection',
  heartbeat: 'urn:x-cast:com.google.cast.tp.heartbeat',
  receiver: 'urn:x-cast:com.google.cast.receiver',
};

// Cast app ids (stable, public) from the catalog. Launching one opens that
// app on the TV. Cast can't list installed apps; GET_APP_AVAILABILITY says
// which of these the TV can open.
export const CAST_APPS = CATALOG.flatMap((e) => (e.ids.androidtv ?? []).map((id) => ({ id, title: e.title })));
const STALE_MS = 20_000; // heartbeats every 5 s; this long without a word = gone

const VOLUME_STEP = 0.02;

export class GoogleTvDriver extends Driver {
  static brand = 'androidtv';
  capabilities = { volumeLevel: true, inputs: false, toast: false, appIcons: false, remote: false, pointer: false, keyboard: false };
  #sock = null;
  #buf = Buffer.alloc(0);
  #requestId = 1;
  #waiting = new Map();
  #heartbeat = null;
  #retry = null;
  #stopped = true;
  #level = null;
  #heardAt = 0;
  #available = null;

  constructor(tv, opts = {}) {
    super(tv, opts);
    this.port = opts.port ?? 8009;
    this.staleMs = opts.staleMs ?? STALE_MS;
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#open().catch(() => this.#scheduleRetry());
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#retry);
    this.#close();
  }

  #scheduleRetry() {
    if (this.#stopped) return;
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => this.#open().catch(() => this.#scheduleRetry()), 5000);
    this.#retry.unref?.();
  }

  #close() {
    clearInterval(this.#heartbeat);
    this.#sock?.destroy();
    this.#sock = null;
    for (const fn of this.#waiting.values()) fn(null);
    this.#waiting.clear();
  }

  #open() {
    if (this.#sock) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ host: this.tv.ip, port: this.port, rejectUnauthorized: false, timeout: 5000 });
      sock.once('secureConnect', async () => {
        this.#sock = sock;
        this.#buf = Buffer.alloc(0);
        this.#send(NS.connection, { type: 'CONNECT' });
        this.#heardAt = Date.now();
        // PING every 5 s; a socket that went quiet (TV unplugged, Wi-Fi gone)
        // never sends a FIN, so drop it ourselves instead of showing stale state.
        this.#heartbeat = setInterval(() => {
          if (Date.now() - this.#heardAt > this.staleMs) return sock.destroy(new Error('stale'));
          this.#send(NS.heartbeat, { type: 'PING' });
        }, Math.min(5000, this.staleMs / 2));
        this.#heartbeat.unref?.();
        const status = await this.#ask({ type: 'GET_STATUS' });
        if (status) resolve();
        else reject(offline());
      });
      sock.on('data', (d) => this.#onData(d));
      sock.once('timeout', () => sock.destroy(new Error('timeout')));
      sock.once('error', (err) => {
        if (!this.#sock) reject(['ECONNREFUSED', 'EHOSTUNREACH', 'EHOSTDOWN', 'ETIMEDOUT'].includes(err.code) || err.message === 'timeout' ? offline() : err);
      });
      sock.once('close', () => {
        const wasOpen = this.#sock === sock;
        if (wasOpen) this.#close();
        this.setState({ online: false, power: 'off', app: null });
        if (wasOpen) this.#scheduleRetry();
      });
    });
  }

  // Cast frames: 4-byte big-endian length, then a protobuf CastMessage
  // { 1 protocol_version, 2 source, 3 destination, 4 namespace, 5 payload_type, 6 payload_utf8 }.
  #send(namespace, payload, destination = 'receiver-0') {
    if (!this.#sock) return;
    const body = encode({ 1: 0, 2: 'sender-0', 3: destination, 4: namespace, 5: 0, 6: JSON.stringify(payload) });
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    this.#sock.write(Buffer.concat([len, body]));
  }

  #ask(payload, timeout = 5000) {
    const requestId = this.#requestId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(requestId);
        resolve(null);
      }, timeout);
      this.#waiting.set(requestId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.#send(NS.receiver, { ...payload, requestId });
    });
  }

  #onData(chunk) {
    this.#heardAt = Date.now();
    this.#buf = Buffer.concat([this.#buf, chunk]);
    while (this.#buf.length >= 4) {
      const n = this.#buf.readUInt32BE(0);
      if (this.#buf.length < 4 + n) break;
      const msg = decode(this.#buf.subarray(4, 4 + n));
      this.#buf = this.#buf.subarray(4 + n);
      let payload;
      try {
        payload = JSON.parse(str(msg, 6) ?? '{}');
      } catch {
        continue;
      }
      if (payload.type === 'PING') this.#send(NS.heartbeat, { type: 'PONG' });
      if (payload.type === 'RECEIVER_STATUS') this.#onStatus(payload.status ?? {});
      if (payload.requestId && this.#waiting.has(payload.requestId)) {
        const fn = this.#waiting.get(payload.requestId);
        this.#waiting.delete(payload.requestId);
        fn(payload);
      }
    }
  }

  #onStatus(status) {
    const app = (status.applications ?? []).find((a) => !a.isIdleScreen);
    const v = status.volume ?? {};
    if (typeof v.level === 'number') this.#level = v.level;
    this.#session = app?.sessionId ?? null;
    // Google TVs keep Cast alive in standby and say so: isStandBy.
    const standby = status.isStandBy === true;
    this.setState({
      online: true,
      power: standby ? 'standby' : 'on',
      volume: typeof v.level === 'number' ? Math.round(v.level * 100) : this.state.volume,
      muted: typeof v.muted === 'boolean' ? v.muted : this.state.muted,
      app: standby ? null : (app?.appId ?? null),
      appTitle: standby ? null : (app?.displayName ?? null),
    });
  }

  #session = null;

  async #ready() {
    if (!this.#sock) await this.#open();
  }

  // No pairing: just prove the TV answers Cast, then remember it.
  async pair() {
    await this.#open();
    if (!this.tv.credentials) this.onCredentials({ cast: true });
    this.start();
  }

  async key(name) {
    await this.#ready();
    if (name === 'volup' || name === 'voldown') {
      const level = Math.max(0, Math.min(1, (this.#level ?? 0.3) + (name === 'volup' ? VOLUME_STEP : -VOLUME_STEP)));
      this.#level = level;
      this.#send(NS.receiver, { type: 'SET_VOLUME', volume: { level }, requestId: this.#requestId++ });
      if (this.state.muted) this.#send(NS.receiver, { type: 'SET_VOLUME', volume: { muted: false }, requestId: this.#requestId++ });
      return;
    }
    if (name === 'mute') {
      this.#send(NS.receiver, { type: 'SET_VOLUME', volume: { muted: !this.state.muted }, requestId: this.#requestId++ });
      return;
    }
    if ((name === 'home' || name === 'back' || name === 'stop') && this.#session) {
      // Closing the running app is the closest Cast has to "go home".
      this.#send(NS.receiver, { type: 'STOP', sessionId: this.#session, requestId: this.#requestId++ });
      return;
    }
    throw new HearthError(
      409,
      'Google TVs only allow volume, mute and apps without pairing. Arrow keys need Google’s one-time code.',
    );
  }

  async setVolume(level) {
    await this.#ready();
    this.#level = Math.max(0, Math.min(1, level / 100));
    this.#send(NS.receiver, { type: 'SET_VOLUME', volume: { level: this.#level }, requestId: this.#requestId++ });
  }

  // Re-read the receiver status (after a command, or to double-check).
  async refresh() {
    if (!this.#sock) return;
    const status = await this.#ask({ type: 'GET_STATUS' }, 3000);
    if (!status) this.#sock?.destroy(new Error('no answer'));
  }

  // The Cast apps this TV says it can open (cached; it doesn't change often).
  async apps() {
    await this.#ready();
    if (!this.#available) {
      const res = await this.#ask({ type: 'GET_APP_AVAILABILITY', appId: CAST_APPS.map((a) => a.id) }, 5000);
      const avail = res?.availability;
      if (avail) this.#available = new Set(Object.keys(avail).filter((id) => avail[id] === 'APP_AVAILABLE'));
    }
    const ok = (a) => !this.#available || this.#available.has(a.id);
    return CAST_APPS.filter(ok).map((a) => ({ ...a, icon: null }));
  }

  async launch(appId) {
    await this.#ready();
    const res = await this.#ask({ type: 'LAUNCH', appId }, 10_000);
    if (res?.type === 'LAUNCH_ERROR') throw new HearthError(502, `The TV couldn’t open that app (${res.reason ?? 'error'})`);
    if (!res) throw new HearthError(504, 'The TV didn’t answer the launch');
  }

  async powerOff() {
    throw unsupported('Turning a Google TV off without Google’s one-time code');
  }
}
