// The Stream Center: the remote you want while something is playing. One big
// touch surface (tap = play/pause, swipe or tap a side = skip, hold a side =
// scrub, swipe down = back), what's on with a live progress bar, volume, and
// one tap back to the D-pad for browsing. modes.js shows it as the "Watch"
// mode and switches to it by itself when playback starts (web/playback.js).
import { feedback, haptic } from './feel.js';
import { clock, livePosition } from './playback.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const SKIP_ICON = (dir) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${dir < 0 ? 'M12 5a7 7 0 1 1-6.6 9.3' : 'M12 5a7 7 0 1 0 6.6 9.3'}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="${dir < 0 ? 'M12 2 8.5 5 12 8' : 'M12 2l3.5 3L12 8'}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export function createStream({ remote, sendKey, getTv, onBrowse }) {
  const panels = remote.querySelector('.panels');
  panels.insertAdjacentHTML(
    'beforeend',
    `<section class="mode-panel" id="p-stream" aria-label="Stream Center">
      <div class="sc-now">
        <span class="sc-mark" id="scMark" aria-hidden="true"></span>
        <span class="sc-meta"><small class="mono" id="scApp"></small><b id="scTitle"></b></span>
        <span class="sc-state mono" id="scState"></span>
      </div>
      <div class="sc-progress" id="scProgress">
        <div class="sc-track"><i id="scFill"></i><b id="scKnob"></b></div>
        <div class="sc-times mono"><span id="scPos"></span><span id="scLeft"></span></div>
      </div>
      <div class="sc-surface" id="scSurface" aria-label="Tap to play or pause, swipe or tap a side to skip, hold a side to scrub, swipe down to go back">
        <span class="sc-side l" aria-hidden="true">${SKIP_ICON(-1)}<small class="mono">back</small></span>
        <span class="sc-orb" id="scOrb" aria-hidden="true"><svg class="i-play"><use href="#i-play"/></svg><svg class="i-pause"><use href="#i-pause"/></svg></span>
        <span class="sc-side r" aria-hidden="true">${SKIP_ICON(1)}<small class="mono">ahead</small></span>
        <span class="sc-ripple" id="scRipple" aria-hidden="true"></span>
        <span class="sc-hint mono" id="scHint">tap · play/pause &nbsp; swipe · skip &nbsp; ↓ · back</span>
      </div>
      <div class="sc-row">
        <button type="button" data-press="repeat" data-key="voldown" aria-label="Volume down">VOL −</button>
        <button type="button" data-press="down" data-key="mute" aria-label="Mute"><svg><use href="#i-mute"/></svg></button>
        <button type="button" data-press="repeat" data-key="volup" aria-label="Volume up">VOL +</button>
        <button type="button" class="sc-browse" data-sc="browse" aria-label="Browse with the D-pad"><svg><use href="#i-pad"/></svg> Browse</button>
      </div>
    </section>`,
  );
  const $ = (s) => remote.querySelector(s);
  const surface = $('#scSurface');
  // What we believe the player is doing when the TV can't say (Samsung,
  // Google TV): flipped on every tap, corrected whenever the TV reports.
  let belief = 'playing';
  let lastId = null;

  const media = () => getTv()?.state?.media ?? null;
  const playing = () => {
    const m = media();
    return m && m.state !== 'stopped' ? m.state !== 'paused' : belief === 'playing';
  };

  function togglePlay() {
    const t = getTv();
    if (!t) return;
    const was = playing();
    // Roku and Apple TV treat play as a toggle; LG/Samsung need the right one.
    sendKey(was ? 'pause' : 'play');
    belief = was ? 'paused' : 'playing';
    feedback('success');
    ripple('center');
    render(t);
  }

  function skip(dir, { repeat = false } = {}) {
    sendKey(dir < 0 ? 'rewind' : 'forward', { repeat });
    ripple(dir < 0 ? 'left' : 'right');
  }

  const rip = $('#scRipple');
  function ripple(where) {
    rip.className = `sc-ripple at-${where}`;
    void rip.offsetWidth;
    rip.classList.add('go');
  }

  // ── The touch surface ──
  let g = null;
  surface.addEventListener('pointerdown', (e) => {
    try {
      surface.setPointerCapture(e.pointerId);
    } catch {}
    const r = surface.getBoundingClientRect();
    const zone = (e.clientX - r.left) / r.width < 0.3 ? -1 : (e.clientX - r.left) / r.width > 0.7 ? 1 : 0;
    g = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), zone, scrub: null, done: false };
    surface.classList.add('touching');
    // Hold a side: scrub, faster the longer you hold.
    if (zone) {
      g.hold = setTimeout(() => {
        if (!g || g.done) return;
        g.scrub = 0;
        haptic('press');
        const tick = () => {
          if (!g || g.done || g.scrub == null) return;
          skip(zone, { repeat: true });
          g.scrub++;
          g.hold = setTimeout(tick, Math.max(140, 420 - g.scrub * 40));
        };
        tick();
      }, 380);
    }
  });
  surface.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id || g.done || g.scrub != null) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (Math.hypot(dx, dy) < 36) return;
    clearTimeout(g.hold);
    g.done = true;
    if (Math.abs(dx) > Math.abs(dy)) skip(dx < 0 ? -1 : 1);
    else if (dy > 0) {
      sendKey('back');
      ripple('down');
    } else {
      sendKey('info');
      ripple('up');
    }
  });
  const lift = (e) => {
    if (!g || e.pointerId !== g.id) return;
    clearTimeout(g.hold);
    if (!g.done && g.scrub == null && e.type === 'pointerup' && performance.now() - g.t < 500) {
      if (g.zone) skip(g.zone);
      else togglePlay();
    }
    surface.classList.remove('touching');
    g = null;
  };
  surface.addEventListener('pointerup', lift);
  surface.addEventListener('pointercancel', lift);
  $('#p-stream').addEventListener('click', (e) => {
    if (e.target.closest('[data-sc="browse"]')) {
      haptic('tap');
      onBrowse();
    }
  });

  // ── What's on ──
  function render(t) {
    if (!t) return;
    if (t.id !== lastId) {
      lastId = t.id;
      belief = 'playing';
    }
    const s = t.state ?? {};
    const m = s.media;
    if (m && m.state !== 'stopped') belief = m.state === 'paused' ? 'paused' : 'playing';
    const app = s.appTitle || s.inputLabel || (s.app ? String(s.app).split('.').pop() : '') || 'Now playing';
    $('#scMark').textContent = app.trim().charAt(0).toUpperCase();
    $('#scApp').textContent = app;
    $('#scTitle').textContent = s.nowPlaying || (m?.live ? 'Live' : app);
    const known = Boolean(m && m.state !== 'stopped');
    const state = known ? m.state : belief;
    $('#scState').textContent = m?.live ? 'LIVE' : known ? { playing: 'Playing', paused: 'Paused', buffering: 'Loading' }[state] : '';
    $('#p-stream').dataset.state = playing() ? 'playing' : 'paused';
    $('#p-stream').dataset.known = String(known);
    tick();
  }

  function tick() {
    const m = media();
    const pos = livePosition(m);
    const bar = $('#scProgress');
    bar.hidden = pos == null;
    if (pos == null) return;
    const frac = m.duration ? Math.min(1, pos / m.duration) : 0;
    $('#scFill').style.transform = `scaleX(${frac})`;
    $('#scKnob').style.left = `${frac * 100}%`;
    $('#scPos').textContent = clock(pos);
    $('#scLeft').textContent = m.duration ? `−${clock(m.duration - pos)}` : '';
  }
  setInterval(() => {
    if (!remote.hidden && remote.dataset.mode === 'stream') tick();
  }, 500);

  return { render, describe: esc };
}
