import path from 'node:path';
import LGTV from 'lgtv2';
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
};

const PAIR_TIMEOUT = 60_000;
const UNREACHABLE = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTDOWN']);

export class LgDriver extends Driver {
  static brand = 'lg';
  capabilities = { volumeLevel: true, inputs: true, toast: true, appIcons: true };
  #client = null;
  #pointer = null;

  start() {
    if (this.#client) return;
    const client = new LGTV({
      host: this.tv.ip,
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
    client.on('error', (err) => this.emit('connection-error', err));
    this.#client = client;
  }

  async stop() {
    const client = this.#client;
    this.#client = null;
    this.#pointer = null;
    if (client) await client.disconnect().catch(() => {});
  }

  pair() {
    if (this.#client?.connected) return Promise.resolve();
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
      if (!err && res) this.setState({ app: res.appId || null });
    });
    client.subscribePowerState((err, res) => {
      if (!err && res) this.setState({ power: res.state === 'unknown' ? 'on' : res.state });
    });

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

  async #request(uri, payload) {
    if (!this.#client?.connected) throw offline();
    return this.#client.request(uri, payload);
  }

  async #button(name) {
    if (!this.#client?.connected) throw offline();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.#pointer ??= await this.#client.getSocket(SSAP.pointer);
        this.#pointer.send('button', { name });
        return;
      } catch (err) {
        // The input socket can go stale while the main one stays up; reopen once.
        this.#pointer = null;
        if (attempt) throw err;
      }
    }
  }

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

  async toast(message) {
    await this.#request(SSAP.toast, { message: String(message).slice(0, 120) });
  }
}
