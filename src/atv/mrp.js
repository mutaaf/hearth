import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { decode, encode, first, fixedNumber, str } from '../proto.js';
import { linkError } from './link.js';

// Just enough MRP (MediaRemote protocol) for "what's playing": the messages,
// field numbers and state rules are pyatv 0.18's (protocols/mrp/messages.py,
// player_state.py, protobuf/*.proto). Every message is a ProtocolMessage
// { 1 type, 2 identifier, 4 errorCode, 85 uniqueIdentifier } with the inner
// message in its own extension field.

export const TYPE = {
  SEND_COMMAND: 1, SEND_COMMAND_RESULT: 2, SET_STATE: 4, DEVICE_INFO: 15, CLIENT_UPDATES_CONFIG: 16,
  GET_KEYBOARD_SESSION: 24, SET_CONNECTION_STATE: 38, GENERIC: 42,
  SET_NOW_PLAYING_CLIENT: 46, SET_NOW_PLAYING_PLAYER: 47, REMOVE_CLIENT: 53, REMOVE_PLAYER: 54,
  UPDATE_CLIENT: 55, UPDATE_CONTENT_ITEM: 56, SET_DEFAULT_SUPPORTED_COMMANDS: 72,
};
// The extension field that carries each type's inner message.
export const INNER = {
  [TYPE.SEND_COMMAND]: 6, [TYPE.SEND_COMMAND_RESULT]: 7, [TYPE.SET_STATE]: 9, [TYPE.DEVICE_INFO]: 20,
  [TYPE.CLIENT_UPDATES_CONFIG]: 21, [TYPE.SET_CONNECTION_STATE]: 42, [TYPE.SET_NOW_PLAYING_CLIENT]: 50,
  [TYPE.SET_NOW_PLAYING_PLAYER]: 51, [TYPE.REMOVE_CLIENT]: 57, [TYPE.REMOVE_PLAYER]: 58,
  [TYPE.UPDATE_CLIENT]: 59, [TYPE.UPDATE_CONTENT_ITEM]: 60,
};
export const COMMAND = { Play: 1, Pause: 2, TogglePlayPause: 3, Stop: 4, NextTrack: 5, PreviousTrack: 6 };
export const PLAYBACK = { Unknown: 0, Playing: 1, Paused: 2, Stopped: 3, Interrupted: 4, Seeking: 5 };
const DEFAULT_PLAYER = 'MediaRemote-DefaultPlayer';
const COCOA_EPOCH = 978307200; // 2001-01-01 in Unix seconds

const uuid = () => randomUUID().toUpperCase();

// A ProtocolMessage. Like pyatv's protobuf runtime: the message's own
// fields in number order, then the extension (byte-identical to pyatv).
export function message(type, inner = null, { identifier, uniqueIdentifier = uuid() } = {}) {
  const own = encode({ 1: type, 2: identifier || undefined, 4: 0, 85: uniqueIdentifier });
  return inner && INNER[type] ? Buffer.concat([own, encode({ [INNER[type]]: inner })]) : own;
}

// pyatv messages.device_information() with its InfoSettings defaults.
export const deviceInfo = ({ name = 'Hearth', uniqueIdentifier, identifier, uid } = {}) =>
  message(TYPE.DEVICE_INFO, {
    1: uniqueIdentifier, 2: name, 3: 'iPhone', 4: '18G82', 5: 'com.apple.TVRemote', 6: '344.28', 7: 1, 8: 108,
    9: true, 10: true, 12: 'com.apple.TVMusic', 13: true, 14: true, 15: true, 17: 2, 21: 1, 22: 1,
  }, { identifier, uniqueIdentifier: uid });
export const setConnectionState = (opts) => message(TYPE.SET_CONNECTION_STATE, { 1: 2 }, opts); // Connected
// artwork, volume, keyboard and output-device updates on; nowPlaying off (pyatv's defaults)
export const clientUpdatesConfig = (opts) => message(TYPE.CLIENT_UPDATES_CONFIG, { 1: true, 2: false, 3: true, 4: true, 5: true }, opts);
export const getKeyboardSession = (opts) => message(TYPE.GET_KEYBOARD_SESSION, null, opts);
export const sendCommand = (command, opts) => message(TYPE.SEND_COMMAND, { 1: command }, opts);

// ── reading ──────────────────────────────────────────────
const sub = (m, n) => (Buffer.isBuffer(m?.[n]?.[0]) ? decode(m[n][0]) : null);
const subs = (m, n) => (m?.[n] ?? []).filter(Buffer.isBuffer).map((b) => decode(b));
const num = (m, n) => (typeof first(m, n) === 'number' ? first(m, n) : null);
const has = (m, n) => m?.[n]?.length > 0;

// ProtocolMessage bytes → { type, identifier, errorCode, inner (decoded) }.
export function parseMessage(bytes) {
  const m = decode(bytes);
  const type = num(m, 1) ?? 0;
  return { type, identifier: str(m, 2), errorCode: num(m, 4) ?? 0, inner: INNER[type] ? sub(m, INNER[type]) ?? {} : {} };
}

const clientOf = (c) => ({ bundle: str(c, 2) ?? '', displayName: str(c, 7) });
const playerOf = (p) => ({ id: str(p, 1) ?? '', displayName: str(p, 2) });
const pathOf = (pp) => ({ client: clientOf(sub(pp, 2) ?? {}), player: playerOf(sub(pp, 3) ?? {}) });

// ContentItemMetadata, the fields Hearth reads.
const META = {
  title: [1, 's'], seasonNumber: [10, 'i'], episodeNumber: [11, 'i'], duration: [14, 'f'], elapsedTime: [35, 'f'],
  playbackRate: [39, 'f'], seriesName: [63, 's'], elapsedTimeTimestamp: [74, 'f'],
};
function metadataOf(m) {
  const out = {};
  for (const [name, [n, kind]] of Object.entries(META)) {
    if (!has(m, n)) continue;
    out[name] = kind === 's' ? str(m, n) : kind === 'f' ? fixedNumber(first(m, n)) : num(m, n);
  }
  return out;
}
const itemOf = (c) => ({ id: str(c, 1), metadata: has(c, 2) ? metadataOf(sub(c, 2)) : null });

// ── who's playing (pyatv player_state.py) ─────────────────
class Player {
  playbackState = null;
  items = [];
  location = 0;
  constructor(id, displayName) {
    this.id = id;
    this.displayName = displayName;
  }
  get metadata() {
    return this.items[this.location]?.metadata ?? null;
  }
  get state() {
    const s = this.playbackState;
    if (s == null) return null;
    if (s === PLAYBACK.Paused) return this.metadata ? PLAYBACK.Paused : null;
    if (s !== PLAYBACK.Playing) return s;
    const rate = this.metadata?.playbackRate;
    if (rate == null || Math.abs(rate) < 1e-9) return PLAYBACK.Playing;
    if (Math.abs(rate - 1) < 1e-9) return PLAYBACK.Playing;
    return PLAYBACK.Seeking;
  }
}

class Client {
  players = new Map();
  activePlayer = null;
  constructor(bundle, displayName) {
    this.bundle = bundle;
    this.displayName = displayName || null;
  }
  player(id, displayName) {
    if (!this.players.has(id)) this.players.set(id, new Player(id, displayName));
    const p = this.players.get(id);
    if (displayName) p.displayName = displayName;
    return p;
  }
  get active() {
    return this.activePlayer ?? this.players.get(DEFAULT_PLAYER) ?? new Player('', null);
  }
}

export class NowPlaying {
  #clients = new Map();
  #active = null;

  #client({ bundle, displayName }) {
    if (!this.#clients.has(bundle)) this.#clients.set(bundle, new Client(bundle, displayName));
    return this.#clients.get(bundle);
  }
  #player(path) {
    return this.#client(path.client).player(path.player.id, path.player.displayName);
  }

  // One parsed message in; true when it might change what's shown.
  handle({ type, inner }) {
    switch (type) {
      case TYPE.SET_STATE: {
        const player = this.#player(pathOf(sub(inner, 9) ?? {}));
        if (has(inner, 6)) player.playbackState = num(inner, 6);
        const queue = sub(inner, 3);
        if (queue) {
          player.items = subs(queue, 2).map(itemOf);
          player.location = num(queue, 1) ?? 0;
        }
        return true;
      }
      case TYPE.UPDATE_CONTENT_ITEM: {
        const player = this.#player(pathOf(sub(inner, 2) ?? {}));
        for (const update of subs(inner, 1).map(itemOf)) {
          const item = player.items.find((i) => i.id === update.id);
          if (item && update.metadata) item.metadata = { ...item.metadata, ...update.metadata };
        }
        return true;
      }
      case TYPE.SET_NOW_PLAYING_CLIENT:
        this.#active = this.#client(clientOf(sub(inner, 1) ?? {}));
        return true;
      case TYPE.SET_NOW_PLAYING_PLAYER: {
        const path = pathOf(sub(inner, 1) ?? {});
        const client = this.#client(path.client);
        client.activePlayer = path.player.id ? client.player(path.player.id, path.player.displayName) : null;
        return true;
      }
      case TYPE.UPDATE_CLIENT: {
        const c = clientOf(sub(inner, 1) ?? {});
        const client = this.#client(c);
        if (c.displayName) client.displayName = c.displayName;
        return true;
      }
      case TYPE.REMOVE_CLIENT: {
        const { bundle } = clientOf(sub(inner, 1) ?? {});
        const client = this.#clients.get(bundle);
        this.#clients.delete(bundle);
        if (client && client === this.#active) this.#active = null;
        return true;
      }
      case TYPE.REMOVE_PLAYER: {
        const path = pathOf(sub(inner, 1) ?? {});
        const client = this.#clients.get(path.client.bundle);
        const player = client?.players.get(path.player.id);
        if (player && path.player.id) {
          client.players.delete(path.player.id);
          if (client.activePlayer === player) client.activePlayer = null;
        }
        return true;
      }
      default:
        return false;
    }
  }

  // → the transport's state fields, as the Python bridge reports them.
  snapshot(now = Date.now()) {
    const client = this.#active;
    const player = client?.active;
    const meta = player?.metadata ?? {};
    const state = player?.state ?? null;
    let title = meta.title || null;
    if (meta.seriesName && title && !title.includes(meta.seriesName)) title = `${meta.seriesName}: ${title}`;
    // pyatv device_state: idle/stopped → nothing; Interrupted is loading;
    // anything unknown counts as paused.
    const playing = state == null || state === PLAYBACK.Stopped ? null
      : { [PLAYBACK.Playing]: 'playing', [PLAYBACK.Seeking]: 'playing', [PLAYBACK.Paused]: 'paused', [PLAYBACK.Interrupted]: 'loading' }[state] ?? 'paused';
    const duration = Number.isFinite(meta.duration) ? Math.trunc(meta.duration) : null;
    let position = null;
    if (meta.elapsedTimeTimestamp) {
      position = meta.elapsedTime || 0;
      const rate = meta.playbackRate ?? 0;
      if (playing === 'playing' && Math.abs(rate) > 1e-9) position += (now / 1000 - (meta.elapsedTimeTimestamp + COCOA_EPOCH)) * rate;
      position = Math.max(0, Math.trunc(position));
      if (duration != null) position = Math.min(position, duration);
    }
    return {
      app: client?.bundle || null,
      appTitle: client?.bundle ? client.displayName ?? null : null,
      title: player ? title : null,
      playing: player ? playing : null,
      position: player ? position : null,
      duration: player ? duration : null,
    };
  }
}

// ── the client ───────────────────────────────────────────
// MRP over a channel with sendProtobuf(bytes) and 'protobuf'/'close' events
// (the AirPlay data stream). start() does pyatv's opening: DEVICE_INFO (the
// Apple TV says nothing until it has one), SET_CONNECTION_STATE,
// CLIENT_UPDATES_CONFIG, GET_KEYBOARD_SESSION. Then 'state' on changes.
export class MrpClient extends EventEmitter {
  #channel;
  #waiting = new Map(); // identifier → { resolve, reject, timer }
  #now = new NowPlaying();
  #last = '';

  constructor(channel, { name = 'Hearth', uniqueIdentifier = uuid(), timeout = 5000 } = {}) {
    super();
    this.#channel = channel;
    Object.assign(this, { name, uniqueIdentifier, timeout });
    channel.on('protobuf', (bytes) => {
      try {
        this.#onMessage(parseMessage(bytes));
      } catch {
        // a message we can't read is skipped, never fatal
      }
    });
    channel.once('close', () => {
      for (const w of this.#waiting.values()) {
        clearTimeout(w.timer);
        w.reject(linkError('offline', 'The Apple TV connection closed'));
      }
      this.#waiting.clear();
    });
  }

  async start() {
    await this.#ask((identifier) => deviceInfo({ name: this.name, uniqueIdentifier: this.uniqueIdentifier, identifier }));
    this.#channel.sendProtobuf(setConnectionState());
    // Older tvOS may not answer these two; the pushes come anyway.
    await this.#ask((identifier) => clientUpdatesConfig({ identifier })).catch(() => {});
    await this.#ask((identifier) => getKeyboardSession({ identifier })).catch(() => {});
    return this;
  }

  // build(identifier) → message bytes; resolves with the answer that carries
  // that identifier.
  #ask(build, timeout = this.timeout) {
    const id = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(linkError('timeout', 'The Apple TV took too long to answer'));
      }, timeout);
      timer.unref?.();
      this.#waiting.set(id, { resolve, reject, timer });
      try {
        this.#channel.sendProtobuf(build(id));
      } catch (err) {
        clearTimeout(timer);
        this.#waiting.delete(id);
        reject(err);
      }
    });
  }

  #onMessage(msg) {
    const waiter = msg.identifier && this.#waiting.get(msg.identifier);
    if (waiter) {
      this.#waiting.delete(msg.identifier);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
      return;
    }
    if (this.#now.handle(msg)) this.#changed();
  }

  #changed() {
    const snap = this.snapshot();
    const key = JSON.stringify(snap);
    if (key === this.#last) return;
    this.#last = key;
    this.emit('state', snap);
  }

  snapshot() {
    return this.#now.snapshot();
  }

  // Play/Pause/Stop… → resolves when the Apple TV says it was done.
  async command(command) {
    const res = await this.#ask((identifier) => sendCommand(command, { identifier }));
    const sendError = num(res.inner, 1) ?? 0;
    if (sendError) throw linkError('refused', `The Apple TV couldn’t do that right now (${sendError})`);
    return res;
  }
}
