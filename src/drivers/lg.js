import { parseLgMedia } from '../../web/playback.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import LGTV, { POWER_STATES } from 'lgtv2';
import WebSocket from 'ws';
import { HearthError, offline, unsupported } from '../errors.js';
import { isMac } from '../discovery.js';
import { keyCode } from '../keys.js';
import { hearthHome } from '../store.js';
import { Driver } from './base.js';

// LG webOS (2014+). Talks SSAP over a websocket on :3001 (wss) or :3000 (ws);
// lgtv2 handles the handshake, the pairing prompt and the port fallback.
const SSAP = {
  volume: 'ssap://audio/getVolume',
  setVolume: 'ssap://audio/setVolume',
  foreground: 'ssap://com.webos.applicationManager/getForegroundAppInfo',
  media: 'ssap://com.webos.media/getForegroundAppInfo',
  launchPoints: 'ssap://com.webos.applicationManager/listLaunchPoints',
  launch: 'ssap://system.launcher/launch',
  inputs: 'ssap://tv/getExternalInputList',
  switchInput: 'ssap://tv/switchInput',
  turnOff: 'ssap://system/turnOff',
  screenOn: 'ssap://com.webos.service.tvpower/power/turnOnScreen',
  toast: 'ssap://system.notifications/createToast',
  systemInfo: 'ssap://system/getSystemInfo',
  network: 'ssap://com.webos.service.connectionmanager/getinfo',
  pointer: 'ssap://com.webos.service.networkinput/getPointerInputSocket',
  power: 'ssap://com.webos.service.tvpower/power/getPowerState',
  insertText: 'ssap://com.webos.service.ime/insertText',
  deleteText: 'ssap://com.webos.service.ime/deleteCharacters',
  enter: 'ssap://com.webos.service.ime/sendEnterKey',
};

const PAIR_TIMEOUT = 60_000;
const PIN_TIMEOUT = 120_000;

// lgtv2's signed app manifest; PIN pairing sends the same one.
const MANIFEST = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve('lgtv2'))), 'pairing.json'), 'utf8'),
).manifest;
const UNREACHABLE = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTDOWN']);

export class LgDriver extends Driver {
  static brand = 'lg';
  capabilities = { volumeLevel: true, inputs: true, toast: true, appIcons: true, pointer: true, keyboard: true };
  // HDMI app id → the CEC name of what's plugged in ("PlayStation 5").
  #inputLabels = new Map();
  #client = null;
  #pointer = null;

  constructor(tv, opts = {}) {
    super(tv, opts);
    this.pinUrls = opts.pinUrls; // tests point PIN pairing at a fake TV
    this.url = opts.url; // tests point the main connection at a fake TV
  }

  start() {
    if (this.#client) return;
    const client = new LGTV({
      ...(this.url ? { url: this.url } : { host: this.tv.ip }),
      // '' rather than undefined so lgtv2 never reads a stray ~/.lgtv2 key file.
      clientKey: this.tv.credentials?.clientKey ?? '',
      keyFile: path.join(hearthHome(), 'lg', this.tv.id),
      saveKey: (key, cb) => {
        this.onCredentials({ clientKey: key });
        cb();
      },
      learnMac: false,
      reconnect: 5000,
      timeout: 8000,
    });
    client.on('connect', () => this.#onConnect());
    client.on('prompt', () => this.emit('prompt'));
    client.on('close', () => {
      this.#pointer = null;
      this.setState({ online: false, power: 'off', app: null });
    });
    // Connection errors are expected whenever the TV is off; the reconnect
    // loop retries and 'close' already marks the TV offline.
    // A TV that was already off when Hearth started never connects, so 'close' never fires: say so
    // instead of leaving the first-boot 'unknown' up (webOS drops Wi-Fi when fully off).
    client.on('error', (err) => {
      if (!client.connected) this.setState({ online: false, power: 'off', app: null, inputLabel: null });
      this.emit('connection-error', err);
    });
    this.#client = client;
  }

  async stop() {
    const client = this.#client;
    this.#client = null;
    this.#pointer = null;
    if (client) await client.disconnect().catch(() => {});
  }

  // Two ways in. Default: the TV asks "Allow?" and someone presses OK on its
  // remote. PIN mode, for TVs nobody can reach: the TV shows a number, you
  // type it in the app (first call returns { needsPin }, second sends it).
  pair({ mode, pin } = {}) {
    if (this.#client?.connected) return Promise.resolve();
    if (pin) return this.#finishPin(pin);
    if (mode === 'pin') return this.#startPin();
    this.start();
    return new Promise((resolve, reject) => {
      let prompted = false;
      const finish = (err) => {
        clearTimeout(timer);
        this.off('connect', onConnect);
        this.off('prompt', onPrompt);
        this.off('connection-error', onError);
        if (err) {
          // Don't leave a half-paired TV re-prompting every 5 seconds.
          this.stop();
          reject(err);
        } else resolve();
      };
      const onConnect = () => finish();
      const onPrompt = () => (prompted = true);
      const onError = (err) => {
        if (/reject|denied|cancel/i.test(err.message)) finish(new HearthError(403, 'Pairing was declined on the TV'));
        else if (!prompted && UNREACHABLE.has(err.code)) finish(offline());
      };
      const timer = setTimeout(
        () => finish(new HearthError(408, prompted ? 'Nobody pressed Allow on the TV in time' : 'The TV never answered')),
        PAIR_TIMEOUT,
      );
      this.on('connect', onConnect);
      this.on('prompt', onPrompt);
      this.on('connection-error', onError);
    });
  }

  #pin = null;

  async #startPin() {
    this.#pin?.ws.terminate();
    const urls = this.pinUrls ?? [`wss://${this.tv.ip}:3001`, `ws://${this.tv.ip}:3000`];
    let lastErr;
    for (const url of urls) {
      try {
        const ws = await new Promise((resolve, reject) => {
          const sock = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 5000 });
          sock.once('open', () => resolve(sock));
          sock.once('error', reject);
        });
        const session = { ws, waiting: new Map(), key: null };
        ws.on('message', (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (msg.type === 'registered' && msg.payload?.['client-key']) session.key = msg.payload['client-key'];
          session.waiting.get(msg.id)?.(msg);
        });
        ws.on('close', () => {
          for (const fn of session.waiting.values()) fn({ type: 'error', error: 'closed' });
        });
        session.timer = setTimeout(() => ws.terminate(), PIN_TIMEOUT);
        this.#pin = session;
        const res = await this.#pinSend('register', 'register', {
          forcePairing: false,
          pairingType: 'PIN',
          manifest: MANIFEST,
        });
        if (res.type === 'error') throw new HearthError(502, `The TV refused PIN pairing (${res.error})`);
        return { needsPin: true };
      } catch (err) {
        lastErr = err;
        this.#pin?.ws.terminate();
        this.#pin = null;
        if (err instanceof HearthError) throw err;
      }
    }
    throw UNREACHABLE.has(lastErr?.code) ? offline() : lastErr;
  }

  #pinSend(type, id, payload, uri) {
    const { ws, waiting } = this.#pin;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ type: 'error', error: 'timeout' });
      }, 15_000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(msg);
      });
      ws.send(JSON.stringify({ type, id, ...(uri ? { uri } : {}), payload }));
    });
  }

  async #finishPin(pin) {
    const session = this.#pin;
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      throw new HearthError(409, 'The number timed out. Tap “Show the number again”.');
    }
    const registered = new Promise((resolve) => session.waiting.set('register', resolve));
    const res = await this.#pinSend('request', 'pin', { pin: String(pin) }, 'ssap://pairing/setPin');
    if (res.type === 'error' || res.payload?.returnValue === false) {
      throw new HearthError(400, 'That number didn’t match. Check the TV and try again.');
    }
    const reg = session.key ? { payload: { 'client-key': session.key } } : await Promise.race([registered, new Promise((r) => setTimeout(() => r(null), 10_000))]);
    const key = reg?.payload?.['client-key'];
    clearTimeout(session.timer);
    session.ws.close();
    this.#pin = null;
    if (!key) throw new HearthError(502, 'The TV accepted the number but didn’t finish pairing. Try again.');
    this.tv.credentials = { ...this.tv.credentials, clientKey: key };
    this.onCredentials({ clientKey: key });
    await this.stop();
    this.start();
  }

  async #onConnect() {
    this.setState({ online: true, power: 'on' });
    this.emit('connect');
    const client = this.#client;
    client.subscribe(SSAP.volume, (err, res) => {
      if (err || !res) return;
      const v = res.volumeStatus ?? res;
      this.setState({ volume: v.volume ?? null, muted: v.muteStatus ?? v.muted ?? null });
    });
    client.subscribe(SSAP.foreground, (err, res) => {
      if (err || !res) return;
      const on = this.state.power === 'on';
      // Asleep: nothing is "playing", whatever the launcher last had up.
      this.setState({ app: on ? res.appId || null : null, inputLabel: on ? (this.#inputLabels.get(res.appId) ?? null) : null });
    });
    // The media pipeline's play state (webOS 4+); older sets just never answer.
    client.subscribe(SSAP.media, (err, res) => {
      if (err || !res) return;
      this.setState({ media: this.state.power === 'on' ? parseLgMedia(res) : null });
    });
    client.subscribePowerState((err, res) => {
      if (err || !res) return;
      const power = res.state === 'unknown' ? 'on' : res.state;
      const was = this.state.power;
      // Asleep (Active Standby / Screen Off): nothing is "playing" any more.
      this.setState(power === 'on' ? { power } : { power, app: null, inputLabel: null, media: null });
      if (power === 'on' && was !== 'on') this.refresh();
    });

    // Learn what's plugged into each HDMI port (CEC names) for activity.
    client
      .request(SSAP.inputs)
      .then((res) => {
        for (const d of res?.devices ?? []) if (d.appId && d.label) this.#inputLabels.set(d.appId, d.label);
        if (this.state.app) this.setState({ inputLabel: this.#inputLabels.get(this.state.app) ?? null });
      })
      .catch(() => {});

    const info = {};
    if (!this.tv.model) {
      const sys = await client.request(SSAP.systemInfo).catch(() => null);
      if (sys?.modelName) info.model = sys.modelName;
    }
    if (!this.tv.macs?.length) {
      const net = await client.request(SSAP.network).catch(() => null);
      const macs = [net?.wiredInfo?.macAddress, net?.wifiInfo?.macAddress].filter(isMac).map((m) => m.toLowerCase());
      if (macs.length) info.macs = macs;
    }
    if (Object.keys(info).length) this.onInfo(info);
  }

  // Re-read power, foreground app and volume. Subscriptions normally push
  // these, but a command or a power transition is worth double-checking.
  async refresh() {
    const client = this.#client;
    if (!client?.connected) return;
    const [fg, vol, pw] = await Promise.all([
      client.request(SSAP.foreground).catch(() => null),
      client.request(SSAP.volume).catch(() => null),
      client.request(SSAP.power).catch(() => null),
    ]);
    const patch = {};
    const power = pw?.state ? (POWER_STATES[pw.state] ?? 'on') : this.state.power;
    if (pw?.state) patch.power = power;
    if (fg && power === 'on') {
      patch.app = fg.appId || null;
      patch.inputLabel = this.#inputLabels.get(fg.appId) ?? null;
    }
    if (power !== 'on') Object.assign(patch, { app: null, inputLabel: null });
    const v = vol?.volumeStatus ?? vol;
    if (v && (v.volume != null || v.muteStatus != null || v.muted != null)) {
      patch.volume = v.volume ?? this.state.volume;
      patch.muted = v.muteStatus ?? v.muted ?? this.state.muted;
    }
    this.setState(patch);
  }

  async #request(uri, payload) {
    if (!this.#client?.connected) throw offline();
    return this.#client.request(uri, payload);
  }

  async #button(name) {
    return this.#input('button', { name });
  }

  // Everything on the pointer-input socket: buttons, moves, clicks, scrolls.
  async #input(type, payload) {
    if (!this.#client?.connected) throw offline();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.#pointer ??= await this.#client.getSocket(SSAP.pointer);
        this.#pointer.send(type, payload);
        return;
      } catch (err) {
        // The input socket can go stale while the main one stays up; reopen once.
        this.#pointer = null;
        if (attempt) throw err;
      }
    }
  }

  // webOS has no press-and-hold over the network; a hold is one click (the
  // app repeats arrows and volume itself while a finger stays down).
  async key(name) {
    const code = keyCode('lg', name);
    if (!code) throw unsupported(`The "${name}" button`);
    await this.#button(code);
  }

  async powerOn() {
    if (this.#client?.connected && this.state.power === 'screen_off') {
      await this.#request(SSAP.screenOn);
      return;
    }
    await super.powerOn();
  }

  async powerOff() {
    await this.#request(SSAP.turnOff);
  }

  async setVolume(level) {
    await this.#request(SSAP.setVolume, { volume: Math.max(0, Math.min(100, Math.round(level))) });
  }

  async apps() {
    const res = await this.#request(SSAP.launchPoints);
    return (res.launchPoints ?? []).map((lp) => ({ id: lp.id, title: lp.title, icon: lp.icon || lp.largeIcon || null }));
  }

  async launch(id) {
    await this.#request(SSAP.launch, { id });
  }

  async inputs() {
    const res = await this.#request(SSAP.inputs);
    return (res.devices ?? []).map((d) => ({ id: d.id, label: d.label || d.id, connected: Boolean(d.connected) }));
  }

  async setInput(id) {
    await this.#request(SSAP.switchInput, { inputId: id });
  }

  async pointer({ type, dx = 0, dy = 0 } = {}) {
    const x = Math.round(Number(dx) || 0);
    const y = Math.round(Number(dy) || 0);
    if (type === 'move') return this.#input('move', { dx: x, dy: y, down: 0 });
    if (type === 'click') return this.#input('click');
    if (type === 'scroll') return this.#input('scroll', { dx: x, dy: y });
    throw unsupported(`Pointer "${type}"`);
  }

  async text({ text, backspace, enter } = {}) {
    if (text) await this.#request(SSAP.insertText, { text: String(text).slice(0, 500), replace: 0 });
    if (backspace) await this.#request(SSAP.deleteText, { count: Math.min(100, Number(backspace) || 1) });
    if (enter) await this.#request(SSAP.enter);
  }

  async toast(message) {
    await this.#request(SSAP.toast, { message: String(message).slice(0, 120) });
  }

  // ── Connection doctor: read-only. Waits for the websocket to either
  // connect with our key, ask the TV for permission again (key no longer
  // accepted), or be refused. Never sends a button.
  async verify(timeout = 8000) {
    if (!this.tv.credentials?.clientKey) return { ok: false, auth: 'missing', how: 'lg-pin', detail: 'Not paired yet' };
    this.start();
    if (!this.#client.connected) {
      const outcome = await new Promise((resolve) => {
        const done = (v) => {
          clearTimeout(timer);
          this.off('connect', onConnect);
          this.off('prompt', onPrompt);
          this.off('connection-error', onError);
          resolve(v);
        };
        const onConnect = () => done('ok');
        const onPrompt = () => done('prompt');
        const onError = (err) => {
          if (/reject|denied|cancel|403/i.test(err.message)) done('rejected');
        };
        const timer = setTimeout(() => done('timeout'), timeout);
        this.on('connect', onConnect);
        this.on('prompt', onPrompt);
        this.on('connection-error', onError);
      });
      if (outcome === 'prompt' || outcome === 'rejected') {
        return { ok: true, auth: outcome, how: 'lg-pin', detail: outcome === 'prompt' ? 'The TV no longer recognises Hearth’s key and is asking again' : 'The TV refused Hearth’s key' };
      }
      if (outcome === 'timeout') return { ok: false, auth: 'ok', detail: 'The TV didn’t answer on ports 3001/3000' };
    }
    const t0 = Date.now();
    const sys = await this.#client.request(SSAP.systemInfo).catch((err) => ({ error: err.message }));
    const power = await this.#client.request('ssap://com.webos.service.tvpower/power/getPowerState').catch(() => null);
    if (sys?.error) return { ok: true, auth: /401|403|denied/i.test(sys.error) ? 'rejected' : 'ok', how: 'lg-pin', detail: sys.error };
    return { ok: true, auth: 'ok', detail: `${sys?.modelName ?? 'LG'} answered in ${Date.now() - t0} ms${power?.state ? ` · ${power.state}` : ''}` };
  }

  // ── Health & diagnostics (read-only SSAP queries) ──
  async diagnostics() {
    if (!this.#client?.connected) return { connected: false };
    const ask = (uri) => this.#client.request(uri).catch((err) => ({ error: err.message }));
    const [system, software, network, volume, power, launchPoints, inputs, foreground] = await Promise.all([
      ask(SSAP.systemInfo),
      ask('ssap://com.webos.service.update/getCurrentSWInformation'),
      ask(SSAP.network),
      ask(SSAP.volume),
      ask('ssap://com.webos.service.tvpower/power/getPowerState'),
      ask(SSAP.launchPoints),
      ask(SSAP.inputs),
      ask(SSAP.foreground),
    ]);
    return {
      connected: true,
      url: this.#client.urls?.[0] ?? null,
      system,
      software,
      network,
      volume,
      power,
      launchPointCount: launchPoints?.launchPoints?.length ?? null,
      inputs: inputs?.devices?.map((d) => ({ id: d.id, label: d.label, connected: d.connected })) ?? inputs,
      foreground,
    };
  }
}
