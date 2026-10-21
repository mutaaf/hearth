import tls from 'node:tls';
import { HearthError, offline, unsupported } from '../errors.js';
import { decode, encode, str } from '../proto.js';
import { Driver } from './base.js';
import { ANDROID_KEYS, AtvPairing, AtvRemote, DIRECTION, makeIdentity } from './googletv-remote.js';

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

// Cast app ids (stable, public). Launching one opens that app on the TV.
export const CAST_APPS = [
  { id: '233637DE', title: 'YouTube' },
  { id: 'CA5E8412', title: 'Netflix' },
  { id: 'CC32E753', title: 'Spotify' },
  { id: '9AC194DC', title: 'Plex' },
];

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

  constructor(tv, opts = {}) {
    super(tv, opts);
    this.port = opts.port ?? 8009;
    // ── full remote (Google's remote protocol v2, unlocked with a code) ──
    this.remotePorts = opts.remotePorts ?? { pair: 6467, remote: 6466 };
    this.capabilities.remote = Boolean(tv.credentials?.remoteCert);
    this.remoteAuth = tv.credentials?.remoteCert ? 'unknown' : 'missing';
  }

  #remote = null;
  #remoteRetry = null;
  #pairing = null;
  #pendingId = null;

  #remoteStart() {
    const creds = this.tv.credentials;
    if (this.#remote || this.#stopped || !creds?.remoteCert) return;
    const r = new AtvRemote({ host: this.tv.ip, port: this.remotePorts.remote, cert: creds.remoteCert, key: creds.remoteKey });
    this.#remote = r;
    r.on('state', (s) => {
      const patch = { online: true };
      if ('started' in s) patch.power = s.started ? 'on' : 'standby';
      if ('volume' in s) Object.assign(patch, { volume: s.volume, muted: s.muted });
      if (s.app && !this.#session) patch.app = s.app;
      this.setState(patch);
    });
    const retry = (ms) => {
      if (this.#stopped) return;
      clearTimeout(this.#remoteRetry);
      this.#remoteRetry = setTimeout(() => this.#remoteStart(), ms);
      this.#remoteRetry.unref?.();
    };
    r.on('close', () => {
      if (this.#remote === r) this.#remote = null;
      retry(5000);
    });
    r.connect()
      .then(() => (this.remoteAuth = 'ok'))
      .catch((err) => {
        if (this.#remote === r) this.#remote = null;
        this.remoteAuth = err.status === 401 ? 'rejected' : 'unreachable';
        retry(err.status === 401 ? 60_000 : 10_000);
      });
  }

  // Step 1: the TV shows a code. Step 2: pair({ code }) finishes it.
  async #startCode() {
    this.#pairing?.close();
    this.#pendingId ??= makeIdentity();
    this.#pairing = new AtvPairing({ host: this.tv.ip, port: this.remotePorts.pair, cert: this.#pendingId.cert, key: this.#pendingId.key });
    await this.#pairing.start();
    return { needsCode: true };
  }

  async #finishCode(code) {
    if (!this.#pairing?.open || !this.#pendingId) throw new HearthError(409, 'The code expired. Tap “Show a new code”.');
    await this.#pairing.finish(code);
    const id = this.#pendingId;
    this.#pendingId = null;
    this.#pairing = null;
    const creds = { cast: true, remoteCert: id.cert, remoteKey: id.key };
    this.tv.credentials = { ...this.tv.credentials, ...creds };
    this.capabilities = { ...this.capabilities, remote: true };
    this.remoteAuth = 'unknown';
    this.onCredentials(creds);
    this.#remote?.close();
    this.#remote = null;
    if (this.#stopped) this.start();
    else this.#remoteStart();
  }

  // Harmless checks for the connection doctor: Cast status, and the remote
  // handshake when the full remote is unlocked. Never presses anything.
  async verify() {
    await this.#ready();
    if (!this.tv.credentials?.remoteCert) return { ok: true, auth: this.tv.credentials ? 'ok' : 'missing', detail: 'Cast answered (volume, apps)' };
    if (this.#remote?.ready) return { ok: true, auth: 'ok', detail: 'Cast and the full remote both answered' };
    const probe = new AtvRemote({ host: this.tv.ip, port: this.remotePorts.remote, cert: this.tv.credentials.remoteCert, key: this.tv.credentials.remoteKey });
    try {
      await probe.connect(6000);
      return { ok: true, auth: 'ok', detail: 'Cast and the full remote both answered' };
    } catch (err) {
      return { ok: true, auth: err.status === 401 ? 'rejected' : 'ok', how: 'googletv-code', detail: err.message };
    } finally {
      probe.close();
    }
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#open().catch(() => this.#scheduleRetry());
    this.#remoteStart();
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#retry);
    clearTimeout(this.#remoteRetry);
    this.#remote?.close();
    this.#remote = null;
    this.#pairing?.close();
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
        this.#heartbeat = setInterval(() => this.#send(NS.heartbeat, { type: 'PING' }), 5000);
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
    this.setState({
      online: true,
      power: 'on',
      volume: typeof v.level === 'number' ? Math.round(v.level * 100) : this.state.volume,
      muted: typeof v.muted === 'boolean' ? v.muted : this.state.muted,
      app: app?.appId ?? null,
      appTitle: app?.displayName ?? null,
    });
  }

  #session = null;

  async #ready() {
    if (!this.#sock) await this.#open();
  }

  // No pairing: just prove the TV answers Cast, then remember it.
  // pair({ mode: 'code' }) / pair({ code }) unlock the full remote instead.
  async pair({ mode, code } = {}) {
    if (code !== undefined) return this.#finishCode(code);
    if (mode === 'code') return this.#startCode();
    await this.#open();
    if (!this.tv.credentials) this.onCredentials({ cast: true });
    this.start();
  }

  async key(name, { hold = 0 } = {}) {
    // Unlocked: every button goes over Google's remote, holds included.
    if (this.#remote?.ready && ANDROID_KEYS[name] != null) {
      const code = ANDROID_KEYS[name];
      if (!hold) return this.#remote.key(code, DIRECTION.SHORT);
      this.#remote.key(code, DIRECTION.START_LONG);
      await new Promise((r) => setTimeout(r, Math.min(hold, 3000)));
      return this.#remote.key(code, DIRECTION.END_LONG);
    }
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
      this.tv.credentials?.remoteCert
        ? 'The full remote is reconnecting. Try again in a moment.'
        : 'Google TVs only allow volume, mute and apps without pairing. Unlock the full remote (TV settings → Codes & pairing) for arrows.',
    );
  }

  async setVolume(level) {
    await this.#ready();
    this.#level = Math.max(0, Math.min(1, level / 100));
    this.#send(NS.receiver, { type: 'SET_VOLUME', volume: { level: this.#level }, requestId: this.#requestId++ });
  }

  async apps() {
    return CAST_APPS.map((a) => ({ ...a, icon: null }));
  }

  async launch(appId) {
    await this.#ready();
    const res = await this.#ask({ type: 'LAUNCH', appId }, 10_000);
    if (res?.type === 'LAUNCH_ERROR') throw new HearthError(502, `The TV couldn’t open that app (${res.reason ?? 'error'})`);
  }

  async powerOn() {
    if (this.#remote?.ready) {
      if (this.state.power !== 'on') this.#remote.key(ANDROID_KEYS.wakeup, DIRECTION.SHORT);
      return;
    }
    return super.powerOn();
  }

  async powerOff() {
    if (this.#remote?.ready) {
      if (this.state.power === 'on') this.#remote.key(ANDROID_KEYS.power, DIRECTION.SHORT);
      return;
    }
    throw unsupported('Turning a Google TV off without unlocking the full remote');
  }
}
