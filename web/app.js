// Hearth web app. No framework, no build step: state lives in `tvs`, the
// server pushes changes over /api/events, and render() repaints. Touch feel
// lives in feel.js, the setup wizard in setup.js, skins are pure CSS.
import { applySkin, feedback, gesturePad, haptic, keepAwake, pressable, prefs, savePrefs, sound, soundOn } from './feel.js';
import { createSetup } from './setup.js';

const $ = (sel, el = document) => el.querySelector(sel);
const tvs = new Map();
const appCache = new Map();
let nearby = [];
let current = null;
let tab = 'remote';
let editing = null;
let firstPaint = true;
let greeted = false;

applySkin();

// Friendly names for what's on screen (LG reports the foreground app id).
const APP_NAMES = {
  netflix: 'Netflix',
  'youtube.leanback.v4': 'YouTube',
  'youtube.leanback.kids.v4': 'YouTube Kids',
  amazon: 'Prime Video',
  'com.disney.disneyplus-prod': 'Disney+',
  hulu: 'Hulu',
  'com.hbo.hbomax': 'Max',
  'spotify-beehive': 'Spotify',
  'com.apple.appletv': 'Apple TV',
  'com.webos.app.livetv': 'Live TV',
  'com.webos.app.home': 'Home',
  'com.webos.app.homeconnect': 'Home',
  'com.webos.app.browser': 'Browser',
  'com.webos.app.photovideo': 'Photos',
  'com.webos.app.screensaver': 'Screensaver',
};
const KEY_LABEL = {
  up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', ok: 'OK', back: 'BACK', home: 'HOME', menu: 'MENU',
  volup: 'VOL+', voldown: 'VOL-', mute: 'MUTE', chup: 'CH+', chdown: 'CH-', play: 'PLAY', pause: 'PAUSE',
  rewind: 'REW', forward: 'FFWD', source: 'SOURCE', info: 'INFO', exit: 'EXIT', stop: 'STOP',
};

// ── Helpers ──────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The demo on mutaafaziz.com/hearth/demo swaps the server for simulated TVs
// (web/demo.js); everything else in the app is identical.
const demo = window.HearthDemo;

async function api(method, path, body) {
  if (demo) return demo.api(method, path, body);
  const init = { method };
  if (method !== 'GET' && method !== 'DELETE') {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`/api${path}`, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
  return data;
}

let noteTimer;
function note(message, error = false) {
  const el = $('#note');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => el.classList.remove('show'), error ? 4200 : 2200);
}

const isOn = (t) => t.state?.online && t.state.power === 'on';
// Older Samsungs answer the network even asleep, so we can't know: "Ready".
const isUnknown = (t) => t.state?.online && t.state.power === 'unknown';
const isStandby = (t) => t.state?.online && /standby|screen_off|screen_saver/.test(t.state.power);
const ledClass = (t) => (!t.paired ? 'unpaired' : isOn(t) ? 'on' : isStandby(t) ? 'standby' : 'off');
const statusWord = (t) =>
  !t.paired ? (t.state?.online ? 'On · tap to connect' : 'Off · tap to connect') : isOn(t) ? 'On' : isUnknown(t) ? 'Ready' : isStandby(t) ? 'Standby' : 'Off';
const BRANDS = { lg: 'LG', samsung: 'Samsung', roku: 'Roku', androidtv: 'Google TV' };
const brandName = (b) => BRANDS[b] ?? 'TV';

function appName(t) {
  if (t.state?.appTitle) return t.state.appTitle;
  const id = t.state?.app;
  if (!id) return isOn(t) ? 'On' : '';
  const cached = appCache.get(t.id)?.find((a) => a.id === id);
  if (cached) return cached.title;
  if (APP_NAMES[id]) return APP_NAMES[id];
  const hdmi = id.match(/hdmi(\d)/i);
  if (hdmi) return `HDMI ${hdmi[1]}`;
  const last = id.split('.').pop().replace(/[-_]/g, ' ');
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function tint(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `oklch(0.55 0.15 ${h})`;
}

// ── House view ───────────────────────────────────────────
function renderHouse() {
  const list = [...tvs.values()];
  const on = list.filter(isOn).length;
  $('#empty').hidden = list.length > 0;
  $('#units').hidden = list.length === 0;
  $('#allOff').disabled = list.length === 0;
  $('#heroLine').textContent =
    list.length === 0 ? 'One remote for the whole house.'
    : on === 0 ? 'All quiet. Every screen is off.'
    : on === list.length ? `All ${on} screen${on === 1 ? ' is' : 's are'} on.`
    : `${on} of ${list.length} screens are on.`;
  $('#onCount').textContent = list.length ? `${on} on · ${list.length} total · long-press a TV for options` : '';

  const banner = $('#nearby');
  banner.hidden = !nearby.length;
  if (nearby.length) {
    $('#nearbyName').textContent = nearby.length === 1 ? `New TV nearby: ${nearby[0].name}` : `${nearby.length} new TVs nearby`;
  }

  const units = $('#units');
  units.classList.toggle('settled', !firstPaint);
  units.innerHTML = list
    .map((t, i) => `
      <article class="unit ${ledClass(t)}" style="--i:${i}" data-press="long" data-open="${esc(t.id)}" tabindex="0" role="button" aria-label="${esc(t.name)}, ${esc(statusWord(t))}. Long-press for options.">
        <div class="screen"><div class="scan"></div><span class="now">${esc(appName(t))}</span></div>
        ${t.paired || t.canWake ? `<button type="button" class="quick" data-press="down" data-quick="${esc(t.id)}" aria-label="Power ${esc(t.name)}"><svg><use href="#i-power"/></svg></button>` : ''}
        <div class="unit-meta">
          <h3 class="unit-name">${esc(t.name)}</h3>
          <p class="unit-sub mono">${esc([t.room !== t.name ? t.room : '', brandName(t.brand), t.model].filter(Boolean).join(' · '))}</p>
          <span class="unit-state mono"><span class="led"></span>${esc(statusWord(t))}</span>
        </div>
        ${t.paired ? '' : '<span class="unit-pair mono">Tap to connect</span>'}
      </article>`)
    .join('');
  if (list.length) firstPaint = false;
  houseField?.setShape(on ? 'hearth-house' : 'hearth-flame', { pin: true });
}

// ── Remote view ──────────────────────────────────────────
function renderSwitcher() {
  const list = [...tvs.values()];
  const bar = $('#switcher');
  const html = list
    .map((t) => `<button type="button" role="tab" class="switch ${t.id === current ? 'active' : ''}" data-press="up" data-switch="${esc(t.id)}" aria-selected="${t.id === current}"><span class="led ${ledClass(t)}"></span>${esc(t.name)}</button>`)
    .join('');
  if (bar.innerHTML !== html) {
    bar.innerHTML = html;
    bar.querySelector('.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
}

function renderRemote() {
  const t = tvs.get(current);
  if (!t) return;
  const caps = t.capabilities ?? {};
  renderSwitcher();
  const bits = [statusWord(t)];
  if (isOn(t) && t.state.app) bits.push(appName(t));
  if (t.state?.volume != null) bits.push(`vol ${t.state.volume}${t.state.muted ? ' (muted)' : ''}`);
  $('#rStatus').textContent = bits.join(' · ');
  $('#rLed').className = `led ${ledClass(t)}`;
  $('#p-remote').classList.toggle('offline', !t.state?.online);
  $('#pairBanner').hidden = t.paired;

  const showMeter = caps.volumeLevel && t.state?.volume != null;
  $('#meter').hidden = !showMeter;
  if (showMeter) {
    $('#meterFill').style.height = `${t.state.muted ? 0 : t.state.volume}%`;
    $('#meterVal').textContent = t.state.muted ? '×' : t.state.volume;
  }

  // Tabs adapt to what this TV can do.
  $('#sayTab').hidden = !caps.toast;
  $('#tabs').classList.toggle('three', !caps.toast);
  if (tab === 'say' && !caps.toast) setTab('remote');
  $('#sourceKey').hidden = t.brand !== 'samsung';
  for (const el of document.querySelectorAll('#apps .app')) el.classList.toggle('current', el.dataset.app === t.state?.app);
  renderLcd(t);
  renderAurora(t);
}

// 8-bit skin: the dot-matrix screen narrates the TV.
let lastKey = '';
function renderLcd(t) {
  if (prefs.skin !== '8bit') return;
  $('#lcd1').textContent = t.name.toUpperCase();
  $('#lcd2').textContent = !t.paired ? 'NOT CONNECTED' : isOn(t) ? (appName(t) || 'ON').toUpperCase() : isStandby(t) ? 'STANDBY' : 'OFF';
  const v = t.state?.volume;
  $('#lcd3').innerHTML = v == null
    ? '<b>VOL</b>--'
    : `<b>VOL</b>${Array.from({ length: 10 }, (_, i) => `<i class="${!t.state.muted && i < Math.round(v / 10) ? '' : 'off'}"></i>`).join('')}`;
  $('#lcd4').textContent = lastKey ? `> ${lastKey}` : '> READY';
}

function lcdKey(key) {
  if (prefs.skin !== '8bit') return;
  lastKey = KEY_LABEL[key] ?? key.toUpperCase();
  $('#lcd4').textContent = `> ${lastKey}`;
  const lcd = $('#lcd');
  lcd.classList.remove('flash');
  void lcd.offsetWidth;
  lcd.classList.add('flash');
}

function setTab(name) {
  tab = name;
  const aurora = prefs.skin === 'aurora';
  for (const b of document.querySelectorAll('#tabs .tab, .sheet-bar [data-tab]')) b.classList.toggle('active', b.dataset.tab === name);
  // Aurora keeps the orb on screen and slides the other panels up over it.
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== name && !(aurora && p.dataset.panel === 'remote');
  $('#scrim').hidden = !(aurora && name !== 'remote');
  $('.panels').scrollTop = 0;
}

async function loadExtras(t) {
  if (!t.state?.online || !t.paired) return;
  try {
    const apps = await api('GET', `/tvs/${t.id}/apps`);
    appCache.set(t.id, apps);
    if (current === t.id) renderApps(t, apps);
  } catch (err) {
    if (current === t.id) $('#apps').innerHTML = `<p class="hint mono">${esc(err.message)}</p>`;
  }
  if (t.capabilities?.inputs) {
    try {
      const inputs = await api('GET', `/tvs/${t.id}/inputs`);
      if (current === t.id) renderInputs(inputs);
    } catch {}
  } else if (current === t.id) {
    $('#inputs').innerHTML = '';
  }
}

function monogram(title) {
  const span = document.createElement('span');
  span.textContent = (title.match(/[A-Za-z0-9+]/) ?? ['•'])[0].toUpperCase();
  return span;
}

function renderApps(t, apps) {
  const shelf = $('#apps');
  if (!apps.length) {
    shelf.innerHTML = '<p class="hint mono">No apps reported by this TV.</p>';
    return;
  }
  shelf.innerHTML = apps
    .map((a) => `<button type="button" class="app" data-press="up" data-app="${esc(a.id)}">
        <span class="app-icon" style="--tint:${tint(a.title)}">${
          t.capabilities?.appIcons && a.icon
            ? `<img alt="" loading="lazy" src="api/tvs/${encodeURIComponent(t.id)}/icon?u=${encodeURIComponent(a.icon)}">`
            : ''
        }</span>
        <span>${esc(a.title)}</span></button>`)
    .join('');
  shelf.querySelectorAll('.app').forEach((btn, i) => {
    const icon = btn.querySelector('.app-icon');
    const img = icon.querySelector('img');
    if (img) img.addEventListener('error', () => img.replaceWith(monogram(apps[i].title)));
    else icon.append(monogram(apps[i].title));
  });
  renderRemote();
}

function renderInputs(inputs) {
  $('#inputs').innerHTML = inputs.length
    ? inputs.map((i) => `<button type="button" class="chip ${i.connected ? '' : 'off'}" data-press="up" data-input="${esc(i.id)}">${esc(i.label)}</button>`).join('')
    : '<p class="hint mono">No inputs reported.</p>';
}


// ── Aurora: the smart strip, edge sliders, smart dock, living fields ──
const latency = [];
function noteLatency(ms) {
  latency.push(ms);
  if (latency.length > 12) latency.shift();
}
const avgLatency = () => (latency.length ? Math.round(latency.reduce((a, b) => a + b, 0) / latency.length) : null);

function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Things worth knowing right now, in priority order. Cycles in the ticker.
function insights(t) {
  const out = [];
  const others = [...tvs.values()].filter((o) => o.id !== t.id && isOn(o));
  const hour = new Date().getHours();
  if (!t.paired) out.push('Not connected yet — tap Connect above');
  else if (!t.state?.online) out.push(t.canWake ? 'Off · tap ⏻ to wake it' : 'Off · turn it on with its own remote once');
  if (t.state?.muted) out.push('Muted · tap the ring to unmute');
  if ((t.state?.volume ?? 0) >= 60) out.push(`Loud · volume ${t.state.volume}`);
  if (isOn(t) && t.since && Date.now() - t.since > 2 * 3600e3) out.push(`On for ${ago(Date.now() - t.since)} · time for a break?`);
  if ((hour >= 22 || hour < 5) && (isOn(t) || others.length)) out.push('Late night · hold ⏻ to turn every TV off');
  if (others.length) out.push(`${others.length} other screen${others.length > 1 ? 's' : ''} on: ${others.map((o) => `${o.name}${appName(o) && appName(o) !== 'On' ? ` (${appName(o)})` : ''}`).join(', ')}`);
  if (t.capabilities?.remote === false) out.push('Google TV: volume, mute and apps work · arrows need Google’s code');
  out.push('Drag the orb like a joystick · flick to swipe · hold OK for a long press');
  return out;
}

let tickerTimer = 0;
let tickerIndex = 0;
function renderAurora(t) {
  if (prefs.skin !== 'aurora') return;
  const on = isOn(t);
  $('#hudKicker span').textContent = `${t.name} · ${brandName(t.brand)}${t.model ? ` ${t.model}` : ''}`;
  $('#hudTitle').textContent = !t.paired ? 'Not connected' : on ? (t.state.app || t.state.appTitle ? appName(t) : 'Home screen') : isStandby(t) ? 'Standby' : 'Off';
  const chips = [];
  if (t.paired && t.since) chips.push(`<span class="${on ? 'hot' : ''}">${on ? 'On' : 'Off'} ${ago(Date.now() - t.since)}</span>`);
  const ms = avgLatency();
  if (ms != null && t.state?.online) chips.push(`<span>${ms < 80 ? '◉' : '◎'} ${ms} ms</span>`);
  if (t.state?.muted) chips.push('<span class="hot">Muted</span>');
  if (t.capabilities?.remote === false) chips.push('<span>Cast</span>');
  $('#hudChips').innerHTML = chips.join('');

  const v = t.state?.volume;
  const vol = $('.hud-vol');
  vol.classList.toggle('muted', Boolean(t.state?.muted));
  $('#hudVol').textContent = v == null ? '±' : t.state.muted ? '×' : v;
  $('#hudVolLabel').textContent = t.state?.muted ? 'muted' : 'vol';
  $('#hudVolArc').setAttribute('stroke-dasharray', `${v == null ? 0 : t.state.muted ? 0 : v} 100`);
  $('#volFill').style.height = `${v == null || t.state.muted ? 0 : v}%`;

  const lines = insights(t);
  const ticker = $('#hudTicker');
  if (!tickerTimer) {
    tickerTimer = setInterval(() => {
      const tv = tvs.get(current);
      if (!tv || prefs.skin !== 'aurora') return;
      const all = insights(tv);
      tickerIndex = (tickerIndex + 1) % all.length;
      ticker.textContent = all[tickerIndex];
      ticker.classList.remove('swap');
      void ticker.offsetWidth;
      ticker.classList.add('swap');
    }, 5000);
  }
  if (!ticker.textContent || !lines.includes(ticker.textContent)) ticker.textContent = lines[0];
  renderDock(t);
  orbMood(t);
}

// Most-used apps per TV, remembered on this phone.
function usage() {
  try {
    return JSON.parse(localStorage.getItem('hearth.usage') || '{}');
  } catch {
    return {};
  }
}
function countUse(tvIdValue, appId) {
  const u = usage();
  u[tvIdValue] ??= {};
  u[tvIdValue][appId] = (u[tvIdValue][appId] ?? 0) + 1;
  try {
    localStorage.setItem('hearth.usage', JSON.stringify(u));
  } catch {}
}

const playing = new Map();
function renderDock(t) {
  const apps = appCache.get(t.id) ?? [];
  const counts = usage()[t.id] ?? {};
  const top = [...apps].sort((a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0)).slice(0, 3);
  const caps = t.capabilities ?? {};
  const html = [
    `<button type="button" class="dock-item ${t.state?.muted ? 'on' : ''}" data-press="down" data-key="mute" aria-label="Mute"><svg><use href="#i-mute"/></svg><small>${t.state?.muted ? 'Unmute' : 'Mute'}</small></button>`,
    caps.remote === false ? '' : `<button type="button" class="dock-item" data-press="down" data-dock="playpause" aria-label="Play or pause"><svg><use href="#i-${playing.get(t.id) === false ? 'play' : 'pause'}"/></svg><small>${playing.get(t.id) === false ? 'Play' : 'Pause'}</small></button>`,
    ...top.map((a) => `<button type="button" class="dock-item app ${a.id === t.state?.app ? 'current' : ''}" data-press="up" data-app="${esc(a.id)}"><i style="--tint:${tint(a.title)}">${
      t.capabilities?.appIcons && a.icon ? `<img alt="" src="api/tvs/${encodeURIComponent(t.id)}/icon?u=${encodeURIComponent(a.icon)}">` : esc((a.title.match(/[A-Za-z0-9+]/) ?? ['•'])[0].toUpperCase())
    }</i><small>${esc(a.title)}</small></button>`),
    `<button type="button" class="dock-item" data-press="up" data-tab="apps" aria-label="All apps"><svg><use href="#i-grid"/></svg><small>Apps</small></button>`,
    caps.inputs || t.brand === 'samsung' || caps.toast ? `<button type="button" class="dock-item" data-press="up" data-tab="${caps.inputs || t.brand === 'samsung' ? 'inputs' : 'say'}" aria-label="More"><svg><use href="#i-dots"/></svg><small>More</small></button>` : '',
  ].join('');
  const dock = $('#smartDock');
  if (dock.innerHTML !== html) dock.innerHTML = html;
}

// Edge sliders: tap the top/bottom half, hold to repeat, or drag to scrub.
function setupSliders() {
  for (const el of document.querySelectorAll('.slider')) {
    const keys = el.dataset.slider === 'vol' ? ['volup', 'voldown'] : ['chup', 'chdown'];
    let s = null;
    const end = () => {
      if (!s) return;
      clearTimeout(s.timer);
      el.classList.remove('active');
      el.querySelectorAll('.hit').forEach((h) => h.classList.remove('hit'));
      s = null;
    };
    const hit = (up) => {
      const h = el.querySelector(up ? '.up' : '.down');
      h.classList.add('hit');
      setTimeout(() => h.classList.remove('hit'), 120);
    };
    el.addEventListener('pointerdown', (e) => {
      end();
      el.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      const up = e.clientY < r.top + r.height / 2;
      s = { y: e.clientY, up, dragging: false, timer: 0, delay: 380 };
      el.classList.add('active');
      sendKey(keys[up ? 0 : 1]);
      hit(up);
      const again = () => {
        if (!s || s.dragging) return;
        sendKey(keys[s.up ? 0 : 1], { repeat: true });
        hit(s.up);
        s.delay = Math.max(70, s.delay * 0.72);
        s.timer = setTimeout(again, s.delay);
      };
      s.timer = setTimeout(again, s.delay);
    });
    el.addEventListener('pointermove', (e) => {
      if (!s) return;
      const dy = e.clientY - s.y;
      if (!s.dragging && Math.abs(dy) < 12) return;
      if (!s.dragging) {
        s.dragging = true;
        clearTimeout(s.timer);
      }
      if (Math.abs(dy) >= 20) {
        const up = dy < 0;
        sendKey(keys[up ? 0 : 1], { repeat: true });
        hit(up);
        s.y = e.clientY;
      }
    });
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
}

// Sheets over the orb get a segmented bar + a scrim to tap away.
function setupSheets() {
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.id = 'scrim';
  scrim.hidden = true;
  scrim.addEventListener('click', () => setTab('remote'));
  $('#remote').append(scrim);
  for (const panel of document.querySelectorAll('.panel:not(.device)')) {
    panel.insertAdjacentHTML('afterbegin', `<div class="sheet-bar">
      <button type="button" data-press="up" data-tab="apps">Apps</button>
      <button type="button" data-press="up" data-tab="inputs">Inputs</button>
      <button type="button" data-press="up" data-tab="say" class="say-tab">Say</button>
      <button type="button" class="close" data-press="up" data-tab="remote" aria-label="Close">✕</button>
    </div>`);
  }
}

// The living fields: one behind the orb, one behind the house.
let orbField = null;
let houseField = null;
function makeField(canvas, stage, opts) {
  const AF = window.AuroraField;
  if (!AF || !window.HearthShapes || !canvas) return null;
  window.HearthShapes.register(AF);
  try {
    return AF.create(canvas, { palette: 'ember', cycle: 0, interactive: false, stage, ...opts });
  } catch {
    return null;
  }
}
function mountOrb() {
  if (prefs.skin !== 'aurora' || orbField) return;
  const small = innerWidth < 500;
  orbField = makeField($('#orbField'), $('#orbStage'), {
    shapes: ['mind', 'hearth-tv', 'hearth-remote', 'hearth-flame'], initial: 'mind', count: small ? 1800 : 3200, stars: 70, depth: 2.4,
    // A halo just outside the orb's ring, so the particles frame the pad.
    radius: (w) => w * 0.66,
  });
  if (orbField) requestAnimationFrame(() => orbField?.resize());
}
function unmountOrb() {
  orbField?.destroy();
  orbField = null;
}
let mood = '';
function orbMood(t) {
  if (!orbField) return;
  const next = !t.paired ? 'hearth-tv' : !t.state?.online ? 'hearth-flame' : 'mind';
  if (next !== mood) {
    mood = next;
    orbField.setShape(next, { pin: true });
    orbField.set({ autonomy: next === 'hearth-flame' ? 0.35 : 1 });
  }
}
function orbPointer(type, x, y) {
  if (!orbField) return;
  const zone = $('.orb-zone').getBoundingClientRect();
  const pad = $('#pad').getBoundingClientRect();
  const canvas = $('#orbField').getBoundingClientRect();
  orbField.pointer(type, x + pad.left - canvas.left, y + pad.top - canvas.top);
  void zone;
}
function mountHouseField() {
  if (prefs.skin !== 'aurora' || houseField || current) return;
  const anyOn = [...tvs.values()].some(isOn);
  houseField = makeField($('#houseField'), $('#houseStage'), {
    shapes: ['hearth-house', 'hearth-flame', 'mind'], initial: anyOn ? 'hearth-house' : 'hearth-flame', count: innerWidth < 500 ? 1600 : 2600, stars: 90,
  });
}
function unmountHouseField() {
  houseField?.destroy();
  houseField = null;
}
function refreshFields() {
  unmountOrb();
  unmountHouseField();
  mood = '';
  if (current) mountOrb();
  else mountHouseField();
}

// ── Commands ─────────────────────────────────────────────
// Keys go through one queue so a fast swipe-swipe-tap arrives in order.
let keyQueue = Promise.resolve();
function sendKey(key, opts = {}) {
  if (!current) return;
  const id = current;
  feedback(opts.repeat ? 'tick' : 'key', key);
  lcdKey(key);
  if ((key === 'volup' || key === 'voldown') && !$('#meter').hidden) {
    const m = $('#meter');
    m.classList.remove('bump');
    void m.offsetWidth;
    m.classList.add('bump');
  }
  const body = { key, ...(opts.hold ? { hold: Math.round(opts.hold) } : {}) };
  keyQueue = keyQueue.then(() => {
    const t0 = performance.now();
    return api('POST', `/tvs/${id}/key`, body).then(() => noteLatency(performance.now() - t0));
  }).catch((err) => {
    feedback('error');
    note(err.message, true);
  });
}

async function power(id, on) {
  const t = tvs.get(id);
  if (isUnknown(t)) on = true; // a toggle: powerOn sends WOL + POWER
  haptic('heavy');
  sound(on ? 'on' : 'off');
  try {
    await api('POST', `/tvs/${id}/power`, { on });
    note(on ? `Waking ${t.name}…` : `${t.name} off`);
  } catch (err) {
    feedback('error');
    note(err.message, true);
  }
}

async function allOff() {
  haptic('heavy');
  sound('off');
  try {
    const res = await api('POST', '/all/power', { on: false });
    const failed = res.results.filter((r) => !r.ok);
    if (failed.length) {
      feedback('error');
      note(`Couldn’t reach: ${failed.map((f) => f.name).join(', ')}`, true);
    } else {
      feedback('success');
      note('Every screen is off. 🌙');
    }
  } catch (err) {
    feedback('error');
    note(err.message, true);
  }
}

async function say(message) {
  try {
    await api('POST', `/tvs/${current}/toast`, { message });
    feedback('success');
    note('Sent to the screen');
  } catch (err) {
    feedback('error');
    note(err.message, true);
  }
}

// ── Sheets ───────────────────────────────────────────────
function openSheet(id) {
  const dlg = $(id);
  if (!dlg.open) dlg.showModal();
  return dlg;
}

function openEdit(id = current) {
  const t = tvs.get(id);
  if (!t) return;
  editing = id;
  $('#editName').value = t.name;
  $('#editRoom').value = t.room;
  $('#editMeta').textContent = [brandName(t.brand), t.model, t.ip].filter(Boolean).join(' · ');
  openSheet('#editSheet');
}

function openSettings() {
  for (const card of document.querySelectorAll('[data-skin-pick]')) card.classList.toggle('active', card.dataset.skinPick === prefs.skin);
  $('#prefHaptics').checked = prefs.haptics;
  $('#prefSound').checked = soundOn();
  openSheet('#settingsSheet');
}

// ── Setup wizard ─────────────────────────────────────────
const setup = createSetup({
  root: $('#setup'),
  api,
  note,
  onTv: (tv) => {
    tvs.set(tv.id, tv);
    render();
  },
  onClose: () => render(),
});

// ── Routing ──────────────────────────────────────────────
function route() {
  const m = location.hash.match(/^#\/tv\/([\w-]+)/);
  const t = m && tvs.get(m[1]);
  if (t) {
    const changed = current !== t.id;
    current = t.id;
    $('#house').hidden = true;
    $('#remote').hidden = false;
    if (changed) {
      lastKey = '';
      $('#apps').innerHTML = '<p class="hint mono">Turn the TV on to see its apps.</p>';
      $('#inputs').innerHTML = '';
      const cached = appCache.get(t.id);
      if (cached) renderApps(t, cached);
      loadExtras(t);
      if (prefs.skin === '8bit') {
        const lcd = $('#lcd');
        lcd.classList.remove('boot');
        void lcd.offsetWidth;
        lcd.classList.add('boot');
        if (soundOn()) setTimeout(() => sound('success'), 900);
      }
    }
    renderRemote();
    keepAwake(true);
    unmountHouseField();
    mountOrb();
  } else {
    current = null;
    $('#remote').hidden = true;
    $('#house').hidden = false;
    keepAwake(false);
    unmountOrb();
    mountHouseField();
    renderHouse();
  }
}

function render() {
  if (current) renderRemote();
  else renderHouse();
}

// ── Live updates ─────────────────────────────────────────
function connectEvents() {
  const es = demo ? demo.events() : new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    tvs.clear();
    for (const t of JSON.parse(e.data)) tvs.set(t.id, t);
    route();
    // First visit with no TVs: go straight into setup.
    if (!greeted && !tvs.size && !setup.isOpen) setup.open();
    greeted = true;
  });
  es.addEventListener('tv', (e) => {
    const t = JSON.parse(e.data);
    const wasOnline = tvs.get(t.id)?.state?.online;
    tvs.set(t.id, t);
    if (t.id === current && t.state?.online && !wasOnline) loadExtras(t);
    if (location.hash.includes(t.id) && !current) route();
    else render();
  });
  es.addEventListener('removed', (e) => {
    const { id } = JSON.parse(e.data);
    tvs.delete(id);
    if (current === id) location.hash = '#/';
    else render();
  });
  es.addEventListener('nearby', (e) => {
    const was = nearby.length;
    nearby = JSON.parse(e.data);
    if (nearby.length > was && greeted) haptic('hold');
    if (!current) renderHouse();
  });
}

function tickClock() {
  $('#clock').textContent = new Date().toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// ── Every press in the app ───────────────────────────────
function onPress(el, info) {
  const d = el.dataset;
  if (d.setup) return setup.handle(el, info);
  if (d.key) return sendKey(d.key, { ...(info.long ? { hold: info.held } : {}), repeat: info.repeat });
  if (d.quick) {
    const t = tvs.get(d.quick);
    return power(t.id, !isOn(t));
  }
  if (d.open) {
    const t = tvs.get(d.open);
    if (info.long) return openEdit(t.id);
    haptic('tap');
    if (!t.paired) return setup.open({ tvId: t.id, candidate: t });
    location.hash = `#/tv/${t.id}`;
    return;
  }
  if (d.switch) {
    haptic('tap');
    location.hash = `#/tv/${d.switch}`;
    return;
  }
  if (d.dock === 'playpause') {
    const t = tvs.get(current);
    playing.set(current, !(playing.get(current) ?? true));
    return sendKey(playing.get(current) ? 'play' : 'pause');
  }
  if (d.tab) {
    haptic('tick');
    return setTab(d.tab);
  }
  if (d.app) {
    countUse(current, d.app);
    feedback('key', 'ok');
    return api('POST', `/tvs/${current}/launch`, { id: d.app }).catch((err) => note(err.message, true));
  }
  if (d.input) {
    feedback('key', 'ok');
    return api('POST', `/tvs/${current}/input`, { id: d.input }).catch((err) => note(err.message, true));
  }
  if (d.msg) return say(d.msg);
  if (d.skinPick) {
    savePrefs({ skin: d.skinPick });
    refreshFields();
    feedback('success');
    openSettings();
    render();
    return;
  }
  if (el.hasAttribute('data-close')) return el.closest('dialog')?.close();

  switch (d.action) {
    case 'setup':
      haptic('tap');
      return setup.open();
    case 'nearby':
      haptic('tap');
      return nearby.length === 1 ? setup.open({ candidate: nearby[0] }) : setup.open();
    case 'settings':
      haptic('tap');
      return openSettings();
    case 'edit':
      haptic('tap');
      return openEdit();
    case 'pair':
      return setup.open({ tvId: current, candidate: tvs.get(current) });
    case 'power': {
      // Tap: this TV on/off. Hold: every TV in the house off.
      if (info.long) return allOff();
      const t = tvs.get(current);
      return power(t.id, !isOn(t));
    }
    case 'all-off':
      return allOff();
    case 'forget':
      return forget();
    case 'test-feel':
      feedback('success');
      return note(navigator.vibrate ? 'Bzzt! That’s the feel.' : 'On iPhone, haptics need iOS 18 and Safari.');
  }
}

async function forget() {
  try {
    await api('DELETE', `/tvs/${editing}`);
    feedback('success');
    $('#editSheet').close();
    tvs.delete(editing);
    if (current === editing) location.hash = '#/';
    else render();
  } catch (err) {
    note(err.message, true);
  }
}

const KEYBOARD = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Enter: 'ok', Backspace: 'back', Escape: 'back', h: 'home', '+': 'volup', '=': 'volup', '-': 'voldown', m: 'mute',
};

function wire() {
  pressable(document, onPress);
  setupSliders();
  setupSheets();
  gesturePad($('#pad'), {
    send: (key, opts) => sendKey(key, opts),
    onPointer: orbPointer,
    flash: (zone, hold) => {
      const el = $(`#pad [data-key="${zone}"]`);
      el?.classList.add('pressed');
      if (!hold) setTimeout(() => el?.classList.remove('pressed'), 130);
    },
  });

  document.addEventListener('confirm-short', (e) => {
    haptic('tick');
    const forgetting = e.target.closest('[data-action="forget"]');
    note(forgetting ? 'Keep holding to forget this TV' : 'Keep holding to turn every TV off');
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, dialog, #setup')) return;
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('button, [role="button"]')) {
      if (e.target.matches('.unit')) e.target.click();
      return;
    }
    if (!current || e.metaKey || e.ctrlKey) return;
    const key = KEYBOARD[e.key];
    if (key) {
      e.preventDefault();
      sendKey(key);
    }
  });
  // .unit is an <article role=button>; make keyboard "click" open it.
  document.addEventListener('click', (e) => {
    const unit = e.target.closest('.unit');
    if (unit && e.detail === 0 && !e.target.closest('.quick')) onPress(unit, { long: false, held: 0 });
  });

  $('#prefHaptics').addEventListener('change', (e) => {
    savePrefs({ haptics: e.target.checked });
    haptic('press');
  });
  $('#prefSound').addEventListener('change', (e) => {
    savePrefs({ sound: e.target.checked });
    sound('success');
  });

  $('#sayForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = $('#sayInput').value.trim();
    if (msg) say(msg).then(() => ($('#sayInput').value = ''));
  });

  $('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const tv = await api('PATCH', `/tvs/${editing}`, { name: $('#editName').value, room: $('#editRoom').value });
      tvs.set(tv.id, tv);
      feedback('success');
      $('#editSheet').close();
      render();
    } catch (err) {
      note(err.message, true);
    }
  });

  // Tapping the dimmed backdrop closes a sheet.
  for (const dlg of document.querySelectorAll('dialog')) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current) keepAwake(true);
  });
  window.addEventListener('hashchange', route);
}

wire();
tickClock();
setInterval(tickClock, 30_000);
connectEvents();
