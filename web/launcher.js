// The app launcher: the popular streaming apps as one grid that works the
// same on every brand. On the house view, hold an app to open it on every TV
// (or the selected ones in select mode); on a TV's Apps panel, tap to open it
// there. The server resolves each TV's own app id (src/catalog.js) and answers
// per TV, so the ✓ / ✕ chips say exactly where it opened and why not.
import { feedback, haptic } from './feel.js';
import { brandSvg, hydrate, tvIconImg } from './icons.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const REASONS = { 'not-installed': 'not installed', unsupported: 'can’t open', off: 'off', offline: 'off', unpaired: 'not connected' };

// Dark text on light brand colours (Pluto yellow, Hulu green).
function ink(hex) {
  const m = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(hex ?? '');
  if (!m) return '#fff';
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? '#111' : '#fff';
}

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function createLauncher({ api, note, getTvs, getCurrent, getSelected, isSelecting }) {
  let catalog = [];
  let status = {};
  let results = null; // { key, title, list }
  let resultsTimer = 0;
  let busy = null;
  let wake = load('hearth.launch.wake', true);
  let mode = 'here'; // remote panel: 'here' | 'all'
  let statusTimer = 0;

  const paired = () => getTvs().filter((t) => t.paired);

  async function loadAll() {
    try {
      catalog = await api('GET', '/catalog');
    } catch {
      catalog = [];
    }
    await refreshStatus();
  }

  async function refreshStatus(fresh = false) {
    try {
      status = await api('GET', `/catalog/status${fresh ? '?fresh=1' : ''}`);
    } catch {}
    renderAll();
  }

  // TVs coming online can list their apps now; ask again, gently.
  function statusSoon() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => refreshStatus(), 1500);
  }

  const has = (tvId, key) => status[tvId]?.[key] ?? { installed: null };

  // The real icon for this app from a TV in the house that has it, if any.
  function tvIcon(app) {
    for (const t of paired()) {
      const s = status[t.id]?.[app.key];
      if (s?.installed && s.icon && t.capabilities?.appIcons) return tvIconImg(t.id, s.icon);
    }
    return '';
  }

  function tile(app, { press, data, badge, missing, current, hold, label }) {
    return `<button type="button" class="app cat${missing ? ' missing' : ''}${current ? ' current' : ''}${hold ? ' hold' : ''}${busy === app.key ? ' busy' : ''}" data-press="${press}" ${data}="${esc(app.key)}" aria-label="${esc(label)}">
      ${hold ? '<span class="charge" aria-hidden="true"></span>' : ''}
      <span class="app-icon cat-icon" style="--tint:${esc(app.color)};--fg:${ink(app.color)}">${brandSvg(app.key) || `<b data-len="${[...app.mark].length}">${esc(app.mark)}</b>`}${tvIcon(app)}</span>
      <span>${esc(app.title)}</span>
      ${badge ? `<small class="cat-badge mono">${esc(badge)}</small>` : ''}
    </button>`;
  }

  function resultsHtml() {
    if (!results) return '';
    return `<div class="launch-results" aria-live="polite">${results.list
      .map((r) => `<span class="chip-result ${r.ok ? 'ok' : 'bad'}" title="${esc(r.error ?? '')}">${r.ok ? '✓' : '✕'} ${esc(r.name)}${r.ok ? '' : ` · ${esc(REASONS[r.reason] ?? r.error ?? 'failed')}`}</span>`)
      .join('')}</div>`;
  }

  // ── House view: "Watch" strip ──
  function renderHouse() {
    const el = document.querySelector('#watch');
    if (!el) return;
    const tvs = paired();
    if (!catalog.length || !tvs.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const selecting = isSelecting();
    const chosen = selecting ? tvs.filter((t) => getSelected().includes(t.id)) : tvs;
    const where = selecting ? (chosen.length ? `the ${chosen.length} selected` : 'the selected TVs') : 'every TV';
    const ranked = [...catalog].sort((a, b) => count(b, tvs) - count(a, tvs));
    const html = `
      <div class="scenes-head watch-head">
        <h3>Watch on ${esc(where)}</h3>
        <button type="button" class="wake-toggle mono ${wake ? 'on' : ''}" data-press="up" data-wake-toggle aria-pressed="${wake}">${wake ? '⏻ Wake TVs: on' : '⏻ Wake TVs: off'}</button>
      </div>
      <div class="watch-row" role="list">
        ${ranked
          .map((app) => {
            const n = count(app, chosen);
            const known = chosen.filter((t) => has(t.id, app.key).installed != null).length;
            return tile(app, {
              press: 'confirm',
              data: 'data-launch-all',
              hold: true,
              missing: known === chosen.length && n === 0,
              badge: chosen.length ? `${n}/${chosen.length}` : '',
              label: `Hold to open ${app.title} on ${where}`,
            });
          })
          .join('')}
      </div>
      <p class="watch-hint mono">Hold an app to open it · 2/3 = TVs that have it</p>
      ${results?.where === 'house' ? resultsHtml() : ''}`;
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      hydrate(el, api);
    }
  }

  const count = (app, tvs) => tvs.filter((t) => has(t.id, app.key).installed === true).length;

  // ── Remote view: "Streaming" grid on the Apps panel ──
  function renderPanel(t) {
    const el = document.querySelector('#catalogApps');
    if (!el || !t) return;
    const head = document.querySelector('#launchMode');
    if (!catalog.length) {
      el.innerHTML = '';
      if (head) head.hidden = true;
      return;
    }
    if (head) {
      head.hidden = false;
      const seg = `<button type="button" class="${mode === 'here' ? 'active' : ''}" data-press="up" data-launch-mode="here">This TV</button><button type="button" class="${mode === 'all' ? 'active' : ''}" data-press="up" data-launch-mode="all">All TVs · hold</button>`;
      if (head.innerHTML !== seg) head.innerHTML = seg;
    }
    const all = mode === 'all';
    const tvs = paired();
    const ranked = [...catalog].sort((a, b) => rank(b) - rank(a));
    function rank(app) {
      const s = has(t.id, app.key);
      return (s.installed === true ? 2 : s.installed == null ? 1 : 0) + count(app, tvs) / 100;
    }
    const html =
      ranked
        .map((app) => {
          const s = has(t.id, app.key);
          const current = s.appId && s.appId === t.state?.app;
          return tile(app, {
            press: all ? 'confirm' : 'up',
            data: all ? 'data-launch-all' : 'data-launch',
            hold: all,
            current,
            missing: !all && s.installed === false,
            badge: all ? `${count(app, tvs)}/${tvs.length}` : s.installed === false ? (s.reason === 'unsupported' ? 'no Cast' : 'not here') : current ? 'on now' : '',
            label: all ? `Hold to open ${app.title} on every TV` : `Open ${app.title} on ${t.name}`,
          });
        })
        .join('') + (results?.where === 'panel' ? resultsHtml() : '');
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      hydrate(el, api);
    }
  }

  function renderAll() {
    renderHouse();
    const cur = getCurrent();
    if (cur) renderPanel(cur);
  }

  function showResults(key, list, where) {
    results = { key, list, where };
    clearTimeout(resultsTimer);
    resultsTimer = setTimeout(() => {
      results = null;
      renderAll();
    }, 9000);
    renderAll();
  }

  async function launch(key, tvs, where) {
    const app = catalog.find((a) => a.key === key);
    const title = app?.title ?? key;
    busy = key;
    renderAll();
    haptic('press');
    try {
      const res = await api('POST', '/launch', { app: key, tvs, wake });
      const good = res.results.filter((r) => r.ok).length;
      feedback(good ? 'success' : 'error');
      if (res.results.length === 1) {
        const r = res.results[0];
        note(r.ok ? `Opening ${title}${r.woke ? ' (woke it up)' : ''}` : `${title}: ${r.error}`, !r.ok);
      } else {
        note(good === res.results.length ? `${title} on all ${good} TVs ✓` : `${title}: ${good} of ${res.results.length} TVs`, good === 0);
      }
      if (res.results.length > 1 || !res.results[0].ok) showResults(key, res.results, where);
      // Opening an app tells us it's installed; failures may mean the cache is stale.
      if (good < res.results.length) refreshStatus(true);
    } catch (err) {
      feedback('error');
      note(err.message, true);
    } finally {
      busy = null;
      renderAll();
    }
  }

  return {
    load: loadAll,
    statusSoon,
    renderHouse,
    renderPanel,
    shortHoldHint(el) {
      const key = el.closest('[data-launch-all]')?.dataset.launchAll;
      const app = catalog.find((a) => a.key === key);
      const where = isSelecting() && getSelected().length ? 'the selected TVs' : 'every TV';
      return app ? `Keep holding to open ${app.title} on ${where}` : null;
    },
    handle(el) {
      const d = el.dataset;
      if (d.wakeToggle !== undefined) {
        wake = !wake;
        save('hearth.launch.wake', wake);
        haptic('tick');
        note(wake ? 'TVs that are off will be woken first' : 'Only TVs that are already on');
        return renderAll();
      }
      if (d.launchMode) {
        mode = d.launchMode;
        haptic('tick');
        return renderAll();
      }
      if (d.launch) {
        const t = getCurrent();
        if (!t) return;
        return launch(d.launch, [t.id], 'panel');
      }
      if (d.launchAll) {
        const fromPanel = Boolean(el.closest('#catalogApps'));
        const ids = isSelecting() && !fromPanel ? getSelected() : 'all';
        if (Array.isArray(ids) && !ids.length) return note('Tap a TV first', true);
        return launch(d.launchAll, ids, fromPanel ? 'panel' : 'house');
      }
    },
  };
}
