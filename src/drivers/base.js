import { EventEmitter } from 'node:events';
import { unsupported } from '../errors.js';
import { wake } from '../wol.js';

// Every brand implements this shape. The hub and web UI only talk to it, so
// adding a brand (Roku, Android TV, Vizio…) means one new file in drivers/.
//
// Emits 'state' whenever `state` changes and calls `onCredentials` when the TV
// hands out a pairing key that should be persisted.
export class Driver extends EventEmitter {
  static brand = 'unknown';
  capabilities = { volumeLevel: false, inputs: false, toast: false, appIcons: false };

  constructor(tv, { onCredentials = () => {}, onInfo = () => {} } = {}) {
    super();
    this.tv = tv;
    this.onCredentials = onCredentials;
    this.onInfo = onInfo;
    this.state = { online: false, power: 'unknown', volume: null, muted: null, app: null };
  }

  setState(patch) {
    const next = { ...this.state, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.emit('state', this.state);
  }

  // Lifecycle
  start() {}
  async stop() {}
  async pair() { throw unsupported('Pairing'); }

  // Remote
  async key(_name) { throw unsupported('That button'); }
  async powerOn() {
    if (!this.tv.macs?.length) throw unsupported('Turning on (no MAC address known yet)');
    await wake(this.tv.macs, this.tv.ip);
  }
  async powerOff() { throw unsupported('Turning off'); }
  async setVolume(_level) { throw unsupported('Setting the volume level'); }
  async apps() { return []; }
  async launch(_appId) { throw unsupported('Launching apps'); }
  async inputs() { return []; }
  async setInput(_id) { throw unsupported('Switching inputs'); }
  async toast(_message) { throw unsupported('On-screen messages'); }
}
