import WebSocket from 'ws';
import { CATALOG } from '../catalog.js';
import { portOpen } from '../discovery.js';
import { HearthError, offline, unsupported } from '../errors.js';
import { keyCode } from '../keys.js';
import { soap } from '../upnp.js';
import { Driver } from './base.js';

// Samsung Tizen (2016+). Three doors into the same TV:
//   • ws :8002 (wss + token, 2018+) or ws :8001 (2016-17, no token): the
//     samsung.remote.control channel for keys, the app list and launching.
//   • REST :8001/api/v2/: device info (PowerState on 2018+ only) and, per app,
//     /applications/<id> → { name, running, visible }. Polling the visible one
//     is how Hearth knows what's on screen. POST to it launches the app.
//   • UPnP DLNA renderer :9197: RenderingControl Get/SetVolume, Get/SetMute,
//     so the volume level and mute are real, not guesses.
//   • :9119 (screen-sharing service): on 2016-17 sets it only listens while
//     the panel is on, and closes first when the set goes to standby.
// Polling only uses REST + UPnP; the websocket is opened for commands, never
// just to look (some Samsungs wake up when a remote connects).
const APP_NAME = Buffer.from('Hearth').toString('base64');
const PAIR_TIMEOUT = 60_000;
const ACTIVE_MS = 3000; // someone has the app open
const IDLE_MS = 15_000; // nobody watching: keep state fresh, but quietly
const PER_TICK = { active: 12, idle: 6 }; // app-status checks per poll
const PARALLEL = 4;
const APPS_TTL = 30 * 60_000;
const MISSING_TTL = 60 * 60_000;
const OFF_GRACE = 15_000; // after we send power-off, the set keeps answering a while
const SAMSUNG_IDS = [...new Set(CATALOG.flatMap((e) => e.ids.samsung ?? []))];

export class SamsungDriver extends Driver {
  static brand = 'samsung';
  capabilities = { volumeLevel: false, inputs: false, toast: false, appIcons: false, pointer: true, keyboard: true };
  #ws = null;
  #connecting = null;
  #timer = null;
  #running = false;
  #again = false;
  #stopped = true;
  #active = false;
  #appTypes = new Map();
  #installed = null; // [{ id, title }] from the websocket, cached
  #installedAt = 0;
  #mru = []; // app ids seen on screen, most recent first
  #missing = new Map(); // catalog id → when the TV said 404
  #known = new Map(); // id → title (from REST answers)
  #cursor = 0;
  #sinceHit = 0; // ids checked since the last visible app was found
  #offUntil = 0;
  #dmrSeen = false;

  constructor(tv, opts = {}) {
    super(tv, opts);
    // Overridable so tests can stand up a fake TV on localhost.
    // 2018+ sets: wss on 8002 with a token. 2016-17 (K/M series): plain ws
    // on 8001, no token. Decided from the TV's own REST info on first use.
    this.port = opts.port ?? null;
    this.secure = opts.secure ?? null;
    this.rest = opts.rest ?? `http://${tv.ip}:8001`;
    this.dmr = opts.dmr ?? `http://${tv.ip}:9197`;
    this.fetchInfo = opts.fetchInfo ?? (() => this.#getJson('/api/v2/', 1500));
    this.screenProbe = opts.screenProbe ?? (() => portOpen(tv.ip, 9119, 1000));
    this.launchWaitMs = opts.launchWaitMs ?? 4000;
    this.state = { ...this.state, appTitle: null };
  }

  url() {
    const token = this.tv.credentials?.token;
    const base = `${this.secure ? 'wss' : 'ws'}://${this.tv.ip}:${this.port}/api/v2/channels/samsung.remote.control?name=${APP_NAME}`;
    return token ? `${base}&token=${encodeURIComponent(token)}` : base;
  }

  // ── State polling ──────────────────────────────────────
  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.refresh();
  }

  async stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = null;
    this.#close();
  }

  // The hub says whether anyone has the app open: poll faster when they do.
  setActive(active) {
    const was = this.#active;
    this.#active = Boolean(active);
    if (this.#active && !was && !this.#stopped) this.refresh();
  }

  // Re-read everything now (after a command, or when a viewer arrives).
  refresh({ full = true } = {}) {
    if (this.#stopped) return Promise.resolve();
    if (this.#running) {
      this.#again = true;
      return Promise.resolve();
    }
    clearTimeout(this.#timer);
    this.#running = true;
    return this.#tick(full)
      .catch(() => {})
      .finally(() => {
        this.#running = false;
        if (this.#stopped) return;
        if (this.#again) {
          this.#again = false;
          return this.refresh();
        }
        this.#timer = setTimeout(() => this.refresh({ full: false }), this.#active ? ACTIVE_MS : IDLE_MS);
        this.#timer.unref?.();
      });
  }

  async #getJson(path, timeout = 1500) {
    const res = await fetch(`${this.rest}${path}`, { signal: AbortSignal.timeout(timeout) });
    if (!res.ok) {
      const err = new HearthError(res.status === 404 ? 404 : 502, `The TV said ${res.status}`);
      err.http = res.status;
      throw err;
    }
    return res.json();
  }

  async #tick(full) {
    let info;
    try {
      info = await this.fetchInfo();
    } catch {
      this.setState({ online: false, power: 'off', app: null, appTitle: null });
      this.#close();
      return;
    }
    // 2018+ sets say it outright; 2016-17 sets don't (see #legacyPower).
    const reported = info?.device?.PowerState;
    if (reported && reported !== 'on') {
      this.setState({ online: true, power: 'standby', app: null, appTitle: null });
      return;
    }
    const [sound, app, screen] = await Promise.all([
      this.#readSound(),
      this.#readApp(full),
      reported ? true : this.screenProbe().catch(() => false),
    ]);
    let power = reported ? 'on' : this.#legacyPower(app, screen);
    if (Date.now() < this.#offUntil && !app) power = 'standby';
    const on = power === 'on';
    this.setState({
      online: true,
      power,
      app: on ? (app?.id ?? null) : null,
      appTitle: on ? (app?.title ?? null) : null,
      ...(sound ? sound : { volume: null, muted: null }),
    });
  }

  // 2016-17 sets have no PowerState. Probed on a KU6290 (CLAUDE.md): in
  // standby the set drops off the network entirely within ~40 s (REST, ws,
  // UPnP all gone; the poll then says offline/off). While it answers: an app
  // with visible:true means the panel is on; otherwise the screen-sharing
  // port :9119 is open while on and closes first on the way to standby.
  #legacyPower(app, screen) {
    if (app) return 'on';
    return screen ? 'on' : 'standby';
  }

  // ── Volume + mute over the DLNA renderer ──
  #rc(action, args) {
    return soap(`${this.dmr}/upnp/control/RenderingControl1`, 'RenderingControl', action, { Channel: 'Master', ...args }, 1500);
  }

  async #readSound() {
    try {
      const [v, m] = await Promise.all([this.#rc('GetVolume'), this.#rc('GetMute')]);
      const volume = Number.parseInt(v.CurrentVolume, 10);
      if (!Number.isFinite(volume)) return null;
      if (!this.#dmrSeen) {
        this.#dmrSeen = true;
        this.capabilities = { ...this.capabilities, volumeLevel: true };
      }
      return { volume, muted: m.CurrentMute === '1' || m.CurrentMute === 'true' };
    } catch {
      return null;
    }
  }

  // ── What's on screen ──
  // Candidates: the last app seen on screen first, then catalog apps, then
  // anything else the TV says is installed. Each poll checks a few, in small
  // parallel batches, and stops at the first visible one.
  #candidates() {
    const now = Date.now();
    const out = [];
    const seen = new Set();
    const add = (id) => {
      if (!id || seen.has(id)) return;
      const missing = this.#missing.get(id);
      if (missing && now - missing < MISSING_TTL) return;
      seen.add(id);
      out.push(id);
    };
    for (const id of this.#mru) add(id);
    const installed = this.#installed ? new Set(this.#installed.map((a) => a.id)) : null;
    for (const id of SAMSUNG_IDS) if (!installed || installed.has(id) || this.#known.has(id)) add(id);
    for (const a of this.#installed ?? []) add(a.id);
    return out;
  }

  async #status(id) {
    try {
      const s = await this.#getJson(`/api/v2/applications/${encodeURIComponent(id)}`, 1500);
      this.#missing.delete(id);
      if (s?.name) this.#known.set(id, s.name);
      return s;
    } catch (err) {
      if (err.http === 404) this.#missing.set(id, Date.now());
      return null;
    }
  }

  async #readApp(full) {
    const hit = (id, s) => {
      this.#mru = [id, ...this.#mru.filter((x) => x !== id)].slice(0, 12);
      this.#sinceHit = 0;
      return { id, title: s.name || this.#known.get(id) || null };
    };
    const current = this.state.app;
    if (current) {
      const s = await this.#status(current);
      if (s?.visible) return hit(current, s);
    }
    const list = this.#candidates().filter((id) => id !== current);
    if (!list.length) return null;
    const budget = full ? list.length : PER_TICK[this.#active ? 'active' : 'idle'];
    // Rotate through the list across polls so every app gets looked at.
    if (full || this.#cursor >= list.length) this.#cursor = 0;
    const slice = full ? list : [...list, ...list].slice(this.#cursor, this.#cursor + Math.min(budget, list.length));
    this.#cursor = full ? 0 : (this.#cursor + slice.length) % list.length;
    for (let i = 0; i < slice.length; i += PARALLEL) {
      const batch = slice.slice(i, i + PARALLEL);
      const answers = await Promise.all(batch.map((id) => this.#status(id)));
      const j = answers.findIndex((s) => s?.visible);
      if (j >= 0) return hit(batch[j], answers[j]);
    }
    this.#sinceHit += slice.length;
    return null;
  }

  // ── Websocket (commands) ───────────────────────────────
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
    // Mute with a known state: set it exactly over UPnP instead of toggling.
    if (name === 'mute' && this.#dmrSeen && this.state.muted != null) {
      try {
        await this.#rc('SetMute', { DesiredMute: this.state.muted ? 0 : 1 });
        this.setState({ muted: !this.state.muted });
        return;
      } catch {}
    }
    const code = keyCode('samsung', name);
    if (!code) throw unsupported(`The "${name}" button`);
    try {
      if (!hold) return await this.#sendKey(code);
      await this.#sendKey(code, 'Press');
      await new Promise((r) => setTimeout(r, Math.min(hold, 3000)));
      await this.#sendKey(code, 'Release');
    } catch (err) {
      // The websocket is down but the renderer answers: volume still works.
      if ((name === 'volup' || name === 'voldown') && this.#dmrSeen && this.state.volume != null) {
        return this.setVolume(this.state.volume + (name === 'volup' ? 1 : -1));
      }
      throw err;
    }
  }

  async setVolume(level) {
    if (!this.#dmrSeen) throw unsupported('Setting the volume level');
    const volume = Math.max(0, Math.min(100, Math.round(level)));
    try {
      await this.#rc('SetVolume', { DesiredVolume: volume });
    } catch {
      throw offline();
    }
    this.setState({ volume });
  }

  async powerOn() {
    // Wake-on-LAN first (harmless if it's already on)…
    if (this.tv.macs?.length) await super.powerOn().catch(() => {});
    // …then, if the set still answers: 2018+ in standby take a POWER key;
    // older sets can't always say whether they're asleep, so POWER acts as a
    // toggle, exactly like the TV's own remote.
    this.#offUntil = 0;
    if (this.state.online && (this.state.power === 'standby' || this.state.power === 'unknown')) {
      await this.#sendKey('KEY_POWER').catch(() => {});
    } else if (!this.tv.macs?.length) {
      await super.powerOn();
    }
  }

  async powerOff() {
    if (!this.state.online || this.state.power === 'standby') return;
    await this.#sendKey('KEY_POWER');
    // The set keeps answering for a while after it goes dark; don't flip
    // back to "on"/"unknown" on the next poll.
    this.#offUntil = Date.now() + OFF_GRACE;
    this.setState({ power: 'standby', app: null, appTitle: null });
  }

  // When the power state can't be read, one button, one toggle.
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

  // Installed apps from the websocket; if that's down, the catalog apps the
  // REST endpoint confirms are installed.
  async apps({ fresh = false } = {}) {
    if (!fresh && this.#installed && Date.now() - this.#installedAt < APPS_TTL) return this.#installed;
    try {
      const data = await this.#ask(
        { method: 'ms.channel.emit', params: { event: 'ed.installedApp.get', to: 'host', data: '' } },
        'ed.installedApp.get',
      );
      const list = data?.data ?? [];
      for (const app of list) this.#appTypes.set(app.appId, app.app_type);
      this.#installed = list.map((app) => ({ id: String(app.appId), title: app.name, icon: null }));
    } catch (err) {
      const found = [];
      for (let i = 0; i < SAMSUNG_IDS.length; i += PARALLEL) {
        const answers = await Promise.all(SAMSUNG_IDS.slice(i, i + PARALLEL).map((id) => this.#status(id)));
        answers.forEach((s, j) => s?.name && found.push({ id: SAMSUNG_IDS[i + j], title: s.name, icon: null }));
      }
      if (!found.length) throw err;
      this.#installed = found;
    }
    this.#installedAt = Date.now();
    return this.#installed;
  }

  // Launch over the websocket, then check the app really came up; if the
  // websocket is down or nothing happened, ask the REST endpoint to run it.
  async launch(id) {
    id = String(id);
    let wsErr = null;
    try {
      await this.#send({
        method: 'ms.channel.emit',
        params: {
          event: 'ed.apps.launch',
          to: 'host',
          data: { appId: id, action_type: this.#appTypes.get(id) === 2 ? 'DEEP_LINK' : 'NATIVE_LAUNCH' },
        },
      });
    } catch (err) {
      wsErr = err;
    }
    if (!wsErr && (await this.#cameUp(id, this.launchWaitMs))) return this.#launched(id);
    let res;
    try {
      res = await fetch(`${this.rest}/api/v2/applications/${encodeURIComponent(id)}`, { method: 'POST', signal: AbortSignal.timeout(4000) });
    } catch {
      throw wsErr ?? offline();
    }
    if (res.status === 404) throw new HearthError(404, 'That app isn’t installed on this TV');
    if (!res.ok) throw wsErr ?? new HearthError(502, `The TV couldn’t open that app (${res.status})`);
    this.#launched(id);
  }

  #launched(id) {
    this.#mru = [id, ...this.#mru.filter((x) => x !== id)];
    this.refresh();
  }

  async #cameUp(id, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if ((await this.#status(id))?.visible) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }
}
