// How Hearth feels in the hand: haptics, sound, and one press engine for
// every button (tap, auto-repeat, long-press, press-and-hold-to-confirm).

// ── Preferences ─────────────────────────────────────────
const PREFS_KEY = 'hearth.prefs';
const defaults = { skin: 'classic', haptics: true, sound: null }; // sound null = on for 8-bit only

function loadPrefs() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}
export const prefs = loadPrefs();
const fromUrl = new URLSearchParams(location.search).get('skin');
if (fromUrl === '8bit' || fromUrl === 'classic') prefs.skin = fromUrl;

export function savePrefs(patch) {
  Object.assign(prefs, patch);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
  applySkin();
}
export const soundOn = () => (prefs.sound ?? prefs.skin === '8bit');

export function applySkin() {
  document.documentElement.dataset.skin = prefs.skin;
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = prefs.skin === '8bit' ? '#1b1a24' : '#e9e3d7';
}

// ── Haptics ─────────────────────────────────────────────
// Android: the Vibration API. iOS has no API, but Safari 17.4+ plays the
// system haptic when a <input type=checkbox switch> toggles, so we flip a
// hidden one inside the user's gesture.
const PATTERNS = {
  tick: 6,
  tap: 10,
  press: 14,
  heavy: 28,
  hold: [0, 8, 40, 8],
  success: [12, 70, 12, 70, 30],
  error: [40, 50, 40],
};
let iosSwitch;
function iosTick() {
  if (!iosSwitch) {
    const label = document.createElement('label');
    label.setAttribute('aria-hidden', 'true');
    label.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden';
    label.innerHTML = '<input type="checkbox" switch tabindex="-1">';
    document.body.append(label);
    iosSwitch = label;
  }
  iosSwitch.click();
}
const canVibrate = typeof navigator.vibrate === 'function';

export function haptic(kind = 'tap') {
  if (!prefs.haptics) return;
  if (canVibrate) {
    navigator.vibrate(PATTERNS[kind] ?? 10);
    return;
  }
  iosTick();
  if (kind === 'success' || kind === 'error') setTimeout(iosTick, 110);
  if (kind === 'success') setTimeout(iosTick, 220);
}

// ── Sound ───────────────────────────────────────────────
// Classic: a soft felt "tock". 8-bit: square-wave chip blips, a pitch per key.
let ctx;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone({ freq, to, type = 'square', dur = 0.06, vol = 0.06, at = 0 }) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + at;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const KEY_PITCH = {
  up: 784, down: 523, left: 587, right: 698, ok: 1047, back: 440, home: 880, menu: 659,
  volup: 988, voldown: 494, chup: 932, chdown: 466, mute: 330, play: 1175, pause: 392,
};

export function sound(kind, key) {
  if (!soundOn()) return;
  const chip = prefs.skin === '8bit';
  switch (kind) {
    case 'key':
    case 'tick':
      return chip
        ? tone({ freq: KEY_PITCH[key] ?? 660, dur: kind === 'tick' ? 0.03 : 0.055 })
        : tone({ freq: 1900, to: 900, type: 'sine', dur: 0.03, vol: 0.05 });
    case 'success':
      return [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, type: chip ? 'square' : 'triangle', dur: 0.09, at: i * 0.08, vol: 0.05 }));
    case 'error':
      return tone({ freq: 140, type: chip ? 'square' : 'sawtooth', dur: 0.22, vol: 0.05 });
    case 'on':
      return tone({ freq: 220, to: 880, type: chip ? 'square' : 'sine', dur: 0.25, vol: 0.05 });
    case 'off':
      return tone({ freq: 880, to: 160, type: chip ? 'square' : 'sine', dur: 0.3, vol: 0.05 });
    case 'charge':
      return tone({ freq: 300, to: 900, type: chip ? 'square' : 'sine', dur: 0.6, vol: 0.03 });
  }
}

export function feedback(kind, key) {
  haptic(kind === 'key' ? 'tap' : kind === 'tick' ? 'tick' : kind);
  sound(kind, key);
}

// ── The press engine ────────────────────────────────────
// Buttons opt in with data attributes:
//   data-press="down"    fire the instant a finger lands (remote keys)
//   data-press="up"      fire on release if the finger didn't wander (lists)
//   data-press="repeat"  fire now, then auto-repeat faster and faster (volume)
//   data-press="long"    tap = quick press; hold ≥ LONG_MS = long press
//   data-press="confirm" must be held for CONFIRM_MS (Everything off, Forget)
// Handlers receive (el, { long, held }) where held is ms the finger stayed down.
const LONG_MS = 480;
const CONFIRM_MS = 750;
const SLOP = 14;

export function pressable(root, handler) {
  let active = null;

  const clear = () => {
    if (!active) return;
    clearTimeout(active.timer);
    active.el.classList.remove('pressed', 'charging', 'charged');
    active.el.style.removeProperty('--charge-ms');
    active = null;
  };

  root.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-press]');
    if (!el || el.disabled || !root.contains(el) || e.button > 0) return;
    clear();
    const mode = el.dataset.press;
    active = { el, mode, x: e.clientX, y: e.clientY, t: performance.now(), fired: false, timer: 0 };
    el.classList.add('pressed');

    if (mode === 'down') {
      active.fired = true;
      handler(el, { long: false, held: 0 });
    } else if (mode === 'repeat') {
      active.fired = true;
      handler(el, { long: false, held: 0 });
      let delay = 380;
      const again = () => {
        if (!active || active.el !== el) return;
        handler(el, { long: false, held: performance.now() - active.t, repeat: true });
        delay = Math.max(70, delay * 0.72);
        active.timer = setTimeout(again, delay);
      };
      active.timer = setTimeout(again, delay);
    } else if (mode === 'long') {
      active.timer = setTimeout(() => {
        if (!active || active.el !== el) return;
        el.classList.add('charged');
        haptic('press');
      }, LONG_MS);
    } else if (mode === 'confirm') {
      el.style.setProperty('--charge-ms', `${CONFIRM_MS}ms`);
      requestAnimationFrame(() => el.classList.add('charging'));
      sound('charge');
      active.timer = setTimeout(() => {
        if (!active || active.el !== el) return;
        active.fired = true;
        handler(el, { long: true, held: CONFIRM_MS });
        clear();
      }, CONFIRM_MS);
    }
  });

  root.addEventListener('pointermove', (e) => {
    if (!active) return;
    if (Math.hypot(e.clientX - active.x, e.clientY - active.y) > SLOP && active.mode !== 'repeat') clear();
  });

  const release = (e, cancelled) => {
    if (!active) return;
    const { el, mode, fired, t } = active;
    const held = performance.now() - t;
    if (!cancelled && !fired) {
      if (mode === 'up') handler(el, { long: false, held });
      else if (mode === 'long') handler(el, { long: held >= LONG_MS, held });
      else if (mode === 'confirm') el.dispatchEvent(new CustomEvent('confirm-short', { bubbles: true }));
    }
    clear();
  };
  root.addEventListener('pointerup', (e) => release(e, false));
  root.addEventListener('pointercancel', (e) => release(e, true));
  // Long presses must not open the browser's context menu or text selection.
  root.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-press], .pad')) e.preventDefault();
  });
  // Keyboard users: Enter/Space on a focused button is a normal press.
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-press]');
    if (el && e.detail === 0) handler(el, { long: false, held: 0, keyboard: true });
  });
}

// ── The D-pad: tap, hold to repeat, or swipe like a trackpad ──
// Tap a zone = one press. Hold a direction = repeat. Hold the centre = long OK.
// Drag anywhere = a step every STEP px in the drag's direction, so a long
// swipe scrolls through a row of tiles.
const STEP = 34;
export function gesturePad(pad, { send, flash }) {
  let g = null;

  const zoneAt = (e) => {
    const r = pad.getBoundingClientRect();
    const cx = e.clientX - (r.left + r.width / 2);
    const cy = e.clientY - (r.top + r.height / 2);
    const dist = Math.hypot(cx, cy) / (r.width / 2);
    if (dist < 0.36) return 'ok';
    return Math.abs(cx) > Math.abs(cy) ? (cx > 0 ? 'right' : 'left') : cy > 0 ? 'down' : 'up';
  };

  const stop = () => {
    if (!g) return;
    clearTimeout(g.timer);
    pad.querySelectorAll('.pressed').forEach((b) => b.classList.remove('pressed'));
    pad.classList.remove('swiping', 'charged');
    g = null;
  };

  pad.addEventListener('pointerdown', (e) => {
    stop();
    pad.setPointerCapture(e.pointerId);
    const zone = zoneAt(e);
    g = { zone, x: e.clientX, y: e.clientY, t: performance.now(), mode: 'tap', timer: 0 };
    flash(zone, true);
    haptic('tick');
    if (zone === 'ok') {
      g.timer = setTimeout(() => {
        if (g?.mode === 'tap') {
          g.mode = 'long';
          pad.classList.add('charged');
          haptic('press');
        }
      }, LONG_MS);
    } else {
      let delay = 420;
      const again = () => {
        if (!g || (g.mode !== 'tap' && g.mode !== 'repeat')) return;
        g.mode = 'repeat';
        send(zone);
        delay = Math.max(80, delay * 0.75);
        g.timer = setTimeout(again, delay);
      };
      g.timer = setTimeout(again, delay);
    }
  });

  pad.addEventListener('pointermove', (e) => {
    if (!g) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (g.mode !== 'swipe' && Math.hypot(dx, dy) < 22) return;
    if (g.mode !== 'swipe') {
      clearTimeout(g.timer);
      if (g.mode === 'repeat') return; // already repeating a held direction
      g.mode = 'swipe';
      pad.classList.add('swiping');
      pad.querySelectorAll('.pressed').forEach((b) => b.classList.remove('pressed'));
    }
    const horizontal = Math.abs(dx) > Math.abs(dy);
    const d = horizontal ? dx : dy;
    if (Math.abs(d) >= STEP) {
      const dir = horizontal ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      send(dir);
      flash(dir);
      g.x = e.clientX;
      g.y = e.clientY;
    }
  });

  pad.addEventListener('pointerup', (e) => {
    if (!g) return;
    const held = performance.now() - g.t;
    if (g.mode === 'tap') send(g.zone);
    else if (g.mode === 'long') send('ok', { hold: held });
    if (g.mode === 'tap' || g.mode === 'long') ripple(pad, e);
    stop();
  });
  pad.addEventListener('pointercancel', stop);
}

function ripple(pad, e) {
  const rect = pad.getBoundingClientRect();
  const size = rect.width * 0.42;
  const el = document.createElement('span');
  el.className = 'ripple';
  Object.assign(el.style, {
    width: `${size}px`,
    height: `${size}px`,
    left: `${e.clientX - rect.left - size / 2}px`,
    top: `${e.clientY - rect.top - size / 2}px`,
  });
  pad.append(el);
  el.addEventListener('animationend', () => el.remove());
}

// ── Keep the phone awake while the remote is open ──
let lock = null;
export async function keepAwake(on) {
  try {
    if (on && !lock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } else if (!on && lock) {
      await lock.release();
      lock = null;
    }
  } catch {
    lock = null;
  }
}
