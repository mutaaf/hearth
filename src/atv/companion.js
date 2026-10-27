import { EventEmitter } from 'node:events';
import { sha512 } from '@noble/hashes/sha2.js';
import { checkTlv, formatCredentials, PairingError, PairSetup, PairVerify, parseCredentials } from './hap.js';
import { CompanionLink, FRAME, linkError } from './link.js';
import { float } from './opack.js';

// Apple TV remote over Companion, in plain JS (no pyatv). The messages and
// numbers are pyatv's (protocols/companion/api.py and __init__.py, 0.18).

export const HID = {
  Up: 1, Down: 2, Left: 3, Right: 4, Menu: 5, Select: 6, Home: 7, VolumeUp: 8, VolumeDown: 9, Siri: 10,
  Screensaver: 11, Sleep: 12, Wake: 13, PlayPause: 14, ChannelIncrement: 15, ChannelDecrement: 16,
  Guide: 17, PageUp: 18, PageDown: 19,
};
export const MCC = { Play: 1, Pause: 2, NextTrack: 3, PreviousTrack: 4, GetVolume: 5, SetVolume: 6, SkipBy: 7 };
const VOLUME_FLAG = 0x100; // _iMC _mcF: the Apple TV controls a volume (HomePods)
// SystemStatus / FetchAttentionState: 1 asleep, 2 screensaver, 3 awake, 4 idle
const powerOf = (state) => (state === 1 ? 'off' : [2, 3, 4].includes(state) ? 'on' : 'unknown');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── pairing ───────────────────────────────────────────────
// beginPairing() opens the link and asks for a code (the TV shows it);
// session.finish(pin) → the credential string. One session per code.
export async function beginPairing({ host, port, name = 'Hearth', timeout = 5000, connect }) {
  const link = new CompanionLink({ host, port, timeout, connect });
  await link.open();
  const setup = new PairSetup({ name });
  try {
    const m2 = await link.auth(FRAME.PS_Start, { _pd: setup.m1(), _pwTy: 1 });
    const pd = pairingData(m2);
    checkTlv(pd); // e.g. "busy" before any code is shown
    return new PairingSession(link, setup, pd);
  } catch (err) {
    link.close();
    throw err;
  }
}

function pairingData(msg) {
  const pd = msg?._pd;
  if (!Buffer.isBuffer(pd) || !pd.length) throw new PairingError('protocol', 'The Apple TV sent no pairing data');
  return pd;
}

export class PairingSession {
  constructor(link, setup, m2) {
    Object.assign(this, { link, setup, m2 });
  }

  async finish(pin) {
    try {
      const m4 = await this.link.auth(FRAME.PS_Next, { _pd: this.setup.m3(pin, this.m2), _pwTy: 1 });
      const m6 = await this.link.auth(FRAME.PS_Next, { _pd: this.setup.m5(pairingData(m4)), _pwTy: 1 });
      return formatCredentials(this.setup.credentials(pairingData(m6)));
    } finally {
      this.link.close();
    }
  }

  close() {
    this.link.close();
  }
}

// ── the connected remote ──────────────────────────────────
// connect(): pair-verify → encrypted session → the handshake pyatv does
// (_systemInfo, _touchStart, _sessionStart, TVRCSessionStart, _tiStart,
// _interest in _iMC) → power (FetchAttentionState + SystemStatus pushes).
// Emits 'state' (a snapshot, the bridge's shape) and 'close'.
export class CompanionClient extends EventEmitter {
  #link = null;
  #power = 'unknown';
  #volume = null;
  #closing = false;

  constructor({ host, port, credentials, name = 'Hearth', model = 'iPhone10,6', timeout = 5000, connect, holdMs = 1000 }) {
    super();
    this.creds = parseCredentials(credentials);
    Object.assign(this, { host, port, name, model, timeout, connectFn: connect, holdMs });
  }

  get connected() {
    return Boolean(this.#link && !this.#link.closed);
  }

  snapshot() {
    return {
      online: true,
      power: this.#power,
      app: null, // what's playing needs MRP over AirPlay, which this client doesn't do
      appTitle: null,
      title: null,
      playing: null,
      volume: this.#volume,
      volumeLevel: this.#volume != null,
    };
  }

  async connect() {
    const link = new CompanionLink({ host: this.host, port: this.port, timeout: this.timeout, connect: this.connectFn });
    this.#link = link;
    link.on('close', () => {
      if (this.#link === link) this.emit('close');
    });
    link.on('event', (name, content) => this.#onEvent(name, content));
    await link.open();
    try {
      await this.#verify(link);
      await this.#handshake(link);
    } catch (err) {
      link.close();
      throw err;
    }
    return this;
  }

  async #verify(link) {
    const verify = new PairVerify(this.creds);
    const m2 = await link.auth(FRAME.PV_Start, { _pd: verify.m1(), _auTy: 4 });
    const m4 = await link.auth(FRAME.PV_Next, { _pd: verify.m3(pairingData(m2)) });
    checkTlv(m4?._pd); // an Error here means the Apple TV forgot us
    link.enableEncryption(verify.sessionKeys());
  }

  // Stable per pairing, so the Apple TV sees the same "phone" each time; a
  // null _i would stop TVSystemStatus pushes (pyatv api.py).
  #ids() {
    const h = Buffer.from(sha512(this.creds.clientId));
    const mac = [0xfe & (h[6] | 0x02), ...h.subarray(7, 12)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    return { rpId: h.subarray(0, 6).toString('hex'), deviceId: mac };
  }

  async #handshake(link) {
    const { rpId, deviceId } = this.#ids();
    await link.request('_systemInfo', {
      _bf: 0, _cf: 512, _clFl: 128, _i: rpId, _idsID: this.creds.clientId, _pubID: deviceId,
      _sf: 256, _sv: '170.18', model: this.model, name: this.name,
    });
    await link.request('_touchStart', { _height: float(1000), _tFl: 0, _width: float(1000) });
    const sid = Math.floor(Math.random() * 0xffffffff);
    await link.request('_sessionStart', { _srvT: 'com.apple.tvremoteservices', _sid: sid });
    // Newer tvOS wants this before FetchAttentionState; older ones refuse it.
    await link.request('TVRCSessionStart', { ProtocolVersionKey: '1.2' }).catch(() => {});
    await link.request('_tiStart', {}).catch(() => {});
    link.event('_interest', { _regEvents: ['_iMC'] });
    try {
      const res = await link.request('FetchAttentionState', {});
      this.#power = powerOf(res._c?.state);
    } catch {
      // Some tvOS versions have no handler for it; pushes still come.
    }
    link.event('_interest', { _regEvents: ['SystemStatus'] });
    link.event('_interest', { _regEvents: ['TVSystemStatus'] });
  }

  #onEvent(name, content = {}) {
    if (name === 'SystemStatus' || name === 'TVSystemStatus') {
      const power = powerOf(Number(content.state));
      if (power !== this.#power) {
        this.#power = power;
        this.emit('state', this.snapshot());
      }
    } else if (name === '_iMC') {
      if (Number(content._mcF) & VOLUME_FLAG) {
        this.mediaControl(MCC.GetVolume)
          .then((res) => {
            const vol = Number(res._c?._vol);
            if (Number.isFinite(vol)) this.#setVolume(Math.round(vol * 100));
          })
          .catch(() => {});
      } else this.#setVolume(null);
    }
  }

  #setVolume(v) {
    if (v === this.#volume) return;
    this.#volume = v;
    this.emit('state', this.snapshot());
  }

  #live() {
    if (!this.connected) throw linkError('offline', 'Not connected to that Apple TV');
    return this.#link;
  }

  // _hBtS 1 = down, 2 = up
  async hid(command, down) {
    await this.#live().request('_hidC', { _hBtS: down ? 1 : 2, _hidC: command });
  }

  async press(command, { hold = false } = {}) {
    await this.hid(command, true);
    if (hold) await sleep(this.holdMs);
    await this.hid(command, false);
  }

  mediaControl(command, args = {}) {
    return this.#live().request('_mcc', { _mcc: command, ...args });
  }

  // pyatv sends only the "up" half for these two.
  powerOn() {
    return this.hid(HID.Wake, false);
  }
  powerOff() {
    return this.hid(HID.Sleep, false);
  }

  async setVolume(level) {
    await this.mediaControl(MCC.SetVolume, { _vol: float(level / 100) });
  }

  async apps() {
    const res = await this.#live().request('FetchLaunchableApplicationsEvent', {}, 15_000);
    const content = res._c && typeof res._c === 'object' ? res._c : {};
    return Object.entries(content)
      .map(([id, title]) => ({ id, title: typeof title === 'string' && title ? title : id }))
      .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  }

  async launch(app) {
    const key = /^[a-z][a-z0-9+.-]*:/i.test(app) ? '_urlS' : '_bundleID';
    await this.#live().request('_launchApp', { [key]: app }, 15_000);
  }

  // Best-effort goodbye (pyatv: _sessionStop, _touchStop, _tiStop), then close.
  async close() {
    if (this.#closing) return;
    this.#closing = true;
    const link = this.#link;
    if (!link || link.closed) return;
    const quick = (id, c) => link.request(id, c, 1000).catch(() => {});
    await Promise.all([quick('_touchStop', { _i: 1 }), quick('_tiStop', {})]);
    link.close();
  }
}
