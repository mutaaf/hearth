import { HearthError, offline, unsupported } from '../errors.js';
import { getBridge } from '../atv-bridge.js';
import { Driver } from './base.js';

// Apple TV (tvOS 15+) through pyatv, which runs in one shared Python process
// (src/atv-bridge.js → src/drivers/appletv-bridge.py). Two protocols, each
// paired once with a 4-digit code the Apple TV shows on screen:
//   Companion: buttons, power, the app list and launching, power push updates
//   AirPlay:   tunnels MRP, which pushes what's playing (app, title, play state)
// Companion alone is a full remote; AirPlay adds the live "what's on" info.
const PROTOCOLS = ['companion', 'airplay'];
const LABELS = { companion: 'remote control', airplay: 'what’s playing' };

// Hearth key → [pyatv remote_control method, can be held]. A held Home opens
// Control Center on tvOS; a held Select is the long-press menu in lists.
const KEYS = {
  up: ['up', true], down: ['down', true], left: ['left', true], right: ['right', true],
  ok: ['select', true], back: ['menu', true], home: ['home', true], exit: ['home', true],
  menu: ['control_center', false],
  volup: ['volume_up', false], voldown: ['volume_down', false],
  chup: ['channel_up', false], chdown: ['channel_down', false],
  rewind: ['skip_backward', false], forward: ['skip_forward', false],
  stop: ['stop', false],
};
const NO_KEY = {
  mute: 'Muting (the Apple TV passes volume to the TV, and has no network mute)',
  source: 'Switching inputs',
  info: 'The info button',
};

const RETRY_MIN = 5000;
const RETRY_MAX = 60_000;

export class AppleTvDriver extends Driver {
  static brand = 'appletv';
  // Volume level only exists when the Apple TV drives its own speakers
  // (HomePods); with a TV over HDMI-CEC it just sends volume up/down.
  capabilities = { volumeLevel: false, inputs: false, toast: false, appIcons: false };
  #stopped = true;
  #connected = false;
  #connecting = null;
  #retry = null;
  #retryMs = RETRY_MIN;
  #pending = null; // { protocol, step, steps } while a code is on screen
  #apps = null;
  #off = [];

  constructor(tv, opts = {}) {
    super(tv, opts);
    this.bridge = opts.bridge ?? getBridge();
  }

  get #key() {
    return this.tv.id;
  }

  // ── lifecycle ─────────────────────────────────────────
  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    const on = (event, fn) => {
      this.bridge.on(event, fn);
      this.#off.push(() => this.bridge.off(event, fn));
    };
    on('state', (msg) => msg.key === this.#key && this.#apply(msg.state));
    on('closed', (msg) => {
      if (msg.key !== this.#key) return;
      this.#connected = false;
      this.setState({ online: false, power: 'off', app: null, appTitle: null, nowPlaying: null, playing: null });
      this.#scheduleRetry();
    });
    on('restart', () => {
      this.#connected = false;
      this.#connect().catch(() => this.#scheduleRetry());
    });
    this.#connect().catch(() => this.#scheduleRetry());
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#retry);
    for (const off of this.#off.splice(0)) off();
    if (this.#pending) await this.bridge.request('pair_cancel', { key: this.#key }).catch(() => {});
    this.#pending = null;
    if (this.#connected) await this.bridge.request('disconnect', { key: this.#key }, { timeout: 5000 }).catch(() => {});
    this.#connected = false;
  }

  #scheduleRetry() {
    if (this.#stopped) return;
    clearTimeout(this.#retry);
    this.#retry = setTimeout(() => this.#connect().catch(() => this.#scheduleRetry()), this.#retryMs);
    this.#retry.unref?.();
    this.#retryMs = Math.min(RETRY_MAX, this.#retryMs * 2);
  }

  #connect() {
    this.#connecting ??= (async () => {
      try {
        const res = await this.bridge.request('connect', {
          key: this.#key,
          ip: this.tv.ip,
          identifier: this.tv.atvId,
          credentials: this.tv.credentials ?? {},
        });
        this.#connected = true;
        this.#retryMs = RETRY_MIN;
        const info = {};
        if (res.identifier && res.identifier !== this.tv.atvId) info.atvId = res.identifier;
        if (res.ip && res.ip !== this.tv.ip) info.ip = res.ip; // DHCP moved it
        if (Object.keys(info).length) this.onInfo(info);
        this.#apply(res.state);
      } catch (err) {
        this.#connected = false;
        this.setState({
          online: false,
          power: 'off',
          app: null,
          appTitle: null,
          nowPlaying: null,
          playing: null,
          unavailable: this.bridge.available === false ? this.bridge.reason : null,
        });
        throw err;
      } finally {
        this.#connecting = null;
      }
    })();
    return this.#connecting;
  }

  async #ready() {
    if (this.#connected) return;
    if (!this.tv.credentials) throw new HearthError(409, 'Connect this Apple TV first (it shows a code)');
    try {
      await this.#connect();
    } catch (err) {
      if (err.status === 503 && this.bridge.available !== false) throw offline();
      throw err;
    }
  }

  #apply(s = {}) {
    if (Boolean(s.volumeLevel) !== this.capabilities.volumeLevel) {
      this.capabilities = { ...this.capabilities, volumeLevel: Boolean(s.volumeLevel) };
      this.emit('state', this.state); // tell the hub the capability changed
    }
    const on = s.power !== 'off';
    this.setState({
      online: s.online !== false,
      power: s.power ?? 'unknown',
      app: on ? s.app ?? null : null,
      appTitle: on ? s.appTitle ?? null : null,
      nowPlaying: on ? s.title ?? null : null,
      playing: on ? s.playing ?? null : null,
      volume: s.volume ?? null,
      unavailable: null,
    });
  }

  // ── pairing ───────────────────────────────────────────
  // pair() / pair({ mode: 'pin' }) → the Apple TV shows a code → { needsPin,
  // step, steps, label }. pair({ pin }) finishes that protocol and, if the
  // other one still needs a code, starts it and returns { needsPin } again.
  async pair({ pin } = {}) {
    if (pin) return this.#finishPin(String(pin));
    return this.#beginNext();
  }

  async #plan() {
    const info = await this.bridge.request('info', { ip: this.tv.ip, identifier: this.tv.atvId });
    if (info.identifier && info.identifier !== this.tv.atvId) this.onInfo({ atvId: info.identifier });
    const needs = (p) => ['Mandatory', 'Optional'].includes(info.services?.[p]?.pairing);
    if (!info.services?.companion) {
      throw unsupported('This Apple TV is too old for Hearth (it needs tvOS 15 or later), so connecting');
    }
    return PROTOCOLS.filter(needs);
  }

  async #beginNext(plan) {
    plan ??= await this.#plan();
    const todo = plan.filter((p) => !this.tv.credentials?.[p]);
    if (!todo.length) {
      if (!this.tv.credentials) this.onCredentials({ none: true }); // nothing asks for a code
      this.#afterPair();
      return {};
    }
    const protocol = todo[0];
    await this.bridge.request('pair_begin', { key: this.#key, ip: this.tv.ip, identifier: this.tv.atvId, protocol });
    this.#pending = { protocol, step: plan.indexOf(protocol) + 1, steps: plan.length, plan };
    return { needsPin: true, step: this.#pending.step, steps: this.#pending.steps, label: LABELS[protocol], protocol };
  }

  async #finishPin(pin) {
    const pending = this.#pending;
    if (!pending) throw new HearthError(409, 'Ask the Apple TV for a code first');
    const digits = pin.replace(/\D/g, '');
    if (!digits) throw new HearthError(400, 'Type the 4 numbers shown on the TV');
    this.#pending = null;
    let res;
    try {
      res = await this.bridge.request('pair_pin', { key: this.#key, pin: digits });
    } catch (err) {
      if (err.code === 'auth' || err.code === 'expired') {
        throw new HearthError(401, 'That code didn’t work. Tap “Show the number again” for a new one.');
      }
      throw err;
    }
    this.onCredentials({ [pending.protocol]: res.credentials });
    this.#afterPair();
    const rest = pending.plan.filter((p) => !this.tv.credentials?.[p]);
    if (rest.length) {
      try {
        return await this.#beginNext(pending.plan);
      } catch (err) {
        // The remote already works; "what's playing" can be added later.
        console.error(`[hearth] Apple TV ${this.tv.name}: ${rest[0]} pairing didn’t start (${err.message})`);
      }
    }
    return {};
  }

  // New keys: (re)connect so the bridge uses them.
  #afterPair() {
    if (this.#stopped) return this.start();
    this.#connected = false;
    this.#connect().catch(() => this.#scheduleRetry());
  }

  // ── remote ────────────────────────────────────────────
  async key(name, { hold = 0 } = {}) {
    if (NO_KEY[name]) throw unsupported(NO_KEY[name]);
    let entry = KEYS[name];
    if (name === 'play' || name === 'pause') {
      // Like the remote's own button: one toggle, unless we know it would
      // do the opposite of what was asked.
      const playing = this.state.playing;
      if ((name === 'play' && playing === 'playing') || (name === 'pause' && playing === 'paused')) return;
      entry = ['play_pause', false];
    }
    if (!entry) throw unsupported(`The "${name}" button`);
    await this.#ready();
    const [method, holdable] = entry;
    await this.bridge.request('remote', { key: this.#key, method, hold: Boolean(hold && holdable) }, { timeout: 8000 });
  }

  async powerOn() {
    await this.#ready();
    await this.bridge.request('power', { key: this.#key, on: true }, { timeout: 8000 });
  }

  async powerOff() {
    await this.#ready();
    await this.bridge.request('power', { key: this.#key, on: false }, { timeout: 8000 });
  }

  async setVolume(level) {
    if (!this.capabilities.volumeLevel) throw unsupported('Setting the volume level');
    await this.#ready();
    await this.bridge.request('set_volume', { key: this.#key, level: Math.max(0, Math.min(100, Number(level) || 0)) });
  }

  // Bundle ids (com.netflix.Netflix) from the Apple TV's own Companion list.
  async apps() {
    await this.#ready();
    const list = await this.bridge.request('apps', { key: this.#key }, { timeout: 15_000 });
    this.#apps = list.map((a) => ({ id: a.id, title: a.title, icon: null }));
    return this.#apps;
  }

  async launch(bundleId) {
    if (typeof bundleId !== 'string' || !bundleId) throw new HearthError(400, 'Which app?');
    await this.#ready();
    await this.bridge.request('launch', { key: this.#key, app: bundleId }, { timeout: 15_000 });
    // It's open now; MRP will refine this once the app starts playing.
    const title = this.#apps?.find((a) => a.id === bundleId)?.title ?? null;
    this.setState({ app: bundleId, appTitle: title, power: 'on' });
  }
}

// Friendly model names for the hardware identifiers Apple TVs announce.
const MODELS = {
  'AppleTV2,1': '2nd gen', 'AppleTV3,1': '3rd gen', 'AppleTV3,2': '3rd gen', 'AppleTV5,3': 'HD',
  'AppleTV6,2': '4K', 'AppleTV11,1': '4K (2nd gen)', 'AppleTV14,1': '4K (3rd gen)',
};
export const appleTvModel = (raw) => (raw ? MODELS[raw] ?? raw : '');
