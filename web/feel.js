// How Hearth feels in the hand: haptics, sound, and one press engine for
// every button (tap, auto-repeat, long-press, press-and-hold-to-confirm).

// ── Preferences ─────────────────────────────────────────
const PREFS_KEY = 'hearth.prefs';
// mode: 'light' | 'dark' | 'auto' (follows the phone). Light by default.
const defaults = { skin: 'aurora', mode: 'light', haptics: true, sound: null }; // sound null = on for 8-bit only

function loadPrefs() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}
export const prefs = loadPrefs();
const fromUrl = new URLSearchParams(location.search).get('skin');
if (['aurora', '8bit', 'classic'].includes(fromUrl)) prefs.skin = fromUrl;

export function savePrefs(patch) {
  Object.assign(prefs, patch);
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
  applySkin();
}
export const soundOn = () => (prefs.sound ?? prefs.skin === '8bit');

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
// Light or dark, after 'auto' asks the phone. The 8-bit skin is its own thing.
export const themeMode = () => (prefs.mode === 'auto' ? (darkQuery?.matches ? 'dark' : 'light') : prefs.mode === 'dark' ? 'dark' : 'light');

export function applySkin() {
  const root = document.documentElement;
  const mode = themeMode();
  root.dataset.skin = prefs.skin;
  root.dataset.mode = mode;
  root.style.colorScheme = mode;
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  const tint = { '8bit': '#1b1a24', aurora: mode === 'dark' ? '#07080c' : '#f6f1ea' }[prefs.skin] ?? (mode === 'dark' ? '#121110' : '#e9e3d7');
  if (meta) meta.content = tint;
  dispatchEvent(new CustomEvent('hearth:mode', { detail: mode })); // the phone app's status bar follows
}
darkQuery?.addEventListener?.('change', () => prefs.mode === 'auto' && applySkin());

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
// Safari only plays that haptic inside a user activation, and a finger
// *landing* (pointerdown/touchstart) isn't one — lifting it (pointerup/touchend)
// is. So on iOS, a buzz asked for during a press is played on release.
// (Holds can't buzz on iOS for the same reason; Android buzzes throughout.)
// The switch stays in the page, rendered but off-screen: a display:none or
// <head>-hosted one is ignored by some iOS versions.
let iosSwitch = null;
function iosTick() {
  if (!iosSwitch?.isConnected) {
    iosSwitch = document.createElement('label');
    iosSwitch.ariaHidden = 'true';
    iosSwitch.style.cssText = 'position:fixed;left:-200px;top:0;width:40px;height:24px;opacity:0.01;pointer-events:none;';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.tabIndex = -1;
    input.setAttribute('switch', '');
    iosSwitch.append(input);
    (document.body ?? document.documentElement).append(iosSwitch);
  }
  iosSwitch.click();
}
const canVibrate = typeof navigator.vibrate === 'function';
const iosVersion = (() => {
  const ua = navigator.userAgent;
  const m = ua.match(/OS (\d+)_\d+.*like Mac OS X/);
  if (m) return Number(m[1]);
  // iPadOS asks for desktop sites and says "Macintosh"; its Safari version tracks iOS.
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return Number(ua.match(/Version\/(\d+)/)?.[1] ?? 0);
  return 0;
})();
// → 'vibrate' (Android), 'ios' (iPhone/iPad on iOS 18+), 'old-ios', or 'none' (computers).
export function hapticSupport() {
  if (canVibrate) return 'vibrate';
  if (iosVersion >= 18) return 'ios';
  if (iosVersion) return 'old-ios';
  return 'none';
}
export const HAPTIC_HINT = {
  vibrate: 'Feel every press',
  ios: 'Feel every press · needs iPhone Settings → Sounds & Haptics → System Haptics',
  'old-ios': 'Needs iOS 18 or newer (update your iPhone)',
  none: 'This device can’t vibrate · works on phones',
};
let pendingIos = 0;
if (!canVibrate) {
  const flush = () => {
    if (!pendingIos) return;
    const n = Math.min(pendingIos, 3);
    pendingIos = 0;
    iosTick();
    // Extra ticks for success/error patterns; may be dropped outside the gesture.
    for (let i = 1; i < n; i++) setTimeout(iosTick, i * 110);
  };
  addEventListener('pointerup', flush, true);
  addEventListener('touchend', flush, true);
  addEventListener('click', flush, true);
}

export function haptic(kind = 'tap') {
  if (!prefs.haptics) return;
  if (canVibrate) {
    navigator.vibrate(PATTERNS[kind] ?? 10);
    return;
  }
  pendingIos = Math.max(pendingIos, kind === 'success' ? 3 : kind === 'error' ? 2 : 1);
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

// ── The D-pad: push, hold, swipe, joystick ──
// • Push a zone            → one press (the centre is OK)
// • Hold a zone            → repeats, faster and faster
// • Hold the centre        → long OK (a real press-and-hold where the TV supports it)
// • Drag off-centre        → joystick: one step at once, then repeats while you
//                            stay out there — the further out, the faster
// • Flick and let go       → swipe: a quick flick adds momentum steps
const DEADZONE = 18;
export function gesturePad(pad, { send, flash, onPointer = () => {} }) {
  let g = null;
  const knob = pad.querySelector('.pad-knob');
  const local = (e) => {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, r };
  };
  const zoneAt = (e) => {
    const { x, y, r } = local(e);
    const cx = x - r.width / 2;
    const cy = y - r.height / 2;
    if (Math.hypot(cx, cy) / (r.width / 2) < 0.36) return 'ok';
    return Math.abs(cx) > Math.abs(cy) ? (cx > 0 ? 'right' : 'left') : cy > 0 ? 'down' : 'up';
  };
  const dirOf = (dx, dy) => (Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');

  const stop = () => {
    if (!g) return;
    clearTimeout(g.timer);
    pad.querySelectorAll('.pressed').forEach((b) => b.classList.remove('pressed'));
    pad.classList.remove('swiping', 'charged', 'stick');
    pad.style.removeProperty('--aim');
    if (knob) knob.style.transform = '';
    g = null;
  };

  const step = (dir, repeat = false) => {
    send(dir, repeat ? { repeat: true } : {});
    flash(dir);
    g && (g.lastStep = performance.now());
  };

  // Joystick repeat: interval shrinks with deflection (520 ms → 70 ms).
  const stickLoop = () => {
    if (!g || g.mode !== 'stick') return;
    const reach = Math.min(1, Math.max(0, (g.dist - DEADZONE) / (g.radius - DEADZONE)));
    g.timer = setTimeout(() => {
      if (!g || g.mode !== 'stick') return;
      if (g.dir) step(g.dir, true);
      stickLoop();
    }, 520 - 410 * reach);
  };

  pad.addEventListener('pointerdown', (e) => {
    stop();
    try {
      pad.setPointerCapture(e.pointerId);
    } catch {}
    const zone = zoneAt(e);
    const { x, y, r } = local(e);
    g = { zone, x0: e.clientX, y0: e.clientY, t0: performance.now(), downAt: performance.now(), mode: 'tap', timer: 0, dir: null, dist: 0, radius: r.width * 0.3, samples: [], lastStep: 0 };
    flash(zone, true);
    haptic('tick');
    onPointer('down', x, y);
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
        if (!g || (g.mode !== 'tap' && g.mode !== 'hold')) return;
        g.mode = 'hold';
        step(zone, true);
        delay = Math.max(80, delay * 0.75);
        g.timer = setTimeout(again, delay);
      };
      g.timer = setTimeout(again, delay);
    }
  });

  pad.addEventListener('pointermove', (e) => {
    if (!g) return;
    const { x, y } = local(e);
    onPointer('move', x, y);
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    g.dist = Math.hypot(dx, dy);
    const now = performance.now();
    g.samples.push({ t: now, x: e.clientX, y: e.clientY });
    while (g.samples.length > 2 && now - g.samples[0].t > 90) g.samples.shift();

    if (g.mode !== 'stick') {
      if (g.dist < DEADZONE || g.mode === 'hold') return;
      clearTimeout(g.timer);
      g.mode = 'stick';
      pad.classList.add('stick', 'swiping');
      pad.querySelectorAll('.pressed').forEach((b) => b.classList.remove('pressed'));
      g.dir = dirOf(dx, dy);
      step(g.dir);
      stickLoop();
    }
    // The knob follows the thumb, clamped to the ring.
    const k = Math.min(1, g.radius / Math.max(g.dist, 1));
    if (knob) knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
    pad.style.setProperty('--aim', `${Math.atan2(dy, dx) + Math.PI / 2}rad`);
    const dir = g.dist >= DEADZONE ? dirOf(dx, dy) : null;
    if (dir !== g.dir) {
      g.dir = dir;
      clearTimeout(g.timer);
      if (dir) step(dir);
      stickLoop();
    }
  });

  pad.addEventListener('pointerup', (e) => {
    if (!g) return;
    const { x, y } = local(e);
    onPointer('up', x, y);
    const held = performance.now() - g.t0;
    if (g.mode === 'tap') {
      send(g.zone);
      ripple(pad, e);
      onPointer('pulse', x, y);
    } else if (g.mode === 'long') {
      send('ok', { hold: performance.now() - (g.downAt ?? performance.now() - LONG_MS) });
      ripple(pad, e);
      onPointer('pulse', x, y);
    } else if (g.mode === 'stick' && g.dir) {
      // Swipe momentum: a fast flick adds up to 3 extra steps.
      const a = g.samples[0];
      const b = g.samples[g.samples.length - 1];
      const v = a && b && b.t > a.t ? Math.hypot(b.x - a.x, b.y - a.y) / (b.t - a.t) : 0;
      const extra = Math.min(3, Math.floor((v - 0.8) * 2));
      const dir = g.dir;
      for (let i = 1; i <= extra; i++) setTimeout(() => (send(dir, { repeat: true }), flash(dir)), i * 80);
    }
    void held;
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

