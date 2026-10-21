// Hearth web app. No framework, no build step: state lives in `tvs`, the
// server pushes changes over /api/events, and render() repaints.
const $ = (sel, el = document) => el.querySelector(sel);
const tvs = new Map();
const appCache = new Map();
let current = null;
let firstPaint = true;

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

// ── Helpers ──────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const haptic = () => navigator.vibrate?.(8);

async function api(method, path, body) {
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
const statusWord = (t) => (!t.paired ? 'Tap to pair' : isOn(t) ? 'On' : isStandby(t) ? 'Standby' : 'Off');

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
  $('#allOff').hidden = list.length === 0;
  $('#heroLine').textContent =
    list.length === 0 ? 'One remote for the whole house.'
    : on === 0 ? 'All quiet. Every screen is off.'
    : on === list.length ? `All ${on} screen${on === 1 ? ' is' : 's are'} on.`
    : `${on} of ${list.length} screens are on.`;
  $('#onCount').textContent = `${on} on · ${list.length} total`;

  const units = $('#units');
  units.classList.toggle('settled', !firstPaint);
  units.innerHTML =
    list
      .map((t, i) => {
        const cls = ledClass(t);
        return `
      <article class="unit ${cls}" style="--i:${i}" data-open="${esc(t.id)}" tabindex="0" role="button" aria-label="${esc(t.name)}, ${esc(statusWord(t))}">
        <div class="screen"><div class="scan"></div><span class="now">${esc(appName(t))}</span></div>
        ${t.paired ? `<button type="button" class="quick" data-quick="${esc(t.id)}" aria-label="Power ${esc(t.name)}"><svg><use href="#i-power"/></svg></button>` : ''}
        <div class="unit-meta">
          <h3 class="unit-name">${esc(t.name)}</h3>
          <p class="unit-sub mono">${esc([t.room, t.brand === 'lg' ? 'LG' : 'Samsung', t.model].filter(Boolean).join(' · '))}</p>
          <span class="unit-state mono"><span class="led"></span>${esc(statusWord(t))}</span>
        </div>
        ${t.paired ? '' : '<span class="unit-pair mono">Pair this TV</span>'}
      </article>`;
      })
      .join('') +
    `<button type="button" class="unit add-unit" style="--i:${list.length}" data-action="scan">
        <span class="plus"><svg><use href="#i-plus"/></svg></span><span>Add a TV</span>
     </button>`;
  if (list.length) firstPaint = false;
}

// ── Remote view ──────────────────────────────────────────
function renderRemote() {
  const t = tvs.get(current);
  if (!t) return;
  const caps = t.capabilities ?? {};
  $('#rName').textContent = t.name;
  const bits = [statusWord(t)];
  if (isOn(t) && t.state.app) bits.push(appName(t));
  if (t.state?.volume != null) bits.push(`vol ${t.state.volume}${t.state.muted ? ' (muted)' : ''}`);
  $('#rStatus').textContent = bits.join(' · ');
  $('#rBrand').textContent = t.brand === 'lg' ? `LG ${t.model || ''}`.trim() : `Samsung ${t.model || ''}`.trim();
  $('#rLed').className = `led ${ledClass(t)}`;
  $('#device').classList.toggle('offline', !t.state?.online);
  $('#pairBanner').hidden = t.paired;

  const showMeter = caps.volumeLevel && t.state?.volume != null;
  $('#meter').hidden = !showMeter;
  if (showMeter) {
    $('#meterFill').style.height = `${t.state.muted ? 0 : t.state.volume}%`;
    $('#meterVal').textContent = t.state.muted ? '×' : t.state.volume;
  }
  $('#inputsDrawer').hidden = !caps.inputs;
  $('#sourceDrawer').hidden = t.brand !== 'samsung';
  $('#msgDrawer').hidden = !caps.toast;
  for (const el of document.querySelectorAll('#apps .app')) el.classList.toggle('current', el.dataset.app === t.state?.app);
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
    .map(
      (a) => `<button type="button" class="app" data-app="${esc(a.id)}">
        <span class="app-icon" style="--tint:${tint(a.title)}">${
          t.capabilities?.appIcons && a.icon
            ? `<img alt="" loading="lazy" src="/api/tvs/${encodeURIComponent(t.id)}/icon?u=${encodeURIComponent(a.icon)}">`
            : ''
        }</span>
        <span>${esc(a.title)}</span></button>`,
    )
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
    ? inputs
        .map((i) => `<button type="button" class="chip ${i.connected ? '' : 'off'}" data-input="${esc(i.id)}">${esc(i.label)}</button>`)
        .join('')
    : '<p class="hint mono">No inputs reported.</p>';
}

// ── Commands ─────────────────────────────────────────────
// Keys go through one queue so a fast swipe-swipe-tap arrives in order.
let keyQueue = Promise.resolve();
function sendKey(key) {
  if (!current) return;
  haptic();
  const id = current;
  keyQueue = keyQueue.then(() => api('POST', `/tvs/${id}/key`, { key })).catch((err) => note(err.message, true));
}

async function power(id, on) {
  haptic();
  const t = tvs.get(id);
  try {
    await api('POST', `/tvs/${id}/power`, { on });
    note(on ? `Waking ${t.name}…` : `${t.name} off`);
  } catch (err) {
    note(err.message, true);
  }
}

function flash(el) {
  el.classList.add('pressed');
  setTimeout(() => el.classList.remove('pressed'), 140);
}

// Direction pad: tap a zone, or swipe anywhere on it like a touchpad.
function setupPad() {
  const pad = $('#pad');
  let start = null;
  pad.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY };
    pad.setPointerCapture(e.pointerId);
  });
  pad.addEventListener('pointerup', (e) => {
    if (!start) return;
    const rect = pad.getBoundingClientRect();
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    let key;
    if (Math.hypot(dx, dy) > 28) {
      key = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    } else {
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      const r = Math.hypot(cx, cy) / (rect.width / 2);
      key = r < 0.38 ? 'ok' : Math.abs(cx) > Math.abs(cy) ? (cx > 0 ? 'right' : 'left') : cy > 0 ? 'down' : 'up';
    }
    start = null;
    sendKey(key);
    flash(pad.querySelector(`[data-key="${key}"]`));
    const ripple = document.createElement('span');
    const size = rect.width * 0.4;
    ripple.className = 'ripple';
    Object.assign(ripple.style, {
      width: `${size}px`,
      height: `${size}px`,
      left: `${e.clientX - rect.left - size / 2}px`,
      top: `${e.clientY - rect.top - size / 2}px`,
    });
    pad.append(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
  pad.addEventListener('pointercancel', () => (start = null));
}

// Every other [data-key] button fires on press (snappier than click);
// [data-repeat] buttons auto-repeat while held, like a real volume rocker.
function setupKeys() {
  let repeatTimer;
  const stopRepeat = () => clearTimeout(repeatTimer);
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('[data-key]');
    if (!btn || btn.closest('#pad')) return;
    btn.classList.add('pressed');
    sendKey(btn.dataset.key);
    if (btn.hasAttribute('data-repeat')) {
      const tick = (delay) => (repeatTimer = setTimeout(() => (sendKey(btn.dataset.key), tick(140)), delay));
      tick(450);
    }
  });
  for (const type of ['pointerup', 'pointercancel']) {
    document.addEventListener(type, () => {
      stopRepeat();
      document.querySelectorAll('[data-key].pressed').forEach((b) => b.classList.remove('pressed'));
    }, true);
  }
  // Keyboard activation (Enter/Space on a focused button) arrives as a click with detail 0.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-key]');
    if (btn && e.detail === 0) sendKey(btn.dataset.key);
  });
}

const KEYBOARD = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Enter: 'ok', Backspace: 'back', Escape: 'back', h: 'home', '+': 'volup', '=': 'volup', '-': 'voldown', m: 'mute',
};

// ── Sheets ───────────────────────────────────────────────
function openSheet(id) {
  const dlg = $(id);
  if (!dlg.open) dlg.showModal();
  return dlg;
}

async function runScan() {
  const radar = $('#radar');
  radar.className = 'radar';
  $('#scanTitle').textContent = 'Listening for TVs…';
  $('#scanSub').textContent = 'This takes a few seconds.';
  $('#found').innerHTML = '';
  $('#rescan').disabled = true;
  try {
    const found = await api('POST', '/scan');
    radar.classList.add('done');
    if (found.length) radar.classList.add('hit');
    $('#scanTitle').textContent = found.length ? `Found ${found.length} TV${found.length === 1 ? '' : 's'}` : 'No TVs answered';
    $('#scanSub').textContent = found.length
      ? 'Add the ones you want to control.'
      : 'Make sure they’re switched on (not in standby) and on the same Wi-Fi. Or add one by IP below.';
    if (!found.length) $('#scanSheet .manual').open = true;
    $('#found').innerHTML = found
      .map(
        (tv, i) => `<li style="--i:${i}">
          <strong>${esc(tv.name)}</strong>
          <small class="mono">${esc([tv.brand === 'lg' ? 'LG' : 'Samsung', tv.model, tv.ip].filter(Boolean).join(' · '))}</small>
          ${tv.added ? '<span class="added mono">Added</span>' : `<button type="button" class="cta small" data-add='${esc(JSON.stringify(tv))}'>Add</button>`}
        </li>`,
      )
      .join('');
  } catch (err) {
    radar.classList.add('done');
    $('#scanTitle').textContent = 'Scan failed';
    $('#scanSub').textContent = err.message;
  } finally {
    $('#rescan').disabled = false;
  }
}

async function addTv(payload) {
  try {
    const tv = await api('POST', '/tvs', payload);
    tvs.set(tv.id, tv);
    renderHouse();
    $('#scanSheet').close();
    if (tv.paired) location.hash = `#/tv/${tv.id}`;
    else pairTv(tv.id);
  } catch (err) {
    note(err.message, true);
  }
}

let pairing = null;
async function pairTv(id) {
  const sheet = openSheet('#pairSheet');
  sheet.classList.remove('success');
  const t = tvs.get(id);
  $('#pairTitle').textContent = 'Look at your TV.';
  $('#pairSub').innerHTML = `A box will pop up on <b>${esc(t?.name ?? 'the TV')}</b> asking to connect. Use the TV’s own remote to press <b>Allow</b> (or <b>Yes</b>). You only do this once.`;
  $('#pairRetry').hidden = true;
  pairing = id;
  try {
    const tv = await api('POST', `/tvs/${id}/pair`);
    tvs.set(tv.id, tv);
    if (pairing !== id) return;
    sheet.classList.add('success');
    $('#pairTitle').textContent = 'Paired. 🎉';
    $('#pairSub').textContent = 'This TV is now on your Hearth remote.';
    setTimeout(() => {
      sheet.close();
      location.hash = `#/tv/${id}`;
    }, 1100);
  } catch (err) {
    if (pairing !== id) return;
    $('#pairTitle').textContent = 'That didn’t work.';
    $('#pairSub').textContent = `${err.message}. Make sure the TV is on, then try again.`;
    $('#pairRetry').hidden = false;
  }
}

function openEdit() {
  const t = tvs.get(current);
  if (!t) return;
  $('#editName').value = t.name;
  $('#editRoom').value = t.room;
  $('#editMeta').textContent = [t.brand === 'lg' ? 'LG' : 'Samsung', t.model, t.ip].filter(Boolean).join(' · ');
  $('#editRemove').textContent = 'Forget this TV';
  $('#editRemove').dataset.armed = '';
  openSheet('#editSheet');
}

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
      $('#apps').innerHTML = '<p class="hint mono">Turn the TV on to see its apps.</p>';
      $('#inputs').innerHTML = '';
      const cached = appCache.get(t.id);
      if (cached) renderApps(t, cached);
      loadExtras(t);
      window.scrollTo(0, 0);
    }
    renderRemote();
  } else {
    current = null;
    $('#remote').hidden = true;
    $('#house').hidden = false;
    renderHouse();
  }
}

function render() {
  if (current) renderRemote();
  else renderHouse();
}

// ── Live updates ─────────────────────────────────────────
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    tvs.clear();
    for (const t of JSON.parse(e.data)) tvs.set(t.id, t);
    route();
  });
  es.addEventListener('tv', (e) => {
    const t = JSON.parse(e.data);
    const wasOnline = tvs.get(t.id)?.state?.online;
    tvs.set(t.id, t);
    if (t.id === current && t.state?.online && !wasOnline) loadExtras(t);
    render();
  });
  es.addEventListener('removed', (e) => {
    const { id } = JSON.parse(e.data);
    tvs.delete(id);
    if (current === id) location.hash = '#/';
    else render();
  });
}

function tickClock() {
  const now = new Date();
  $('#clock').textContent = now.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// ── Wiring ───────────────────────────────────────────────
function wire() {
  setupPad();
  setupKeys();

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action], [data-open], [data-quick], [data-app], [data-input], [data-msg], [data-add], [data-close]');
    if (!el) return;
    if (el.dataset.quick) {
      e.stopPropagation();
      const t = tvs.get(el.dataset.quick);
      return power(t.id, !isOn(t));
    }
    if (el.dataset.action === 'scan') {
      openSheet('#scanSheet');
      return runScan();
    }
    if (el.dataset.open) {
      const t = tvs.get(el.dataset.open);
      return t.paired ? (location.hash = `#/tv/${t.id}`) : pairTv(t.id);
    }
    if (el.dataset.app) {
      haptic();
      return api('POST', `/tvs/${current}/launch`, { id: el.dataset.app }).catch((err) => note(err.message, true));
    }
    if (el.dataset.input) {
      haptic();
      return api('POST', `/tvs/${current}/input`, { id: el.dataset.input }).catch((err) => note(err.message, true));
    }
    if (el.dataset.msg) return say(el.dataset.msg);
    if (el.dataset.add) return addTv(JSON.parse(el.dataset.add));
    if (el.hasAttribute('data-close')) {
      pairing = null;
      return el.closest('dialog').close();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, dialog')) return;
    // Let Enter/Space activate whichever button has focus.
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('button')) return;
    if (e.key === 'Enter' && document.activeElement?.matches('.unit[data-open]')) return document.activeElement.click();
    if (!current || e.metaKey || e.ctrlKey) return;
    const key = KEYBOARD[e.key];
    if (key) {
      e.preventDefault();
      sendKey(key);
    }
  });

  $('#rPower').addEventListener('click', () => {
    const t = tvs.get(current);
    flash($('#rPower'));
    power(t.id, !isOn(t));
  });

  $('#allOff').addEventListener('click', async () => {
    const btn = $('#allOff');
    btn.classList.add('busy');
    haptic();
    try {
      const res = await api('POST', '/all/power', { on: false });
      const failed = res.results.filter((r) => !r.ok);
      note(failed.length ? `Couldn’t reach: ${failed.map((f) => f.name).join(', ')}` : 'Every screen is off. 🌙', failed.length > 0);
    } catch (err) {
      note(err.message, true);
    } finally {
      btn.classList.remove('busy');
    }
  });

  $('#rescan').addEventListener('click', runScan);
  $('#pairRetry').addEventListener('click', () => pairing && pairTv(pairing));
  $('#rEdit').addEventListener('click', openEdit);
  $('#pairNow').addEventListener('click', () => pairTv(current));

  $('#manualForm').addEventListener('submit', (e) => {
    e.preventDefault();
    addTv({ ip: $('#manualIp').value.trim() });
  });

  $('#sayForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = $('#sayInput').value.trim();
    if (msg) say(msg).then(() => ($('#sayInput').value = ''));
  });

  $('#editForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const tv = await api('PATCH', `/tvs/${current}`, { name: $('#editName').value, room: $('#editRoom').value });
      tvs.set(tv.id, tv);
      $('#editSheet').close();
      render();
    } catch (err) {
      note(err.message, true);
    }
  });

  $('#editRemove').addEventListener('click', async () => {
    const btn = $('#editRemove');
    if (!btn.dataset.armed) {
      btn.dataset.armed = '1';
      btn.textContent = 'Tap again to forget it';
      return;
    }
    try {
      await api('DELETE', `/tvs/${current}`);
      $('#editSheet').close();
      tvs.delete(current);
      location.hash = '#/';
    } catch (err) {
      note(err.message, true);
    }
  });

  // Tapping the dimmed backdrop closes a sheet.
  for (const dlg of document.querySelectorAll('dialog')) {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) {
        if (dlg.id === 'pairSheet') pairing = null;
        dlg.close();
      }
    });
  }

  window.addEventListener('hashchange', route);
}

async function say(message) {
  haptic();
  try {
    await api('POST', `/tvs/${current}/toast`, { message });
    note('Sent to the screen');
  } catch (err) {
    note(err.message, true);
  }
}

wire();
tickClock();
setInterval(tickClock, 30_000);
connectEvents();
