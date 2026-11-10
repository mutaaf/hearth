// "What's new": a playful sheet that shows once after Hearth updates to a new
// version. A theatre-sign hero with an aurora that draws each feature's shape, 2-4
// callout cards, the full notes in an accordion, one button out.
//
// Once per version, never on a fresh install: the first launch with this code
// records the version as seen, unless the phone already has Hearth's own
// storage from an older version (then it's an upgrade and the sheet shows).
// Never under the public demo / in-app demo / store capture (window.HearthDemo),
// the landing page's phone frame (?embed=1 or an iframe) or automation
// (navigator.webdriver). `?whatsnew=preview` shows it anyway without recording.
// Settings → What's new opens it any time. The words: web/whatsnew-notes.js.

import { NOTES, RELEASE_VERSION, notesFor } from './whatsnew-notes.js';

export const SEEN_KEY = 'hearth.whatsnew';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// 1.2.10 > 1.2.9; missing parts count as 0; junk counts as 0.0.0.
export function compareVersions(a, b) {
  const parts = (v) => String(v ?? '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  return 0;
}

// The whole rule, pure. seen: the version recorded on this phone (or null);
// hasHistory: Hearth already stored something here before this code ran.
// → { show, record }: record is the version to save now (null = leave it).
export function decide({ seen, current, hasHistory = false, hasNotes = true }) {
  if (!current) return { show: false, record: null };
  if (seen == null || seen === '') {
    // No record yet: a fresh install stays quiet; an upgrade from a version
    // older than this feature gets the sheet once.
    return { show: Boolean(hasHistory && hasNotes), record: current };
  }
  if (compareVersions(current, seen) <= 0) return { show: false, record: seen === current ? null : current };
  return { show: Boolean(hasNotes), record: current };
}

// Why not to show anything (null = go ahead).
export function skipReason({ demo = false, embed = false, framed = false, webdriver = false } = {}) {
  if (demo) return 'demo';
  if (embed) return 'embed';
  if (framed) return 'frame';
  if (webdriver) return 'automation';
  return null;
}

function envNow() {
  const w = globalThis.window;
  const search = w?.location?.search ?? '';
  let framed = false;
  try {
    framed = Boolean(w && w.top !== w.self);
  } catch {
    framed = true;
  }
  return {
    demo: Boolean(w?.HearthDemo),
    embed: /[?&]embed=1\b/.test(search),
    framed,
    webdriver: Boolean(globalThis.navigator?.webdriver),
    preview: /[?&]whatsnew=preview\b/.test(search),
  };
}

const storage = () => {
  try {
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
};

// Did an older Hearth leave anything here? Read once, when this module loads,
// before anything in this launch writes.
export function hadHistory(ls = storage()) {
  try {
    if (!ls) return false;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith('hearth.') && k !== SEEN_KEY) return true;
    }
  } catch {}
  return false;
}
const HISTORY_AT_LOAD = hadHistory();

const readSeen = (ls) => {
  try {
    return ls?.getItem(SEEN_KEY) ?? null;
  } catch {
    return null;
  }
};
const writeSeen = (ls, v) => {
  try {
    ls?.setItem(SEEN_KEY, v);
  } catch {}
};

// Everything the launch decides, with the real environment by default.
export function launchDecision({ env = envNow(), ls = storage(), current = RELEASE_VERSION, hasHistory = HISTORY_AT_LOAD } = {}) {
  if (env.preview) return { show: true, record: null, why: 'preview' };
  const why = skipReason(env);
  if (why) return { show: false, record: null, why };
  return { ...decide({ seen: readSeen(ls), current, hasHistory, hasNotes: Boolean(notesFor(current)) }), why: null };
}

// One of Hearth's own shapes (web/shapes.js) as a small SVG, filled with a gradient.
let uid = 0;
function art(name, palette) {
  const paths = globalThis.window?.HearthShapes?.paths?.(name);
  const id = `wn-g${++uid}`;
  const stops = palette === 'ice' ? ['#5ee7ff', '#7a6bff'] : ['#ffb35c', '#f25a1d'];
  const d = paths ? paths.join(' ') : 'M50 18 a32 32 0 1 0 0.01 0 Z';
  return `<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${stops[0]}"/><stop offset="1" stop-color="${stops[1]}"/></linearGradient></defs><path d="${d}" fill="url(#${id})" fill-rule="evenodd"/></svg>`;
}

export function createWhatsNew({ track = () => {}, haptic = () => {}, onClose = () => {}, ls = storage() } = {}) {
  let dlg = null;
  let field = null;
  let cycle = null;
  let from = 'update';
  let opened = 0;

  function mount() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'sheet wn-sheet';
    dlg.id = 'whatsNewSheet';
    dlg.setAttribute('aria-labelledby', 'wnTitle');
    document.body.append(dlg);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) return dlg.close(); // the backdrop
      if (e.target.closest('[data-wn="close"]')) {
        haptic('tap');
        dlg.close();
      }
    });
    dlg.addEventListener('toggle', (e) => {
      if (e.target.matches?.('details.wn-more') && e.target.open) track('whats_new', { step: 'notes', version: dlg.dataset.version });
    }, true);
    dlg.addEventListener('close', () => {
      clearInterval(cycle);
      field?.destroy();
      field = null;
      track('whats_new', { step: 'close', version: dlg.dataset.version, from, secs: Math.round((Date.now() - opened) / 1000) });
      onClose();
    });
    return dlg;
  }

  function paint(n) {
    const version = n.version.replace(/\.0$/, '');
    dlg.dataset.version = n.version;
    dlg.innerHTML = `
      <div class="sheet-grip"></div>
      <header class="wn-hero">
        <div class="wn-sky" aria-hidden="true">
          <div class="wn-glow"></div><canvas></canvas><div class="wn-stage"></div>
          <div class="wn-bulbs"></div>
        </div>
        <div class="wn-title">
          <p class="wn-kicker mono"><span>${esc(n.kicker)}</span> <span class="wn-ver">Hearth ${esc(version)}</span></p>
          <h3 id="wnTitle">${esc(n.headline)}</h3>
          <p class="wn-dek">${esc(n.dek)}</p>
        </div>
      </header>
      <ul class="wn-cards" aria-label="Highlights">
        ${n.callouts.map((c, i) => `
          <li class="wn-card" data-palette="${c.palette === 'ice' ? 'ice' : 'ember'}" style="--i:${i}">
            <span class="wn-art">${art(c.art, c.palette)}</span>
            <span class="wn-text"><b>${esc(c.title)}</b><small>${esc(c.line)}</small></span>
          </li>`).join('')}
      </ul>
      <details class="wn-more">
        <summary><span>Every change in ${esc(version)}</span><span class="wn-count mono">${n.notes.length}</span></summary>
        <ul>${n.notes.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </details>
      <div class="sheet-actions wn-actions">
        <button type="button" class="cta wn-go" data-press="up" data-wn="close" autofocus>On with the show</button>
      </div>`;
  }

  // The sign's aurora draws each callout's shape in turn.
  function sky(n) {
    const AF = globalThis.window?.AuroraField;
    if (!AF || reduced()) return;
    try {
      globalThis.window.HearthShapes?.register(AF);
      const canvas = dlg.querySelector('.wn-sky canvas');
      const shapes = [...new Set(n.callouts.map((c) => c.art))];
      field = AF.create(canvas, {
        palette: 'ember', shapes, initial: shapes[0], cycle: 0, interactive: false,
        count: innerWidth < 500 ? 1000 : 1500, stars: 36, depth: 1.5, container: canvas, maxDpr: 2, fpsFloor: 24,
        stage: dlg.querySelector('.wn-stage'),
      });
      let at = 0;
      cycle = setInterval(() => {
        at = (at + 1) % n.callouts.length;
        const c = n.callouts[at];
        field?.setShape(c.art, { pin: true });
        field?.set({ palette: c.palette === 'ice' ? 'ice' : 'ember' });
      }, 3400);
    } catch {
      field = null;
    }
  }

  function open(version = RELEASE_VERSION, how = 'settings') {
    const n = notesFor(version) ?? NOTES[0];
    if (!n) return false;
    mount();
    if (dlg.open) return true;
    from = how;
    opened = Date.now();
    paint(n);
    dlg.showModal();
    dlg.scrollTop = 0;
    dlg.querySelector('.wn-go')?.focus({ preventScroll: true });
    sky(n);
    track('whats_new', { step: 'open', version: n.version, from });
    return true;
  }

  return {
    // At launch: shows the sheet when this is an update. blocked() = something
    // else is up (setup, the tour, a sheet): then nothing is recorded, so it
    // tries again next launch.
    maybeShow({ blocked = () => false, decision = launchDecision({ ls }) } = {}) {
      if (!decision.show) {
        if (decision.record) writeSeen(ls, decision.record);
        return false;
      }
      if (blocked()) return false;
      if (decision.record) writeSeen(ls, decision.record);
      return open(RELEASE_VERSION, decision.why === 'preview' ? 'preview' : 'update');
    },
    open,
    get isOpen() {
      return Boolean(dlg?.open);
    },
  };
}
