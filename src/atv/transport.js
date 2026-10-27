import { EventEmitter } from 'node:events';
import net from 'node:net';
import { HearthError } from '../errors.js';
import { beginPairing, CompanionClient, HID, MCC } from './companion.js';
import { PairingError, PairVerify } from './hap.js';
import { CompanionLink, FRAME } from './link.js';
import { float } from './opack.js';

// The pure-JS Apple TV transport. It answers the same ops as the pyatv
// bridge (src/atv-bridge.js: info, pair_begin, pair_pin, pair_cancel,
// connect, disconnect, remote, power, apps, launch, set_volume, text) and
// emits the same 'state'/'closed' events, so AppleTvDriver runs on either.
// Companion only: keys, power, apps. No AirPlay/MRP, so no "what's
// playing" and one pairing code instead of two. No typing (that needs
// tvOS's keyed-archiver text payloads).

// Companion's port isn't fixed (49153 on this house's Apple TVs). Without
// mDNS: the port we saved, then these.
export const COMMON_PORTS = [49152, 49153, 49154, 49155, 49156, 49157, 49158, 49159, 49160];

const HOLDABLE = { up: HID.Up, down: HID.Down, left: HID.Left, right: HID.Right, select: HID.Select, menu: HID.Menu, home: HID.Home };
const BUTTONS = {
  volume_up: HID.VolumeUp, volume_down: HID.VolumeDown, play_pause: HID.PlayPause,
  channel_up: HID.ChannelIncrement, channel_down: HID.ChannelDecrement, control_center: HID.PageDown,
  guide: HID.Guide, screensaver: HID.Screensaver,
};
const MEDIA = {
  play: [MCC.Play], pause: [MCC.Pause], next: [MCC.NextTrack], previous: [MCC.PreviousTrack],
  skip_forward: [MCC.SkipBy, { _skpS: float(10) }], skip_backward: [MCC.SkipBy, { _skpS: float(-10) }],
};

const fail = (status, code, message) => Object.assign(new HearthError(status, message), { code });
const offline = (msg = 'The Apple TV didn’t answer. Is it on the same Wi-Fi?') => fail(503, 'offline', msg);
const authFailed = (msg) => fail(401, 'auth', msg);

// AirPlay GET :7000/info is a binary plist with the model in plain ASCII.
async function airplayInfo(ip, timeout = 2000) {
  const res = await fetch(`http://${ip}:7000/info`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) return null;
  const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
  return { model: text.match(/AppleTV\d+,\d+/)?.[0] ?? null };
}

export class JsAtvTransport extends EventEmitter {
  kind = 'js';
  available = true;
  reason = '';
  keyboard = false; // capabilities.keyboard
  #clients = new Map(); // key → CompanionClient
  #pairings = new Map(); // key → PairingSession

  constructor({ ports = COMMON_PORTS, probeMs = 1500, info = airplayInfo, name = 'Hearth', connect = net.connect, holdMs = 1000 } = {}) {
    super();
    Object.assign(this, { ports, probeMs, infoFn: info, name, connectFn: connect, holdMs });
    this.setMaxListeners(0);
  }

  async request(op, args = {}, { timeout = 30_000 } = {}) {
    const fn = this[`op_${op}`];
    if (!fn) throw fail(501, 'unsupported', `Unknown op ${op}`);
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail(504, 'timeout', 'The Apple TV took too long to answer')), timeout + 2000);
      timer.unref?.();
    });
    try {
      return await Promise.race([fn.call(this, args), deadline]);
    } catch (err) {
      throw asTransportError(err);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── finding the port ───────────────────────────────────
  // A Companion port answers PV_Start (pair-verify step 1) with its own key.
  // That's harmless: no code appears and nothing is remembered, because we
  // hang up before step 3.
  async probe(ip, port) {
    const link = new CompanionLink({ host: ip, port, timeout: this.probeMs, connect: this.connectFn });
    try {
      await link.open({ timeout: this.probeMs });
      const throwaway = new PairVerify(null);
      const reply = await link.auth(FRAME.PV_Start, { _pd: throwaway.m1(), _auTy: 4 }, this.probeMs);
      return Buffer.isBuffer(reply?._pd);
    } catch {
      return false;
    } finally {
      link.close();
    }
  }

  async findPort(ip, saved) {
    if (saved && (await this.probe(ip, saved))) return saved;
    const rest = this.ports.filter((p) => p !== saved);
    const hits = await Promise.all(rest.map((p) => this.probe(ip, p).then((ok) => (ok ? p : null))));
    const port = hits.find(Boolean);
    if (!port) throw offline();
    return port;
  }

  // ── ops ────────────────────────────────────────────────
  async op_info({ ip, port }) {
    const found = await this.findPort(ip, port);
    const extra = await Promise.resolve(this.infoFn?.(ip)).catch(() => null);
    return {
      ip,
      model: extra?.model ?? null,
      appleTv: true,
      services: { companion: { port: found, pairing: 'Mandatory' } },
    };
  }

  async op_pair_begin({ key, ip, port, protocol = 'companion' }) {
    if (protocol !== 'companion') throw fail(501, 'unsupported', `This Hearth can’t pair ${protocol}`);
    this.op_pair_cancel({ key });
    const found = await this.findPort(ip, port);
    const session = await beginPairing({ host: ip, port: found, name: this.name, connect: this.connectFn });
    session.port = found;
    this.#pairings.set(key, session);
    session.link.once('close', () => this.#pairings.get(key) === session && this.#pairings.delete(key));
    return { protocol, devicePin: true, port: found };
  }

  async op_pair_pin({ key, pin }) {
    const session = this.#pairings.get(key);
    this.#pairings.delete(key);
    if (!session) throw fail(410, 'expired', 'That code expired. Ask the Apple TV for a new one.');
    const credentials = await session.finish(pin);
    return { protocol: 'companion', credentials, port: session.port };
  }

  op_pair_cancel({ key }) {
    this.#pairings.get(key)?.close();
    this.#pairings.delete(key);
    return {};
  }

  async op_connect({ key, ip, port, credentials = {} }) {
    await this.op_disconnect({ key });
    const creds = credentials.companion;
    if (!creds) throw authFailed('This Apple TV isn’t paired with Hearth yet');
    let client;
    let used = port;
    try {
      if (!port) throw offline();
      client = await this.#open(ip, port, creds);
    } catch (err) {
      if (err.code === 'auth') throw err; // the keys were refused: a new port won't help
      used = await this.findPort(ip, port); // DHCP or a tvOS update moved it
      client = await this.#open(ip, used, creds);
    }
    this.#clients.set(key, client);
    client.on('state', (state) => this.#clients.get(key) === client && this.emit('state', { event: 'state', key, state }));
    client.once('close', () => {
      if (this.#clients.get(key) !== client) return;
      this.#clients.delete(key);
      this.emit('closed', { event: 'closed', key, reason: 'closed' });
    });
    return { ip, port: used, state: client.snapshot() };
  }

  async #open(ip, port, credentials) {
    const client = new CompanionClient({ host: ip, port, credentials, name: this.name, connect: this.connectFn, holdMs: this.holdMs });
    return client.connect();
  }

  async op_disconnect({ key }) {
    const client = this.#clients.get(key);
    this.#clients.delete(key);
    await client?.close();
    return {};
  }

  #client(key) {
    const client = this.#clients.get(key);
    if (!client?.connected) throw offline('Not connected to that Apple TV');
    return client;
  }

  op_state({ key }) {
    return this.#client(key).snapshot();
  }

  async op_remote({ key, method, hold }) {
    const client = this.#client(key);
    if (HOLDABLE[method]) await client.press(HOLDABLE[method], { hold: Boolean(hold) });
    else if (BUTTONS[method]) await client.press(BUTTONS[method]);
    else if (MEDIA[method]) await client.mediaControl(...MEDIA[method]);
    else throw fail(501, 'unsupported', `The ${method.replace(/_/g, ' ')} button isn’t supported on this Apple TV without AirPlay`);
    return {};
  }

  async op_power({ key, on }) {
    const client = this.#client(key);
    await (on ? client.powerOn() : client.powerOff());
    return {};
  }

  op_apps({ key }) {
    return this.#client(key).apps();
  }

  async op_launch({ key, app }) {
    await this.#client(key).launch(String(app));
    return {};
  }

  async op_set_volume({ key, level }) {
    await this.#client(key).setVolume(Number(level));
    return {};
  }

  op_text() {
    throw fail(501, 'unsupported', 'Typing isn’t supported on this TV');
  }

  async close() {
    for (const key of [...this.#pairings.keys()]) this.op_pair_cancel({ key });
    await Promise.all([...this.#clients.keys()].map((key) => this.op_disconnect({ key })));
  }
}

// Pairing failures keep the bridge's codes (auth → 401 "Show the number
// again" in the driver); network trouble is offline (503).
function asTransportError(err) {
  if (err instanceof PairingError) {
    if (err.code === 'auth') return authFailed(err.message);
    if (err.code === 'busy') return fail(409, 'busy', err.message);
    return fail(502, 'error', err.message);
  }
  if (err instanceof HearthError) return err;
  return offline(err?.message || undefined);
}

// One per Hearth process, like the bridge. Tests swap in one aimed at a fake.
let shared = null;
export function getJsTransport() {
  shared ??= new JsAtvTransport();
  return shared;
}
export function setJsTransport(transport) {
  shared = transport;
}
export async function closeJsTransport() {
  await shared?.close();
}
