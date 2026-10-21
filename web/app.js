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
const isStandby = (t) => t.state?.online && /standby|screen_off|screen_saver/.test(t.state.power);
const ledClass = (t) => (!t.paired ? 'unpaired' : isOn(t) ? 'on' : isStandby(t) ? 'standby' : 'off');
const statusWord = (t) => (!t.paired ? 'Tap to connect' : isOn(t) ? 'On' : isStandby(t) ? 'Standby' : 'Off');
const brandName = (b) => (b === 'lg' ? 'LG' : 'Samsung');

function appName(t) {
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
        ${t.paired ? `<button type="button" class="quick" data-press="down" data-quick="${esc(t.id)}" aria-label="Power ${esc(t.name)}"><svg><use href="#i-power"/></svg></button>` : ''}
        <div class="unit-meta">
          <h3 class="unit-name">${esc(t.name)}</h3>
          <p class="unit-sub mono">${esc([t.room !== t.name ? t.room : '', brandName(t.brand), t.model].filter(Boolean).join(' · '))}</p>
          <span class="unit-state mono"><span class="led"></span>${esc(statusWord(t))}</span>
        </div>
        ${t.paired ? '' : '<span class="unit-pair mono">Tap to connect</span>'}
      </article>`)
    .join('');
  if (list.length) firstPaint = false;
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
  for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== name;
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
  keyQueue = keyQueue.then(() => api('POST', `/tvs/${id}/key`, body)).catch((err) => {
    feedback('error');
    note(err.message, true);
  });
}

async function power(id, on) {
  const t = tvs.get(id);
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
  } else {
    current = null;
    $('#remote').hidden = true;
    $('#house').hidden = false;
    keepAwake(false);
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
  if (d.tab) {
    haptic('tick');
    return setTab(d.tab);
  }
  if (d.app) {
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
  gesturePad($('#pad'), {
    send: (key, opts) => sendKey(key, opts),
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
