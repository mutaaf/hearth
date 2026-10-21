import WebSocket from 'ws';
import { HearthError, offline, unsupported } from '../errors.js';
import { samsungInfo } from '../discovery.js';
import { keyCode } from '../keys.js';
import { Driver } from './base.js';

// Samsung Tizen (2016+). Keys and apps go over the "samsung.remote.control"
// websocket channel on :8002 (wss, self-signed cert); the first connection
// shows an Allow prompt on the TV and returns a token we keep. Power state
// comes from the plain REST endpoint on :8001.
const APP_NAME = Buffer.from('Hearth').toString('base64');
const PAIR_TIMEOUT = 60_000;
const POLL_MS = 5000;

export class SamsungDriver extends Driver {
  static brand = 'samsung';
  capabilities = { volumeLevel: false, inputs: false, toast: false, appIcons: false, pointer: true, keyboard: true };
  #ws = null;
  #connecting = null;
  #poll = null;
  #appTypes = new Map();

  constructor(tv, opts = {}) {
    super(tv, opts);
    // Overridable so tests can stand up a fake TV on localhost.
    // 2018+ sets: wss on 8002 with a token. 2016-17 (K/M series): plain ws
    // on 8001, no token. Decided from the TV's own REST info on first use.
    this.port = opts.port ?? null;
    this.secure = opts.secure ?? null;
    this.fetchInfo = opts.fetchInfo ?? (() => samsungInfo(this.tv.ip, 1500));
  }

  url() {
    const token = this.tv.credentials?.token;
    const base = `${this.secure ? 'wss' : 'ws'}://${this.tv.ip}:${this.port}/api/v2/channels/samsung.remote.control?name=${APP_NAME}`;
    return token ? `${base}&token=${encodeURIComponent(token)}` : base;
  }

  start() {
    if (this.#poll) return;
    const tick = async () => {
      try {
        const info = await this.fetchInfo();
        // PowerState only exists on 2018+ models. Older sets keep answering
        // in standby, so "answering" can't tell asleep from awake: 'unknown'.
        const power = info?.device?.PowerState ?? 'unknown';
        this.setState({ online: true, power });
      } catch {
        this.setState({ online: false, power: 'off', app: null });
        this.#close();
      }
    };
    tick();
    this.#poll = setInterval(tick, POLL_MS);
    this.#poll.unref?.();
  }

  async stop() {
    clearInterval(this.#poll);
    this.#poll = null;
    this.#close();
  }

  #close() {
    this.#ws?.terminate();
    this.#ws = null;
    this.#connecting = null;
  }

  async #pickPort() {
    if (this.port != null) return;
    const info = await this.fetchInfo().catch(() => null);
    // Off or unreachable: decide later, not now (a wrong guess would stick).
    if (!info) throw offline();
    const tokenAuth = /true/i.test(String(info.device?.TokenAuthSupport ?? ''));
    const legacy = !tokenAuth;
    this.port = legacy ? 8001 : 8002;
    this.secure = !legacy;
  }

  #connect(timeout = 8000) {
    if (this.#ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.#ws);
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#pickPort().then(() => new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url(), { rejectUnauthorized: false, handshakeTimeout: 5000 });
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#connecting = null;
        if (err) {
          ws.terminate();
          reject(err);
        } else {
          this.#ws = ws;
          resolve(ws);
        }
      };
      const timer = setTimeout(
        () => settle(new HearthError(408, 'Nobody pressed Allow on the TV in time')),
        timeout,
      );
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.event === 'ms.channel.connect') {
          const token = msg.data?.token;
          if (token && token !== this.tv.credentials?.token) this.onCredentials({ token: String(token) });
          // Older sets accept the connection without handing out a token;
          // remember that they let us in.
          else if (!token && !this.tv.credentials) this.onCredentials({ legacy: true });
          settle();
        } else if (msg.event === 'ms.channel.unauthorized') {
          settle(new HearthError(403, 'Pairing was declined on the TV'));
        }
        this.emit('message', msg);
      });
      ws.on('error', (err) => settle(err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' ? offline() : err));
      ws.on('close', () => {
        if (this.#ws === ws) this.#ws = null;
        settle(offline());
      });
    })).catch((err) => {
      this.#connecting = null;
      throw err;
    });
    return this.#connecting;
  }

  async #send(payload) {
    const ws = await this.#connect();
    ws.send(JSON.stringify(payload));
  }

  async #ask(payload, event, timeout = 5000) {
    const ws = await this.#connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('message', onMessage);
        reject(new HearthError(504, 'The TV did not answer'));
      }, timeout);
      const onMessage = (msg) => {
        if (msg.event !== event) return;
        clearTimeout(timer);
        this.off('message', onMessage);
        resolve(msg.data);
      };
      this.on('message', onMessage);
      ws.send(JSON.stringify(payload));
    });
  }

  // Connection doctor: REST info, then open the remote channel and wait for
  // ms.channel.connect. No keys are sent.
  async verify() {
    const t0 = Date.now();
    const info = await this.fetchInfo().catch(() => null);
    if (!info) return { ok: false, auth: this.tv.credentials ? 'ok' : 'missing', how: 'samsung-allow', detail: 'The TV didn’t answer on :8001' };
    const rest = `REST answered in ${Date.now() - t0} ms`;
    if (!this.tv.credentials) return { ok: true, auth: 'missing', how: 'samsung-allow', detail: rest };
    try {
      await this.#connect(8000);
      return { ok: true, auth: 'ok', detail: `${rest} · remote channel open on :${this.port}` };
    } catch (err) {
      if (err.status === 403) return { ok: true, auth: 'rejected', how: 'samsung-allow', detail: 'The TV said no to Hearth (ms.channel.unauthorized)' };
      if (err.status === 408) return { ok: true, auth: 'prompt', how: 'samsung-allow', detail: 'The TV is waiting for someone to press Allow' };
      return { ok: true, auth: 'ok', detail: `${rest} · remote channel: ${err.message}` };
    }
  }

  async pair() {
    await this.#connect(PAIR_TIMEOUT);
    this.start();
  }

  #sendKey(code, cmd = 'Click') {
    return this.#send({
      method: 'ms.remote.control',
      params: { Cmd: cmd, DataOfCmd: code, Option: 'false', TypeOfRemote: 'SendRemoteKey' },
    });
  }

  // Tizen understands real press-and-hold (Press … Release), e.g. a long OK
  // opens context menus. `hold` is how long the finger stayed down, in ms.
  async key(name, { hold = 0 } = {}) {
    const code = keyCode('samsung', name);
    if (!code) throw unsupported(`The "${name}" button`);
    if (!hold) return this.#sendKey(code);
    await this.#sendKey(code, 'Press');
    await new Promise((r) => setTimeout(r, Math.min(hold, 3000)));
    await this.#sendKey(code, 'Release');
  }

  async powerOn() {
    // Wake-on-LAN first (harmless if it's already on)…
    if (this.tv.macs?.length) await super.powerOn().catch(() => {});
    // …then, if the set still answers: 2018+ in standby take a POWER key;
    // older sets can't say whether they're asleep, so POWER acts as a toggle,
    // exactly like the TV's own remote.
    if (this.state.online && (this.state.power === 'standby' || this.state.power === 'unknown')) {
      await this.#sendKey('KEY_POWER').catch(() => {});
    } else if (!this.tv.macs?.length) {
      await super.powerOn();
    }
  }

  async powerOff() {
    if (!this.state.online || this.state.power === 'standby') return;
    await this.#sendKey('KEY_POWER');
  }

  // Older sets: one button, one toggle.
  get powerToggles() {
    return this.state.power === 'unknown';
  }

  // Tizen's browser takes a mouse over the same channel ("ProcessMouseDevice").
  async pointer({ type, dx = 0, dy = 0 } = {}) {
    if (type === 'move') {
      return this.#send({
        method: 'ms.remote.control',
        params: { Cmd: 'Move', Position: { x: Math.round(dx), y: Math.round(dy), Time: String(Date.now()) }, TypeOfRemote: 'ProcessMouseDevice' },
      });
    }
    if (type === 'click') {
      return this.#send({ method: 'ms.remote.control', params: { Cmd: 'LeftClick', TypeOfRemote: 'ProcessMouseDevice' } });
    }
    if (type === 'scroll') {
      // No wheel on this channel: a scroll becomes arrow steps.
      const steps = Math.min(5, Math.max(1, Math.round(Math.abs(dy) / 40)));
      for (let i = 0; i < steps; i++) await this.#sendKey(dy < 0 ? 'KEY_UP' : 'KEY_DOWN');
      return;
    }
    throw unsupported(`Pointer "${type}"`);
  }

  // Text goes into whatever field has focus (a search box, the browser bar).
  async text({ text, backspace, enter } = {}) {
    if (text) {
      await this.#send({
        method: 'ms.remote.control',
        params: { Cmd: Buffer.from(String(text).slice(0, 500)).toString('base64'), DataOfCmd: 'base64', TypeOfRemote: 'SendInputString' },
      });
    }
    if (backspace) throw unsupported('Deleting text on this Samsung (type it again from the start)');
    if (enter) await this.#send({ method: 'ms.remote.control', params: { TypeOfRemote: 'SendInputEnd' } });
  }

  async apps() {
    const data = await this.#ask(
      { method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host', data: '' } },
      'ed.installedApp.get',
    );
    const list = data?.data ?? [];
    for (const app of list) this.#appTypes.set(app.appId, app.app_type);
    return list.map((app) => ({ id: app.appId, title: app.name, icon: null }));
  }

  async launch(id) {
    await this.#send({
      method: 'ms.channel.emit',
      params: {
        event: 'ed.apps.launch',
        to: 'host',
        data: { appId: id, action_type: this.#appTypes.get(id) === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH' },
      },
    });
  }
}
