// What's on, at a glance — and the right remote for it, automatically.
//
//  • Activity badges ("🎮 Playing PlayStation 5 · 42m") on every TV card and
//    a "Right now" line over the house.
//  • A mode bar on the remote: Remote · Trackpad · Gamepad. A browser on the
//    TV switches the phone to a trackpad + keyboard; a game or console to a
//    gamepad. Tap "Remote" to go back — that choice is remembered per TV.
//  • On a computer: the real mouse drives the TV pointer (pointer lock on the
//    trackpad), typing goes straight to the TV, and "?" shows every shortcut.
import { classify, KINDS, suggestedMode, summarize } from './activity.js';
import { feedback, haptic } from './feel.js';
import { keyMemory, phaseOf } from './playback.js';
import { createStream } from './stream.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const activityOf = (t) => t?.activity ?? { ...classify(t), since: t?.since ?? null };

function ago(since) {
  if (!since) return '';
  const m = Math.round((Date.now() - since) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The one-line description of an activity, for people.
export function describe(a) {
  const k = KINDS[a.kind] ?? KINDS.unknown;
  switch (a.kind) {
    case 'game':
    case 'console':
      return `${k.verb} ${a.label}`;
    case 'browser':
      return /web browser|^browser$/i.test(a.label) ? 'Browsing the web' : `Browsing · ${a.label}`;
    case 'home':
    case 'idle':
    case 'off':
      return k.verb === 'Idle' ? a.label || 'Idle' : k.verb;
    default:
      return a.label || k.verb;
  }
}

export function activityBadge(t) {
  if (!t.paired) return '';
  const a = activityOf(t);
  if (a.kind === 'off') return '';
  const k = KINDS[a.kind] ?? KINDS.unknown;
  const time = ['home', 'idle'].includes(a.kind) ? '' : ago(a.since);
  return `<span class="act-badge act-${a.kind}" title="${esc(`${describe(a)} (${Math.round(a.confidence * 100)}% sure, from ${a.source})`)}"><i>${k.emoji}</i><b>${esc(describe(a))}</b>${time ? `<small>${time}</small>` : ''}</span>`;
}

// Hero line: "Right now: 2 games, 1 browser, 1 streaming".
export function renderRightNow(list) {
  const hero = document.querySelector('#heroLine');
  if (!hero) return;
  let line = document.querySelector('#rightNow');
  if (!line) {
    line = document.createElement('p');
    line.id = 'rightNow';
    line.className = 'right-now';
    hero.after(line);
  }
  const acts = list.filter((t) => t.paired && t.state?.online).map(activityOf);
  const text = summarize(acts);
  line.hidden = !text;
  const hot = acts.find((a) => a.kind === 'game' || a.kind === 'console') ?? acts.find((a) => a.kind === 'browser');
  line.innerHTML = text ? `<span class="pulse-dot"></span>Right now: <b>${esc(text)}</b>${hot ? ` · <span class="mono">${esc(describe(hot))}</span>` : ''}` : '';
}

// aurora-field palette per activity: games go neon, browsing goes ice.
export function paletteFor(kind) {
  return { game: 'night-city', console: 'night-city', browser: 'ice', music: 'spice' }[kind] ?? 'ember';
}
export function housePalette(list) {
  const kinds = list.filter((t) => t.paired && t.state?.online).map((t) => activityOf(t).kind);
  if (kinds.some((k) => k === 'game' || k === 'console')) return 'night-city';
  if (kinds.includes('browser')) return 'ice';
  return 'ember';
}

// ── The remote modes ────────────────────────────────────
const PREFS = 'hearth.modes';
const loadPrefs = () => {
  try {
    return JSON.parse(localStorage.getItem(PREFS) || '{}');
  } catch {
    return {};
  }
};
const savePref = (tvId, group, value) => {
  const p = loadPrefs();
  p[tvId] = { ...p[tvId], [group]: value };
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {}
};
const groupOf = (mode) => (mode === 'trackpad' ? 'browser' : mode === 'gamepad' ? 'game' : null);
const finePointer = () => matchMedia('(pointer: fine)').matches && !matchMedia('(pointer: coarse)').matches;

export function createModes({ api, getTv, sendKey, note }) {
  const remote = document.querySelector('#remote');
  let mode = 'remote';
  let auto = false; // was the current mode chosen for us?
  let lastSuggested = new Map(); // tvId → mode suggested last time

  // ── DOM (injected so index.html stays as it was) ──
  remote.insertAdjacentHTML(
    'beforeend',
    `<div class="kb-overlay" id="kbOverlay" hidden><div class="kb-card">
      <h3>Keyboard shortcuts</h3>
      <div class="kb-cols">
        <div><h4 class="mono">Remote</h4>
          <p><kbd>←</kbd><kbd>↑</kbd><kbd>→</kbd><kbd>↓</kbd> move</p><p><kbd>Enter</kbd> OK</p><p><kbd>⌫</kbd>/<kbd>Esc</kbd> back</p>
          <p><kbd>H</kbd> home</p><p><kbd>+</kbd>/<kbd>−</kbd> volume</p><p><kbd>M</kbd> mute</p></div>
        <div><h4 class="mono">Trackpad</h4>
          <p><b>Click</b> the pad to capture your mouse</p><p>Move → TV pointer · click → click</p><p>Scroll wheel → scroll</p>
          <p>Just type → text on the TV</p><p><kbd>Enter</kbd> go · <kbd>⌫</kbd> delete</p><p><kbd>Esc</kbd> releases the mouse</p></div>
        <div><h4 class="mono">Gamepad</h4>
          <p>Arrows · <kbd>Enter</kbd>/<kbd>Space</kbd> A</p><p><kbd>⌫</kbd>/<kbd>Esc</kbd> B</p><p><kbd>X</kbd> play/pause · <kbd>I</kbd> info</p>
          <p><kbd>[</kbd>/<kbd>]</kbd> rewind/forward</p></div>
      </div>
      <p class="mono kb-foot">Press <kbd>?</kbd> any time · <kbd>1</kbd>–<kbd>4</kbd> switch modes</p>
      <button type="button" class="cta small" data-kb-close>Got it</button>
    </div></div>`,
  );
  const panels = remote.querySelector('.panels');
  panels.insertAdjacentHTML(
    'beforebegin',
    `<div class="mode-bar" id="modeBar">
      <span class="act-chip" id="actChip"><i></i><b></b><small></small></span>
      <div class="mode-seg" role="tablist" aria-label="Remote style">
        <button type="button" role="tab" data-mode="remote" aria-selected="true">Remote</button>
        <button type="button" role="tab" data-mode="stream" aria-selected="false">Watch</button>
        <button type="button" role="tab" data-mode="trackpad" aria-selected="false">Trackpad</button>
        <button type="button" role="tab" data-mode="gamepad" aria-selected="false">Gamepad</button>
      </div>
      <button type="button" class="kb-btn" id="kbBtn" aria-label="Keyboard shortcuts" hidden>?</button>
    </div>`,
  );
  panels.insertAdjacentHTML(
    'beforeend',
    `<section class="mode-panel" id="p-trackpad" aria-label="Trackpad and keyboard">
      <p class="mode-note" id="tpNote" hidden></p>
      <div class="trackpad" id="trackpad" aria-label="Trackpad: move to point, tap to click, two fingers to scroll">
        <span class="tp-dot" id="tpDot" aria-hidden="true"></span>
        <span class="tp-hint mono" id="tpHint">Slide to point · tap to click · two fingers to scroll</span>
      </div>
      <div class="tp-keys">
        <button type="button" class="tp-key" data-press="down" data-key="back" aria-label="Back">← Back</button>
        <button type="button" class="tp-key" data-tp="click" aria-label="Click">Click</button>
        <button type="button" class="tp-key" data-press="down" data-key="home" aria-label="Home">Home</button>
      </div>
      <form class="kb-bar" id="kbForm" autocomplete="off">
        <input id="kbInput" placeholder="Type on the TV…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" aria-label="Type on the TV">
        <button type="button" data-kb="backspace" aria-label="Delete">⌫</button>
        <button type="submit" aria-label="Enter">↵</button>
      </form>
    </section>
    <section class="mode-panel" id="p-gamepad" aria-label="Gamepad">
      <p class="mode-note" id="gpNote" hidden></p>
      <div class="gamepad">
        <div class="gp-shoulders">
          <button type="button" data-press="repeat" data-key="rewind">L</button>
          <button type="button" data-press="repeat" data-key="voldown">VOL −</button>
          <button type="button" data-press="repeat" data-key="volup">VOL +</button>
          <button type="button" data-press="repeat" data-key="forward">R</button>
        </div>
        <div class="gp-main">
          <div class="gp-dpad" aria-label="D-pad">
            <button type="button" class="u" data-press="repeat" data-key="up" aria-label="Up">▲</button>
            <button type="button" class="l" data-press="repeat" data-key="left" aria-label="Left">◀</button>
            <span class="c" aria-hidden="true"></span>
            <button type="button" class="r" data-press="repeat" data-key="right" aria-label="Right">▶</button>
            <button type="button" class="d" data-press="repeat" data-key="down" aria-label="Down">▼</button>
          </div>
          <div class="gp-mid">
            <button type="button" data-press="down" data-key="menu">SELECT</button>
            <button type="button" data-press="down" data-key="home">START</button>
          </div>
          <div class="gp-face" aria-label="Buttons">
            <button type="button" class="y" data-press="down" data-key="info" aria-label="Y: info">Y</button>
            <button type="button" class="x" data-press="down" data-key="play" aria-label="X: play or pause">X</button>
            <button type="button" class="b" data-press="down" data-key="back" aria-label="B: back">B</button>
            <button type="button" class="a" data-press="long" data-key="ok" aria-label="A: OK (hold for long press)">A</button>
          </div>
        </div>
      </div>
    </section>`,
  );
  const $ = (s) => remote.querySelector(s);
  // The Stream Center ("Watch"): what you want while something plays.
  const keys = keyMemory();
  const stream = createStream({ remote, sendKey, getTv, onBrowse: () => setMode('remote') });
  // Remote, or Watch when something is playing; browsers and games win.
  function suggest(t, a) {
    const base = suggestedMode(a);
    if (base !== 'remote') return base;
    return phaseOf(t, a, keys.get(t.id)).phase === 'playback' ? 'stream' : 'remote';
  }

  function setMode(next, { isAuto = false, silent = false } = {}) {
    if (next === mode) {
      auto = auto && isAuto;
      return;
    }
    const t = getTv();
    if (t && !isAuto) {
      // A choice made by hand is remembered for this TV and this kind of thing.
      const group = groupOf(next) ?? groupOf(mode);
      if (group) savePref(t.id, group, next === 'remote' ? 'remote' : 'auto');
    }
    mode = next;
    auto = isAuto;
    remote.dataset.mode = next;
    for (const b of remote.querySelectorAll('[data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === next));
    if (!silent) haptic('tap');
    if (document.pointerLockElement) document.exitPointerLock?.();
    if (t) explain(t);
  }

  // Plain-words limits for TVs that can't do something.
  function explain(t) {
    const caps = t.capabilities ?? {};
    const tp = $('#tpNote');
    const gp = $('#gpNote');
    const brand = t.brand;
    tp.hidden = true;
    gp.hidden = true;
    if (mode === 'trackpad') {
      if (!caps.pointer && !caps.keyboard) {
        tp.textContent = brand === 'androidtv'
          ? 'Google TVs don’t accept a pointer or typing without Google’s one-time code. Volume, mute and apps work in Remote.'
          : 'This TV doesn’t accept a pointer or typing.';
        tp.hidden = false;
      } else if (!caps.pointer) {
        tp.textContent = `${({ roku: 'Roku has', appletv: 'Apple TV has' })[brand] ?? 'This TV has'} no pointer: slide to move the selection, tap to select. Typing works.`;
        tp.hidden = false;
      } else if (brand === 'samsung') {
        tp.textContent = 'Samsung: pointer and typing work; to fix a typo, clear the field on the TV and type again.';
        tp.hidden = false;
      }
      $('#tpHint').textContent = finePointer()
        ? (caps.pointer ? 'Click here to capture your mouse · Esc to release · just type' : 'Click, then use arrows · just type')
        : caps.pointer ? 'Slide to point · tap to click · two fingers to scroll' : 'Slide to move · tap to select';
    }
    if (mode === 'gamepad' && caps.remote === false) {
      gp.textContent = 'Google TVs only take volume and mute without Google’s one-time code, so the D-pad and buttons won’t reach it.';
      gp.hidden = false;
    }
  }

  function renderChip(t) {
    const a = activityOf(t);
    const k = KINDS[a.kind] ?? KINDS.unknown;
    const chip = $('#actChip');
    chip.className = `act-chip act-${a.kind}`;
    chip.querySelector('i').textContent = k.emoji;
    chip.querySelector('b').textContent = t.paired ? describe(a) : 'Not connected';
    chip.querySelector('small').textContent = ['off', 'home', 'idle'].includes(a.kind) ? '' : ago(a.since);
    remote.dataset.activity = a.kind;
  }

  // Called on every remote render: chip, auto-switch, limits.
  function update(t) {
    if (!t) return;
    renderChip(t);
    $('#kbBtn').hidden = !finePointer();
    const a = activityOf(t);
    const suggested = suggest(t, a);
    stream.render(t);
    const before = lastSuggested.get(t.id);
    lastSuggested.set(t.id, suggested);
    if (suggested !== before) {
      const group = groupOf(suggested);
      const pref = group ? loadPrefs()[t.id]?.[group] : null;
      if (suggested !== 'remote' && pref !== 'remote' && mode !== suggested) {
        setMode(suggested, { isAuto: true, silent: true });
        if (suggested === 'stream') haptic('tap'); // playback started: quietly bring the Stream Center
        else {
          feedback('success');
          note(suggested === 'trackpad' ? `🌐 Browser on ${t.name}: trackpad + keyboard ready` : `🎮 ${a.label} on ${t.name}: gamepad ready`);
        }
      } else if (suggested === 'remote' && auto && mode !== 'remote') {
        setMode('remote', { isAuto: true, silent: true });
      }
    }
    explain(t);
  }

  function enter(t) {
    lastSuggested.delete(t?.id);
    mode = 'remote';
    auto = false;
    remote.dataset.mode = 'remote';
    for (const b of remote.querySelectorAll('[data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === 'remote'));
    maybeShowShortcutsOnce();
  }

  function leave() {
    if (document.pointerLockElement) document.exitPointerLock?.();
    lastSuggested = new Map();
  }

  // ── Talking to the TV: coalesced pointer, queued text ──
  const acc = { dx: 0, dy: 0, sx: 0, sy: 0 };
  let inflight = false;
  let frame = 0;
  const caps = () => getTv()?.capabilities ?? {};
  const tvId = () => getTv()?.id;

  function flush() {
    frame = 0;
    if (inflight || !tvId()) return;
    const id = tvId();
    let body = null;
    if (acc.sx || acc.sy) {
      body = { type: 'scroll', dx: Math.round(acc.sx), dy: Math.round(acc.sy) };
      acc.sx = acc.sy = 0;
    } else if (Math.abs(acc.dx) >= 1 || Math.abs(acc.dy) >= 1) {
      body = { type: 'move', dx: Math.round(acc.dx), dy: Math.round(acc.dy) };
      acc.dx -= body.dx;
      acc.dy -= body.dy;
    }
    if (!body) return;
    inflight = true;
    api('POST', `/tvs/${id}/pointer`, body)
      .catch((err) => note(err.message, true))
      .finally(() => {
        inflight = false;
        if (acc.dx || acc.dy || acc.sx || acc.sy) schedule();
      });
  }
  const schedule = () => (frame ||= requestAnimationFrame(flush));

  function click() {
    if (caps().pointer) {
      feedback('key', 'ok');
      api('POST', `/tvs/${tvId()}/pointer`, { type: 'click' }).catch((err) => note(err.message, true));
    } else sendKey('ok');
  }

  // Without a pointer (Roku), movement becomes arrow steps.
  const STEP = 36;
  const steps = { x: 0, y: 0 };
  function stepMove(dx, dy) {
    steps.x += dx;
    steps.y += dy;
    while (Math.abs(steps.x) >= STEP || Math.abs(steps.y) >= STEP) {
      if (Math.abs(steps.x) >= Math.abs(steps.y)) {
        sendKey(steps.x > 0 ? 'right' : 'left', { repeat: true });
        steps.x -= Math.sign(steps.x) * STEP;
      } else {
        sendKey(steps.y > 0 ? 'down' : 'up', { repeat: true });
        steps.y -= Math.sign(steps.y) * STEP;
      }
    }
  }

  function move(dx, dy) {
    if (caps().pointer) {
      acc.dx += dx;
      acc.dy += dy;
      schedule();
    } else stepMove(dx, dy);
  }

  function scroll(dx, dy) {
    if (caps().pointer) {
      acc.sx += dx;
      acc.sy += dy;
      schedule();
    } else stepMove(dx, dy);
  }

  let textQueue = Promise.resolve();
  function sendText(input) {
    const id = tvId();
    if (!id) return;
    if (!caps().keyboard) return note('This TV doesn’t accept typing', true);
    textQueue = textQueue.then(() => api('POST', `/tvs/${id}/text`, input)).catch((err) => note(err.message, true));
  }

  // ── Trackpad gestures (touch + pen + mouse) ──
  const pad = $('#trackpad');
  const dot = $('#tpDot');
  const touches = new Map();
  let gesture = null;
  pad.addEventListener('pointerdown', (e) => {
    if (document.pointerLockElement === pad) return;
    if (finePointer() && e.pointerType === 'mouse' && caps().pointer) {
      pad.requestPointerLock?.();
      return;
    }
    try {
      pad.setPointerCapture(e.pointerId);
    } catch {}
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
    if (touches.size === 1) gesture = { t0: performance.now(), moved: 0, multi: false, long: null };
    else gesture && (gesture.multi = true);
    clearTimeout(gesture?.long);
    if (touches.size === 1) {
      gesture.long = setTimeout(() => {
        if (gesture && gesture.moved < 10 && !gesture.multi) {
          gesture.held = true;
          haptic('press');
        }
      }, 550);
    }
    const r = pad.getBoundingClientRect();
    dot.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px)`;
    pad.classList.add('touching');
  });
  pad.addEventListener('pointermove', (e) => {
    const p = touches.get(e.pointerId);
    if (!p || !gesture) return;
    const now = performance.now();
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    const dt = Math.max(1, now - p.t);
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });
    gesture.moved += Math.hypot(dx, dy);
    const r = pad.getBoundingClientRect();
    dot.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px)`;
    if (touches.size >= 2) {
      // Two fingers: average them into a scroll (natural direction).
      scroll(-dx / touches.size, -dy / touches.size);
      return;
    }
    // Pointer acceleration: slow = precise, fast = across the screen.
    const speed = Math.hypot(dx, dy) / dt;
    const gain = 1.4 * (1 + Math.min(2.5, speed * 1.2));
    move(dx * gain, dy * gain);
  });
  const lift = (e) => {
    touches.delete(e.pointerId);
    if (touches.size || !gesture) return;
    clearTimeout(gesture.long);
    const short = performance.now() - gesture.t0 < 260 && gesture.moved < 10;
    if (gesture.held) sendKey('ok', { hold: performance.now() - gesture.t0 });
    else if (short && gesture.multi) sendKey('back'); // two-finger tap = back
    else if (short) {
      click();
      dot.classList.remove('tap');
      void dot.offsetWidth;
      dot.classList.add('tap');
    }
    gesture = null;
    pad.classList.remove('touching');
  };
  pad.addEventListener('pointerup', lift);
  pad.addEventListener('pointercancel', lift);

  // Desktop: a captured mouse drives the TV pointer directly.
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== pad) return;
    move(e.movementX * 1.6, e.movementY * 1.6);
  });
  document.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement !== pad) return;
    e.preventDefault();
    if (e.button === 2) sendKey('back');
    else click();
  });
  pad.addEventListener('wheel', (e) => {
    if (mode !== 'trackpad') return;
    e.preventDefault();
    scroll(e.deltaX, e.deltaY);
  }, { passive: false });
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('pointerlockchange', () => pad.classList.toggle('locked', document.pointerLockElement === pad));

  // ── The keyboard bar: live typing, diffed against what we already sent ──
  const input = $('#kbInput');
  let sent = '';
  let typing = 0;
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      const now = input.value;
      let same = 0;
      while (same < sent.length && same < now.length && sent[same] === now[same]) same++;
      const del = sent.length - same;
      const add = now.slice(same);
      if (del || add) sendText({ ...(del ? { backspace: del } : {}), ...(add ? { text: add } : {}) });
      sent = now;
    }, 140);
  });
  $('#kbForm').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(typing);
    const now = input.value;
    if (now !== sent && now.startsWith(sent)) sendText({ text: now.slice(sent.length) });
    sendText({ enter: true });
    feedback('success');
    input.value = '';
    sent = '';
  });

  // ── Buttons that aren't plain keys ──
  remote.addEventListener('click', (e) => {
    const el = e.target.closest('[data-mode], [data-tp], [data-kb], #kbBtn, [data-kb-close]');
    if (!el) return;
    if (el.dataset.mode) return setMode(el.dataset.mode);
    if (el.dataset.tp === 'click') return click();
    if (el.dataset.kb === 'backspace') {
      if (input.value) {
        input.value = input.value.slice(0, -1);
        input.dispatchEvent(new Event('input'));
      } else sendText({ backspace: 1 });
      haptic('tick');
      return;
    }
    if (el.id === 'kbBtn') return toggleShortcuts();
    if (el.hasAttribute('data-kb-close')) return toggleShortcuts(false);
  });

  function toggleShortcuts(show) {
    const o = $('#kbOverlay');
    o.hidden = show === undefined ? !o.hidden : !show;
  }
  function maybeShowShortcutsOnce() {
    // Not inside the website's phone-frame demo, and only on computers.
    if (!finePointer() || window.top !== window.self || /[?&]embed=1/.test(location.search)) return;
    try {
      if (localStorage.getItem('hearth.kbhint')) return;
      localStorage.setItem('hearth.kbhint', '1');
    } catch {
      return;
    }
    setTimeout(() => toggleShortcuts(true), 600);
  }

  // ── Physical keyboard per mode (runs before the app's own key handler) ──
  window.addEventListener(
    'keydown',
    (e) => {
      if (remote.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.closest?.('dialog, #setup')) return;
      const inField = e.target.closest?.('input, textarea');
      if (e.key === '?' && !inField) {
        e.preventDefault();
        e.stopPropagation();
        return toggleShortcuts();
      }
      if (!inField && ['1', '2', '3', '4'].includes(e.key)) {
        e.stopPropagation();
        return setMode(['remote', 'stream', 'trackpad', 'gamepad'][Number(e.key) - 1]);
      }
      if (inField) return;
      if (mode === 'trackpad') {
        const arrows = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
        if (arrows[e.key]) return; // the app's handler sends arrows
        e.stopPropagation();
        if (e.key === 'Escape') return;
        e.preventDefault();
        if (e.key === 'Backspace') sendText({ backspace: 1 });
        else if (e.key === 'Enter') sendText({ enter: true });
        else if (e.key.length === 1) sendText({ text: e.key });
      } else if (mode === 'gamepad') {
        const map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok', ' ': 'ok', Backspace: 'back', Escape: 'back', x: 'play', i: 'info', '[': 'rewind', ']': 'forward', '+': 'volup', '=': 'volup', '-': 'voldown', m: 'mute' };
        const key = map[e.key];
        if (!key) return;
        e.preventDefault();
        e.stopPropagation();
        sendKey(key);
        const btn = remote.querySelector(`#p-gamepad [data-key="${key}"]`);
        btn?.classList.add('pressed');
        setTimeout(() => btn?.classList.remove('pressed'), 120);
      }
    },
    true,
  );

  // Keep "· 42m" honest, and notice "settled into watching", while open.
  setInterval(() => {
    const t = getTv();
    if (t && !remote.hidden) update(t);
  }, 15_000);

  // Every key this phone sends is a hint: arrows = browsing, play = watching.
  function noteKey(key) {
    const t = getTv();
    if (!t) return;
    keys.note(t.id, key);
    update(t);
  }

  return { update, enter, leave, noteKey, get mode() { return mode; } };
}
