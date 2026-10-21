// Bulk select: long-press a TV (or tap Select) and act on many at once.
// The action bar replaces the dock in the thumb zone; every TV reports back
// with its own ✓ / ✕ chip.
import { feedback, haptic } from './feel.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const QUICK_MSGS = ['Dinner’s ready! 🍽️', 'Screens off in 10 minutes ⏰', 'Bedtime 🌙', 'Homework first 📚'];

export function createBulk({ api, getTvs, render, note, openEdit, saveAsScene }) {
  const bar = document.querySelector('#bulkbar');
  const sheet = document.querySelector('#bulkSheet');
  const selected = new Set();
  let selecting = false;
  let results = [];
  let resultsTimer = 0;
  let last = null; // { action, args } — "Save as scene" starts from it

  const tvs = () => getTvs();
  const chosen = () => tvs().filter((t) => selected.has(t.id));

  function sync() {
    document.body.classList.toggle('selecting', selecting);
    bar.hidden = !selecting;
    renderBar();
    render();
  }

  function renderBar() {
    if (!selecting) return;
    const list = chosen();
    const n = list.length;
    const any = n > 0;
    const canSay = list.some((t) => t.capabilities?.toast);
    const btn = (action, icon, label, extra = '') =>
      `<button type="button" class="bulk-act" data-press="up" data-bulk="${action}" ${any ? '' : 'disabled'} ${extra}><span>${icon}</span><small>${label}</small></button>`;
    bar.innerHTML = `
      <div class="bulk-head">
        <b>${n ? `${n} selected` : 'Tap TVs to select'}</b>
        <button type="button" class="bulk-pill" data-press="up" data-bulk="all">All</button>
        <button type="button" class="bulk-pill" data-press="up" data-bulk="none">None</button>
        <button type="button" class="bulk-pill done" data-press="up" data-bulk="exit">Done</button>
      </div>
      ${results.length ? `<div class="bulk-results">${results.map((r) => `<span class="chip-result ${r.ok ? 'ok' : 'bad'}" title="${esc(r.error ?? '')}">${r.ok ? '✓' : '✕'} ${esc(r.name)}${r.ok ? '' : ` · ${esc(r.error)}`}</span>`).join('')}</div>` : ''}
      <div class="bulk-actions">
        ${btn('on', '⏻', 'On')}
        ${btn('off', '⏼', 'Off')}
        ${btn('mute', '🔇', 'Mute')}
        ${btn('unmute', '🔈', 'Unmute')}
        ${btn('volume', '🎚️', 'Volume')}
        ${btn('app', '▦', 'Open app')}
        ${canSay ? btn('say', '💬', 'Say') : ''}
        ${btn('room', '🏷️', n === 1 ? 'Rename' : 'Room')}
        ${n === 1 ? btn('settings', '⚙️', 'Settings') : ''}
        ${btn('scene', '✨', 'Save scene')}
        <button type="button" class="bulk-act danger hold" data-press="confirm" data-bulk="forget" ${any ? '' : 'disabled'}><span class="charge" aria-hidden="true"></span><span>🗑️</span><small>Hold: forget</small></button>
      </div>`;
  }

  async function run(action, args = {}, label) {
    const ids = [...selected];
    if (!ids.length) return;
    haptic('press');
    try {
      const res = await api('POST', '/bulk', { ids, action, args });
      results = res.results;
      last = { action, args };
      const bad = results.filter((r) => !r.ok).length;
      feedback(bad === results.length ? 'error' : 'success');
      note(bad ? `${label}: ${results.length - bad} of ${results.length} worked` : `${label} ✓`, bad === results.length);
      if (action === 'forget') for (const r of results) if (r.ok) selected.delete(r.id);
    } catch (err) {
      feedback('error');
      note(err.message, true);
    }
    clearTimeout(resultsTimer);
    resultsTimer = setTimeout(() => {
      results = [];
      renderBar();
    }, 7000);
    renderBar();
    render();
  }

  // Pickers live in one bottom sheet; the content depends on the action.
  function openSheet(html, onSubmit) {
    sheet.innerHTML = `<div class="sheet-grip"></div>${html}`;
    if (!sheet.open) sheet.showModal();
    sheet.querySelector('form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      onSubmit?.(new FormData(e.target), e.submitter);
      sheet.close();
    });
  }

  function volumePicker() {
    const levels = chosen().filter((t) => t.capabilities?.volumeLevel);
    const start = levels.length ? Math.round(levels.reduce((a, t) => a + (t.state?.volume ?? 15), 0) / levels.length) : 15;
    openSheet(
      `<h3>Volume</h3>
       <p class="sub">${levels.length ? 'TVs that know their level jump straight to it; the rest step there.' : 'These TVs only do up/down, so we’ll step them.'}</p>
       <form class="fields">
         <label class="vol-pick"><output id="bulkVolOut">${start}</output><input type="range" name="level" min="0" max="60" value="${start}" oninput="this.form.querySelector('output').value=this.value"></label>
         <div class="sheet-actions">
           <button type="submit" class="ghost" name="nudge" value="-5">− 5</button>
           <button type="submit" class="ghost" name="nudge" value="5">+ 5</button>
           <button type="submit" class="cta small" name="set" value="1">Set</button>
         </div>
       </form>`,
      (data, submitter) => {
        if (submitter?.name === 'nudge') run('volume', { delta: Number(submitter.value) }, 'Volume');
        else run('volume', { level: Number(data.get('level')) }, 'Volume');
      },
    );
  }

  async function appPicker() {
    const list = chosen();
    openSheet('<h3>Open an app</h3><p class="sub">Finding apps every selected TV has…</p>');
    const perTv = await Promise.all(list.map((t) => api('GET', `/tvs/${t.id}/apps`).catch(() => [])));
    // Apps in common, matched by name (each TV launches its own id).
    const names = perTv.map((apps) => new Map(apps.map((a) => [a.title.toLowerCase(), a.title])));
    const common = [...(names[0]?.values() ?? [])].filter((title) => names.every((m) => m.has(title.toLowerCase())));
    openSheet(
      `<h3>Open an app</h3>
       <p class="sub">${common.length ? `On all ${list.length} TV${list.length > 1 ? 's' : ''}:` : 'No app is on every selected TV (or they’re off). Type one:'}</p>
       <form class="fields">
         <div class="chips big">${common.map((t) => `<button type="submit" class="chip" name="title" value="${esc(t)}">${esc(t)}</button>`).join('')}</div>
         ${common.length ? '' : '<input name="typed" placeholder="Netflix" autocomplete="off"><button type="submit" class="cta small">Open</button>'}
       </form>`,
      (data, submitter) => {
        const title = submitter?.value || data.get('typed');
        if (title) run('launch', { title }, `Open ${title}`);
      },
    );
  }

  function sayPicker() {
    openSheet(
      `<h3>Say on screen</h3>
       <p class="sub">Shows on the TVs that support messages.</p>
       <form class="fields">
         <div class="chips big">${QUICK_MSGS.map((m) => `<button type="submit" class="chip" name="msg" value="${esc(m)}">${esc(m)}</button>`).join('')}</div>
         <input name="typed" maxlength="120" placeholder="Type a message…" autocomplete="off">
         <button type="submit" class="cta small">Send</button>
       </form>`,
      (data, submitter) => {
        const message = (submitter?.name === 'msg' ? submitter.value : '') || String(data.get('typed') ?? '').trim();
        if (message) run('say', { message }, 'Message');
      },
    );
  }

  function roomPicker() {
    const list = chosen();
    const one = list.length === 1 ? list[0] : null;
    openSheet(
      `<h3>${one ? 'Rename' : 'Set the room'}</h3>
       <form class="fields">
         ${one ? `<label><span class="mono">Name</span><input name="name" maxlength="60" value="${esc(one.name)}"></label>` : ''}
         <label><span class="mono">Room</span><input name="room" maxlength="60" value="${esc(one?.room ?? '')}" placeholder="Upstairs, Kids’ wing…"></label>
         <div class="sheet-actions"><span></span><button type="submit" class="cta small">Save</button></div>
       </form>`,
      (data) => run('room', { ...(one ? { name: String(data.get('name')) } : {}), room: String(data.get('room') ?? '') }, one ? 'Renamed' : 'Room set'),
    );
  }

  return {
    get selecting() {
      return selecting;
    },
    isSelected: (id) => selected.has(id),
    enter(id) {
      selecting = true;
      if (id) selected.add(id);
      results = [];
      haptic('press');
      sync();
    },
    exit() {
      selecting = false;
      selected.clear();
      results = [];
      sync();
    },
    toggle(id) {
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
      haptic('tick');
      sync();
    },
    // TVs disappear (forgotten elsewhere): drop them from the selection.
    prune() {
      const known = new Set(tvs().map((t) => t.id));
      for (const id of [...selected]) if (!known.has(id)) selected.delete(id);
      if (selecting) renderBar();
    },
    handle(el) {
      const what = el.dataset.bulk;
      if (what === 'all') {
        for (const t of tvs()) selected.add(t.id);
        haptic('tick');
        return sync();
      }
      if (what === 'none') {
        selected.clear();
        return sync();
      }
      if (what === 'exit') return this.exit();
      if (!selected.size) return note('Tap a TV first', true);
      switch (what) {
        case 'on': return run('power', { on: true }, 'Turn on');
        case 'off': return run('power', { on: false }, 'Turn off');
        case 'mute': return run('mute', { on: true }, 'Mute');
        case 'unmute': return run('mute', { on: false }, 'Unmute');
        case 'volume': return volumePicker();
        case 'app': return appPicker();
        case 'say': return sayPicker();
        case 'room': return roomPicker();
        case 'settings': return openEdit([...selected][0]);
        case 'forget': return run('forget', {}, 'Forgot');
        case 'scene': {
          const step = last ?? { action: 'power', args: { on: true } };
          return saveAsScene({ steps: [{ target: [...selected], action: step.action, args: step.args }] });
        }
      }
    },
  };
}
