// Pull to refresh. Pull down from the top of the house list (or the top of a
// remote: the TV switcher and the "now" card), an ember drops in and fills as
// you pull, ticks when it's far enough, and on release every TV re-reads what
// it's doing. Never from the D-pad, sliders, trackpad or Stream Center, which
// own their own swipes. Touch events (not pointer) so the page's own scroll
// and Safari's native pull can be cancelled while we own the gesture.
import { feedback, haptic } from './feel.js';

const THRESHOLD = 72; // px of pull (after resistance) that refreshes
const MAX = 120;
// Where a pull may start in the remote view; the house view is all fair game.
const REMOTE_ZONES = '.remote-top, .hud, .hud-ticker, .device-head, .mode-bar, .pair-banner, .fix-banner';
const NEVER = '.pad, .orb-zone, .slider, .rocker-ch, .sc-surface, .mode-panel, .kb-overlay, input, textarea, select, dialog, .door, .away-overlay, .bulkbar, [data-no-pull]';

export function createPull({ onRefresh }) {
  const ind = document.createElement('div');
  ind.className = 'ptr';
  ind.setAttribute('aria-hidden', 'true');
  ind.innerHTML = '<svg viewBox="0 0 40 40"><circle class="ptr-trk" cx="20" cy="20" r="15"/><circle class="ptr-arc" cx="20" cy="20" r="15" pathLength="100"/></svg><i></i>';
  document.body.append(ind);
  const live = document.createElement('p');
  live.className = 'sr-only';
  live.setAttribute('role', 'status');
  document.body.append(live);

  let g = null;
  let busy = false;

  const view = () => document.querySelector('#remote:not([hidden])') ?? document.querySelector('#house');
  const scrolledAt = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) if (n.scrollTop > 0) return true;
    return (document.scrollingElement?.scrollTop ?? 0) > 0;
  };
  function allowed(target) {
    if (busy || document.querySelector('dialog[open], .door, .away-overlay, .setup:not([hidden])')) return false;
    if (!(target instanceof Element) || target.closest(NEVER)) return false;
    const remote = document.querySelector('#remote:not([hidden])');
    if (remote && !target.closest(REMOTE_ZONES)) return false;
    return !scrolledAt(target);
  }

  function paint(dist) {
    const p = Math.min(1, dist / THRESHOLD);
    ind.style.setProperty('--pull', String(dist));
    ind.style.setProperty('--p', String(p));
    ind.classList.toggle('ready', dist >= THRESHOLD);
    const v = view();
    if (v) v.style.transform = dist ? `translateY(${dist * 0.55}px)` : '';
  }

  function settle() {
    const v = view();
    if (v) {
      v.style.transition = 'transform .35s cubic-bezier(.2, .9, .2, 1)';
      v.style.transform = '';
      setTimeout(() => (v.style.transition = ''), 400);
    }
  }

  addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || !allowed(e.target)) return;
    g = { x: e.touches[0].clientX, y: e.touches[0].clientY, dist: 0, on: false, ready: false };
  }, { passive: true });

  addEventListener('touchmove', (e) => {
    if (!g) return;
    const dx = e.touches[0].clientX - g.x;
    const dy = e.touches[0].clientY - g.y;
    if (!g.on) {
      if (Math.abs(dx) > Math.abs(dy) || dy < 0) return void (g = Math.abs(dx) > 10 || dy < -10 ? null : g);
      if (dy < 8) return;
      g.on = true;
      ind.classList.add('show');
    }
    e.preventDefault(); // ours now: no page scroll, no browser reload
    // Rubber band: easy at first, heavier the further you go.
    g.dist = Math.max(0, Math.min(MAX, MAX * (1 - Math.exp(-Math.max(0, dy - 8) / 110))));
    const ready = g.dist >= THRESHOLD;
    if (ready !== g.ready) haptic(ready ? 'press' : 'tick');
    g.ready = ready;
    paint(g.dist);
  }, { passive: false });

  const end = async () => {
    if (!g) return;
    const { on, ready } = g;
    g = null;
    if (!on) return;
    if (!ready) {
      ind.classList.remove('show', 'ready');
      paint(0);
      settle();
      return;
    }
    busy = true;
    ind.classList.add('spin');
    live.textContent = 'Refreshing every TV';
    paint(THRESHOLD * 0.7);
    const t0 = performance.now();
    let ok = true;
    try {
      await onRefresh();
    } catch {
      ok = false;
    }
    // Long enough to read as "it did something", never a stuck spinner.
    await new Promise((r) => setTimeout(r, Math.max(0, 550 - (performance.now() - t0))));
    feedback(ok ? 'success' : 'error');
    live.textContent = ok ? 'Up to date' : 'Couldn’t refresh';
    ind.classList.add(ok ? 'done' : 'fail');
    setTimeout(() => {
      ind.classList.remove('show', 'ready', 'spin', 'done', 'fail');
      paint(0);
      settle();
      busy = false;
    }, 420);
  };
  addEventListener('touchend', end);
  addEventListener('touchcancel', end);

  return { get busy() { return busy; } };
}
