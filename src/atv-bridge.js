import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HearthError } from './errors.js';

// Apple TVs speak Companion/AirPlay with HAP pairing; pyatv (Python) is the
// mature implementation. One long-lived Python process serves every Apple TV
// over JSON lines on stdio; this file owns that process. It starts lazily,
// restarts with backoff if it dies, and tells drivers to reconnect.
export const PYATV_VERSION = '0.18.0';
export const BRIDGE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drivers', 'appletv-bridge.py');

// Shared by every Hearth install for this user (not per HEARTH_HOME), so a
// scratch server on another port doesn't need its own 30 MB venv.
export const venvDir = () => process.env.HEARTH_VENV || path.join(os.homedir(), '.hearth', 'py');
export const venvPython = () => path.join(venvDir(), process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export const NOT_INSTALLED =
  'Apple TV support needs Python 3 and pyatv. Run `npm run up` on the Hearth computer (it installs them), then try again.';

const CODES = { offline: 503, unsupported: 501, auth: 401, expired: 410, error: 502 };
const MAX_BACKOFF = 30_000;

export class AtvBridge extends EventEmitter {
  #child = null;
  #ready = null;
  #buf = '';
  #seq = 1;
  #waiting = new Map();
  #backoff = 1000;
  #restartTimer = null;
  #closed = false;
  available = null; // null = not tried yet, true/false after the first start
  reason = '';

  constructor({ python = venvPython(), script = BRIDGE_SCRIPT, spawnFn = spawn } = {}) {
    super();
    this.python = python;
    this.script = script;
    this.spawnFn = spawnFn;
    this.setMaxListeners(0);
  }

  // Resolves once the bridge says {"event":"ready"}; rejects with a plain-words
  // HearthError when Python or pyatv is missing.
  start() {
    if (this.#ready) return this.#ready;
    this.#closed = false;
    const ready = new Promise((resolve, reject) => {
      if (!existsSync(this.python)) {
        this.#unavailable(NOT_INSTALLED);
        return reject(new HearthError(503, NOT_INSTALLED));
      }
      let child;
      try {
        child = this.spawnFn(this.python, ['-u', this.script], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        this.#unavailable(`${NOT_INSTALLED} (${err.message})`);
        return reject(new HearthError(503, NOT_INSTALLED));
      }
      this.#child = child;
      this.#buf = '';
      let started = false;
      const onReady = (msg) => {
        started = true;
        this.available = true;
        this.reason = '';
        this.#backoff = 1000;
        this.version = msg.pyatv;
        resolve();
      };
      this.once('_ready', onReady);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => this.#onData(chunk));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        const text = String(d).trim();
        if (text) console.error(text.startsWith('[appletv-bridge]') ? text : `[appletv-bridge] ${text}`);
      });
      child.once('error', (err) => {
        this.off('_ready', onReady);
        this.#unavailable(`${NOT_INSTALLED} (${err.message})`);
        reject(new HearthError(503, NOT_INSTALLED));
      });
      child.once('exit', (code) => {
        this.off('_ready', onReady);
        if (this.#child === child) this.#child = null;
        for (const { reject: fail, timer } of this.#waiting.values()) {
          clearTimeout(timer);
          fail(new HearthError(503, 'The Apple TV helper restarted; try again'));
        }
        this.#waiting.clear();
        this.#ready = null;
        if (!started) {
          const why = this.fatal || `${NOT_INSTALLED} (the helper exited with code ${code})`;
          this.#unavailable(why);
          reject(new HearthError(503, why));
        }
        this.emit('exit', code);
        // Only a bridge that did start is worth restarting; a missing Python
        // is retried when a driver next asks (after `npm run up` fixed it).
        if (started && !this.#closed) this.#scheduleRestart();
      });
    });
    this.#ready = ready;
    // A failed start must not be cached: the next request tries again.
    ready.catch(() => {
      if (this.#ready === ready) this.#ready = null;
    });
    return ready;
  }

  #unavailable(reason) {
    this.available = false;
    this.reason = reason;
    this.emit('unavailable', reason);
  }

  // Exponential backoff; on success every driver hears 'restart' and reconnects.
  #scheduleRestart() {
    clearTimeout(this.#restartTimer);
    const wait = this.#backoff;
    this.#backoff = Math.min(MAX_BACKOFF, this.#backoff * 2);
    this.#restartTimer = setTimeout(() => {
      if (this.#closed) return;
      this.start().then(() => this.emit('restart'), () => this.#scheduleRestart());
    }, wait);
    this.#restartTimer.unref?.();
  }

  #onData(chunk) {
    this.#buf += chunk;
    let i;
    while ((i = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, i).trim();
      this.#buf = this.#buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    if (msg.event === 'ready') return this.emit('_ready', msg);
    if (msg.event === 'fatal') {
      this.fatal = `${NOT_INSTALLED} (${msg.error})`;
      return;
    }
    if (msg.event) return this.emit(msg.event, msg);
    const waiter = this.#waiting.get(msg.id);
    if (!waiter) return;
    this.#waiting.delete(msg.id);
    clearTimeout(waiter.timer);
    if (msg.ok) waiter.resolve(msg.result);
    else {
      const err = new HearthError(CODES[msg.code] ?? 502, msg.error || 'The Apple TV said no');
      err.code = msg.code;
      waiter.reject(err);
    }
  }

  async request(op, args = {}, { timeout = 30_000 } = {}) {
    await this.start();
    const id = this.#seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new HearthError(504, 'The Apple TV took too long to answer'));
      }, timeout + 2000);
      timer.unref?.();
      this.#waiting.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ id, op, timeout: timeout / 1000, ...args })}\n`);
    });
  }

  async close() {
    this.#closed = true;
    clearTimeout(this.#restartTimer);
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    if (child) {
      child.stdin.end();
      setTimeout(() => child.kill(), 1500).unref?.();
    }
  }
}

// One bridge per Hearth process, created on first use. Tests swap in a fake.
let shared = null;
export function getBridge() {
  shared ??= new AtvBridge();
  return shared;
}
export function setBridge(bridge) {
  shared = bridge;
}
export async function closeBridge() {
  await shared?.close?.();
}
