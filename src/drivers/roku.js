import { HearthError, offline, unsupported } from '../errors.js';
import { isMac, tvId } from '../discovery.js';
import { Driver } from './base.js';

// Roku (sticks, boxes and Roku TVs) over the External Control Protocol: plain
// HTTP on :8060, no pairing. Keys are POST /keypress/<Key>, real holds are
// /keydown + /keyup, state comes from /query/device-info and /query/active-app.
const POLL_MS = 5000;
const TIMEOUT = 3000;
const BLOCKED =
  'Roku blocked the remote. On the Roku: Settings → System → Advanced system settings → Control by mobile apps → Network access → Default (or Permissive).';

const KEYS = {
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'Select', back: 'Back', home: 'Home',
  menu: 'Info', info: 'Info', exit: 'Home',
  volup: 'VolumeUp', voldown: 'VolumeDown', mute: 'VolumeMute', chup: 'ChannelUp', chdown: 'ChannelDown',
  // Roku's Play toggles play/pause; there is no separate Pause or Stop.
  play: 'Play', pause: 'Play', stop: 'Play', rewind: 'Rev', forward: 'Fwd',
  source: 'InputTuner', // Roku TVs only
};

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
  return m ? decode(m[1].trim()) : '';
}

const POWER = { PowerOn: 'on', DisplayOff: 'standby', Ready: 'standby', Headless: 'standby' };

export function parseRokuDeviceInfo(xml) {
  return {
    name: tag(xml, 'friendly-device-name') || tag(xml, 'user-device-name') || tag(xml, 'default-device-name') || 'Roku',
    model: `${tag(xml, 'model-name')} ${tag(xml, 'model-number')}`.trim(),
    isTv: tag(xml, 'is-tv') === 'true',
    macs: [tag(xml, 'wifi-mac'), tag(xml, 'ethernet-mac')].filter(isMac).map((m) => m.toLowerCase()),
    power: POWER[tag(xml, 'power-mode')] ?? 'on',
  };
}

export async function rokuInfo(ip, timeout = 2000) {
  const res = await fetch(`http://${ip}:8060/query/device-info`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`Roku device-info → ${res.status}`);
  return parseRokuDeviceInfo(await res.text());
}

export function rokuFromInfo(ip, info) {
  return { id: tvId('roku', info.macs, ip), brand: 'roku', name: info.name, model: info.model, ip, macs: info.macs };
}

function parseApps(xml) {
  const apps = [];
  for (const m of xml.matchAll(/<app\b([^>]*)>([^<]*)<\/app>/gi)) {
    const attr = (n) => m[1].match(new RegExp(`${n}="([^"]*)"`))?.[1] ?? '';
    apps.push({ id: decode(attr('id')), type: attr('type'), title: decode(m[2].trim()) });
  }
  return apps.filter((a) => a.id);
}

export class RokuDriver extends Driver {
  static brand = 'roku';
  capabilities = { volumeLevel: false, inputs: false, toast: false, appIcons: true, pointer: false, keyboard: true };
  #poll = null;
  #isTv = null;

  constructor(tv, opts = {}) {
    super(tv, opts);
    this.base = opts.base ?? `http://${tv.ip}:8060`;
  }

  async #ecp(method, path) {
    let res;
    try {
      res = await fetch(`${this.base}${path}`, { method, signal: AbortSignal.timeout(TIMEOUT) });
    } catch {
      throw offline();
    }
    if (res.status === 403) throw new HearthError(403, BLOCKED);
    if (!res.ok) throw new HearthError(502, `The Roku said ${res.status}`);
    return res.text();
  }

  #learn(info) {
    if (this.#isTv === info.isTv) return;
    this.#isTv = info.isTv;
    // Inputs only exist on Roku TVs; tell the hub the capability changed.
    this.capabilities = { ...this.capabilities, inputs: info.isTv };
    this.emit('state', this.state);
  }

  async #info() {
    const info = parseRokuDeviceInfo(await this.#ecp('GET', '/query/device-info'));
    this.#learn(info);
    return info;
  }

  start() {
    if (this.#poll) return;
    const tick = async () => {
      try {
        const info = await this.#info();
        const active = await this.#ecp('GET', '/query/active-app').catch(() => '');
        // The home screen is <app>Roku</app> with no id.
        const m = active.match(/<app\b[^>]*\bid="([^"]+)"[^>]*>([^<]*)</);
        const app = m?.[1] ?? null;
        const appTitle = m ? m[2].replace(/&amp;/g, '&').replace(/&apos;|&#39;/g, "'").trim() || null : null;
        this.setState({ online: true, power: info.power, app, appTitle });
      } catch {
        this.setState({ online: false, power: 'off', app: null, appTitle: null });
      }
    };
    tick();
    this.#poll = setInterval(tick, POLL_MS);
    this.#poll.unref?.();
  }

  async stop() {
    clearInterval(this.#poll);
    this.#poll = null;
  }

  // Nothing to pair: prove we can reach it, then remember it as connected.
  async pair() {
    await this.#info();
    this.onCredentials({ ecp: true });
    this.start();
  }

  async key(name, { hold = 0 } = {}) {
    const code = KEYS[name];
    if (!code || (name === 'source' && this.#isTv === false)) throw unsupported(`The "${name}" button`);
    if (!hold) {
      await this.#ecp('POST', `/keypress/${code}`);
      return;
    }
    await this.#ecp('POST', `/keydown/${code}`);
    await new Promise((r) => setTimeout(r, Math.min(hold, 3000)));
    await this.#ecp('POST', `/keyup/${code}`);
  }

  async powerOn() {
    try {
      await this.#ecp('POST', '/keypress/PowerOn');
    } catch (err) {
      if (err.status === 503 && this.tv.macs?.length) return super.powerOn();
      throw err;
    }
  }

  async powerOff() {
    await this.#ecp('POST', '/keypress/PowerOff');
  }

  async #allApps() {
    return parseApps(await this.#ecp('GET', '/query/apps')).filter((a) => a.type !== 'menu');
  }

  async apps() {
    return (await this.#allApps()).map((a) => ({ id: a.id, title: a.title, icon: `${this.base}/query/icon/${encodeURIComponent(a.id)}` }));
  }

  // Roku has no pointer, but it types: one Lit_<char> keypress per character.
  async text({ text, backspace, enter } = {}) {
    for (const ch of String(text ?? '').slice(0, 200)) await this.#ecp('POST', `/keypress/Lit_${encodeURIComponent(ch)}`);
    for (let i = 0; i < Math.min(100, Number(backspace) || 0); i++) await this.#ecp('POST', '/keypress/Backspace');
    if (enter) await this.#ecp('POST', '/keypress/Enter');
  }

  async launch(id) {
    await this.#ecp('POST', `/launch/${encodeURIComponent(id)}`);
  }

  async #requireTv() {
    if (this.#isTv === null) await this.#info();
    if (!this.#isTv) throw unsupported('Switching inputs');
  }

  async inputs() {
    await this.#requireTv();
    return (await this.#allApps()).filter((a) => a.type === 'tvin').map((a) => ({ id: a.id, label: a.title, connected: true }));
  }

  async setInput(id) {
    await this.#requireTv();
    await this.launch(id);
  }
}
