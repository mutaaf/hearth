// The tour: every feature, one tip at a time. A spotlight on the real
// control, one plain sentence, and a finger showing the move (tap, hold,
// drag, swipe). It runs by itself the first time the house and the remote
// are seen, and again from "?" or Settings → Show me around.
//
// Cheap on purpose: one fixed spotlight (a box-shadow hole, so no canvas and
// no per-frame work), one bubble, CSS animations on transform/opacity only,
// one getBoundingClientRect per step. Steps whose control isn't on screen
// (another look, a TV that's off, no Live Activities on the web) are skipped.
import { haptic } from './feel.js';

const SEEN = 'hearth.tour.seen';
const PAD = 8; // spotlight margin around the control
const GAP = 14; // spotlight → bubble

const native = () => Boolean(window.HearthHost?.native);

// sel: the first visible match wins. move: the finger's gesture. If no
// control is found the step is skipped, unless it's `card` (a centred card).
const TOURS = {
  house: [
    {
      sel: ['.units .unit'],
      move: 'tap',
      title: 'Tap a TV, get its remote',
      body: 'The light shows how it’s doing: bright is on, soft is standby, grey is off or out of reach.',
    },
    {
      sel: ['.units .unit'],
      move: 'hold',
      title: 'Hold to pick a few',
      body: 'Hold one TV, tap others, then turn them all off or open the same app on all of them.',
    },
    {
      sel: ['#scenes .scene', '#scenes'],
      move: 'tap',
      title: 'Scenes',
      body: 'One tap for the whole house: “Movie night”, “Bedtime”, “Everything off”.',
    },
    {
      sel: ['#allOff'],
      move: 'hold',
      title: 'Hold for all off',
      body: 'Keep holding until it fills, and every TV goes off. Holding means no accidents.',
    },
    {
      sel: ['#units'],
      move: 'pull',
      title: 'Pull down to look again',
      body: 'Finds new TVs, and ones the router gave a new address.',
    },
    {
      sel: ['[data-action="health"]'],
      move: 'tap',
      title: 'Health check',
      body: 'How each TV is connected, how fast it answers, and a Fix button for one that goes quiet.',
    },
    {
      card: 'live',
      when: native,
      title: 'Your remote, everywhere',
      body: 'When a TV is on, its remote is also on the Lock Screen, in the Dynamic Island and on Apple Watch. Every press buzzes.',
    },
    {
      sel: ['[data-action="tour"]'],
      move: 'tap',
      title: 'See this again',
      body: 'Tap ? any time. Settings has looks, light or dark, sounds and haptics.',
    },
  ],
  remote: [
    {
      sel: ['#modeBar .mode-seg'],
      move: 'tap',
      title: 'Four remotes in one',
      body: 'Remote for menus, Watch for what’s playing, Trackpad for typing and pointing, Gamepad for games. It switches to Watch by itself when a show starts.',
    },
    {
      sel: ['#scSurface'],
      move: 'swipe',
      title: 'Watching something',
      body: 'Tap to play or pause. Swipe or tap a side to skip, hold a side to scrub, swipe down to go back.',
    },
    {
      sel: ['#orbStage', '#pad'],
      move: 'drag',
      title: 'The pad',
      body: 'Tap an edge to move. Drag like a joystick to keep going. Flick to scroll. Middle is OK; hold it for a long press.',
    },
    {
      sel: ['#volSlider', '.rocker[aria-label="Volume"]'],
      move: 'swipe',
      title: 'Volume',
      body: 'Slide up or down. Small steps on purpose, so one swipe can’t blast the room.',
    },
    {
      sel: ['.orb-key.power-key', '#rPower'],
      move: 'hold',
      title: 'Power',
      body: 'Tap to turn this TV on or off. Hold to turn every TV in the house off.',
    },
    {
      sel: ['#rStatus', '#rLed', '#hudKicker'],
      move: null,
      title: 'Is it listening?',
      body: 'This says what the TV is doing right now. If it ever says “Not responding”, tap Fix it: Hearth wakes it, finds it and reconnects.',
    },
    {
      sel: ['#switcher'],
      move: 'tap',
      title: 'Other TVs',
      body: 'Tap a name to jump straight to that TV’s remote.',
    },
    {
      sel: ['#tabs [data-tab="apps"]'],
      move: 'tap',
      title: 'Apps and inputs',
      body: 'Open Netflix, YouTube and the rest straight from here, or switch to the game console.',
    },
    {
      sel: ['#sayTab'],
      move: 'tap',
      title: 'Say',
      body: 'Type a message and it pops up on the TV. “Dinner’s ready!”',
    },
  ],
};

const reduced = () => matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const visible = (el) => {
  if (!el || el.closest('[hidden]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4;
};
const pick = (sels) => {
  for (const sel of sels) for (const el of document.querySelectorAll(sel)) if (visible(el)) return el;
  return null;
};
const load = () => {
  try {
    return JSON.parse(localStorage.getItem(SEEN) || '{}');
  } catch {
    return {};
  }
};
const remember = (name) => {
  try {
    localStorage.setItem(SEEN, JSON.stringify({ ...load(), [name]: Date.now() }));
  } catch {}
};

export function createTour() {
  let root = null;
  let steps = [];
  let at = 0;
  let name = '';
  let onKey = null;
  let onResize = null;

  function build() {
    root = document.createElement('div');
    root.className = 'tour';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Quick tour');
    root.innerHTML = `
      <div class="tour-spot" aria-hidden="true"><i class="tour-finger"></i></div>
      <div class="tour-tip" role="document">
        <div class="tour-art" aria-hidden="true"></div>
        <p class="tour-count mono"></p>
        <h3 class="tour-title"></h3>
        <p class="tour-body"></p>
        <div class="tour-actions">
          <button type="button" class="tour-skip">Skip</button>
          <button type="button" class="tour-next">Next</button>
        </div>
      </div>`;
    // Tap anywhere (but the bubble) to go on; the bubble's own buttons decide.
    root.addEventListener('click', (e) => {
      if (e.target.closest('.tour-skip')) return end();
      if (e.target.closest('.tour-next') || !e.target.closest('.tour-tip')) return next();
    });
    document.body.append(root);
    requestAnimationFrame(() => root?.classList.add('in'));
  }

  function place() {
    const step = steps[at];
    // The house redraws its cards on every TV update: point at the new one.
    if (step.sel && !step.el?.isConnected) step.el = pick(step.sel) ?? step.el;
    if (step.el && !visible(step.el)) return;
    const spot = root.querySelector('.tour-spot');
    const tip = root.querySelector('.tour-tip');
    const vw = innerWidth;
    const vh = innerHeight;
    root.classList.toggle('carded', !step.el);
    if (!step.el) {
      // A card in the middle: the spotlight shrinks to nothing behind it.
      spot.style.transform = `translate(${vw / 2}px, ${vh / 2}px)`;
      spot.style.width = spot.style.height = '0px';
      tip.style.transform = `translate(${Math.max(16, (vw - tip.offsetWidth) / 2)}px, ${Math.max(16, (vh - tip.offsetHeight) / 2)}px)`;
      return;
    }
    const r = step.el.getBoundingClientRect();
    const box = { x: r.left - PAD, y: r.top - PAD, w: r.width + PAD * 2, h: r.height + PAD * 2 };
    // A whole list is taller than the screen: keep the hole on screen.
    box.y = Math.max(8, box.y);
    box.h = Math.min(box.h, vh * 0.55);
    spot.style.transform = `translate(${box.x}px, ${box.y}px)`;
    spot.style.width = `${box.w}px`;
    spot.style.height = `${box.h}px`;
    spot.style.borderRadius = getComputedStyle(step.el).borderRadius === '50%' || r.width === r.height ? '50%' : '22px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const below = box.y + box.h + GAP + th < vh - 16 || box.y < th + GAP + 16;
    const y = below ? Math.min(box.y + box.h + GAP, vh - th - 16) : box.y - GAP - th;
    const x = Math.min(Math.max(16, box.x + box.w / 2 - tw / 2), vw - tw - 16);
    tip.style.transform = `translate(${x}px, ${Math.max(16, y)}px)`;
    tip.classList.toggle('above', !below);
    tip.style.setProperty('--arrow-x', `${Math.min(Math.max(24, box.x + box.w / 2 - x), tw - 24)}px`);
  }

  function show() {
    const step = steps[at];
    const finger = root.querySelector('.tour-finger');
    finger.className = `tour-finger ${step.move ?? 'none'}`;
    root.querySelector('.tour-art').className = `tour-art ${step.card ?? ''}`;
    root.querySelector('.tour-count').textContent = `${at + 1} of ${steps.length}`;
    root.querySelector('.tour-title').textContent = step.title;
    root.querySelector('.tour-body').textContent = step.body;
    root.querySelector('.tour-next').textContent = at === steps.length - 1 ? 'Got it' : 'Next';
    const tip = root.querySelector('.tour-tip');
    tip.classList.remove('pop');
    // Bring the control on screen (instantly: a smooth scroll would still be
    // moving when the spotlight measures it), then measure next frame.
    const r = step.el?.getBoundingClientRect();
    if (r && (r.top < 70 || r.bottom > innerHeight - 200)) step.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    requestAnimationFrame(() => {
      if (!root) return;
      place();
      tip.classList.add('pop');
    });
    root.querySelector('.tour-next').focus({ preventScroll: true });
    haptic('tick');
  }

  function next() {
    if (at >= steps.length - 1) return end();
    at++;
    show();
  }

  function end() {
    remember(name);
    removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
    removeEventListener('scroll', onResize, { capture: true });
    const el = root;
    root = null;
    if (!el) return;
    el.classList.remove('in');
    setTimeout(() => el.remove(), reduced() ? 0 : 220);
  }

  // → true when it started.
  function start(which) {
    if (root || !TOURS[which]) return false;
    steps = TOURS[which]
      .filter((s) => !s.when || s.when())
      .map((s) => ({ ...s, el: s.sel ? pick(s.sel) : null }))
      .filter((s) => s.el || s.card);
    if (!steps.length) return false;
    name = which;
    at = 0;
    build();
    onKey = (e) => {
      if (e.key === 'Escape') end();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        next();
      }
    };
    // The page can still be settling (a late scroll, a banner): follow the
    // control, at most once a frame.
    let queued = false;
    onResize = () => {
      if (queued || !root) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (root) place();
      });
    };
    addEventListener('keydown', onKey);
    addEventListener('resize', onResize);
    addEventListener('scroll', onResize, { capture: true, passive: true });
    show();
    return true;
  }

  return {
    start,
    // The first time a screen is seen. Not over a sheet, setup or the paywall.
    firstTime(which) {
      if (load()[which] || document.querySelector('dialog[open], .setup:not([hidden])')) return false;
      return start(which);
    },
    reset() {
      try {
        localStorage.removeItem(SEEN);
      } catch {}
    },
    get open() {
      return Boolean(root);
    },
    get name() {
      return root ? name : '';
    },
    end,
  };
}
