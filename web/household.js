// The household: only phones that joined the house can work the TVs.
//  - The door: a phone that isn't in yet sees a big number pad. Type the
//    6-digit house code (or open an invite link, #join=…) and you're in.
//  - "Phones in this house" (Settings): the code, every phone that's in,
//    rename one, hold to remove one, or pick a new code.
//  - invite(): a one-time link for "Get Hearth on another phone" (install.js).
// The server keeps the phone's token in an HttpOnly cookie; this file never sees it.
import { feedback, haptic } from './feel.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const BACK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h11v14H9l-6-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="m12 9 6 6m0-6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

function ago(t) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const spaced = (code) => String(code).replace(/(\d{3})(\d{3})/, '$1 $2');

export function createHousehold({ api, note, isDemo = false }) {
  let status = isDemo ? { locked: false, trusted: true } : null;
  let door = null;
  let entered = '';
  let busy = false;
  let letIn = null; // resolves the gate

  // ── The door ──
  function showDoor(reason) {
    if (door) return;
    haptic('tap');
    entered = '';
    door = document.createElement('div');
    door.className = 'door';
    door.setAttribute('role', 'dialog');
    door.setAttribute('aria-modal', 'true');
    door.setAttribute('aria-labelledby', 'doorTitle');
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    door.innerHTML = `
      <div class="door-sky" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="door-card">
        <div class="door-mark" aria-hidden="true"><img src="icons/icon-180.png" alt="" width="64" height="64"></div>
        <p class="kicker mono">Hearth</p>
        <h2 id="doorTitle">${reason === 'removed' ? 'This phone was removed' : 'Join the house'}</h2>
        <p class="door-sub">Type the <b>house code</b> to use the TVs from this ${/iPad/.test(navigator.userAgent) ? 'iPad' : 'phone'}.</p>
        <div class="door-cells" id="doorCells" aria-live="polite" aria-label="House code, 0 of 6 digits">${'<span></span>'.repeat(6)}</div>
        <p class="door-msg mono" id="doorMsg" role="alert"></p>
        <div class="door-pad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" data-press="down" data-house="digit" data-d="${n}">${n}</button>`).join('')}
          <span></span>
          <button type="button" data-press="down" data-house="digit" data-d="0">0</button>
          <button type="button" class="door-del" data-press="repeat" data-house="del" aria-label="Delete">${BACK_ICON}</button>
        </div>
        <details class="door-help">
          <summary>Where do I find it?</summary>
          <p>Ask anyone who already uses Hearth: <b>⚙ Settings → Phones in this house</b>.${standalone ? '' : ' Or they can show you an invite: <b>⚙ → Get Hearth on another phone</b>, and you scan it.'}</p>
        </details>
      </div>`;
    document.body.append(door);
    document.documentElement.classList.add('at-door');
    addEventListener('keydown', onKey);
    addEventListener('paste', onPaste);
  }

  function closeDoor() {
    if (!door) return;
    removeEventListener('keydown', onKey);
    removeEventListener('paste', onPaste);
    const d = door;
    door = null;
    d.classList.add('opening');
    document.documentElement.classList.remove('at-door');
    setTimeout(() => d.remove(), 700);
  }

  function paint(msg = '') {
    if (!door) return;
    const cells = door.querySelector('#doorCells');
    [...cells.children].forEach((c, i) => {
      c.textContent = entered[i] ? '•' : '';
      c.classList.toggle('filled', i < entered.length);
      c.classList.toggle('next', i === entered.length);
    });
    cells.setAttribute('aria-label', `House code, ${entered.length} of 6 digits`);
    door.querySelector('#doorMsg').textContent = msg;
  }

  function type(d) {
    if (busy || entered.length >= 6) return;
    entered += d;
    paint();
    if (entered.length === 6) submit({ code: entered });
  }
  const onKey = (e) => {
    if (/^\d$/.test(e.key)) type(e.key);
    else if (e.key === 'Backspace') del();
  };
  const onPaste = (e) => {
    const digits = (e.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, 6);
    if (!digits) return;
    entered = '';
    for (const d of digits) type(d);
  };
  function del() {
    if (busy || !entered) return;
    entered = entered.slice(0, -1);
    paint();
  }

  async function submit(body) {
    busy = true;
    door?.classList.add('checking');
    try {
      await api('POST', '/household/join', body);
      status = { locked: true, trusted: true };
      feedback('success');
      if (door) {
        door.classList.remove('checking');
        door.classList.add('welcome');
        door.querySelector('#doorTitle').textContent = 'You’re in 🔥';
        await new Promise((r) => setTimeout(r, 650));
      }
      closeDoor();
      if (letIn) {
        letIn();
        letIn = null;
      } else location.reload(); // re-joined after being removed: start fresh
      return true;
    } catch (err) {
      feedback('error');
      if (door) {
        door.classList.remove('checking');
        door.classList.remove('wrong');
        void door.offsetWidth;
        door.classList.add('wrong');
        entered = '';
        paint(err.message);
      } else note(err.message, true);
      return false;
    } finally {
      busy = false;
    }
  }

  // Before the app connects: let this phone in (or show the door).
  async function gate() {
    if (isDemo) return;
    const invite = location.hash.match(/^#join=([\w-]{20,100})/)?.[1];
    if (invite) history.replaceState(null, '', location.pathname + location.search);
    try {
      status = await api('GET', '/household');
    } catch {
      return; // Hearth isn't answering: away mode takes it from here
    }
    if (status.trusted) return;
    if (invite && (await submit({ invite }))) return;
    await new Promise((resolve) => {
      letIn = resolve;
      showDoor();
      if (invite) paint('That invite was already used. Type the house code instead.');
    });
  }

  // An invite opened while the door is already up (same page, new #join=).
  addEventListener('hashchange', () => {
    const invite = location.hash.match(/^#join=([\w-]{20,100})/)?.[1];
    if (!invite || !door || busy) return;
    history.replaceState(null, '', location.pathname + location.search);
    submit({ invite });
  });

  // Any API call answered 401: this phone was removed from the house.
  function locked() {
    if (isDemo || door || !status?.trusted) return;
    status = { locked: true, trusted: false };
    showDoor('removed');
  }

  // The live stream closed for good: was this phone removed?
  async function recheck() {
    if (isDemo || door || !status?.locked) return;
    const s = await api('GET', '/household').catch(() => null);
    if (s && !s.trusted) locked();
  }

  // A one-time invite link, or null when the house isn't locked (or demo).
  async function invite(base) {
    if (isDemo || !status?.locked) return null;
    const { token } = await api('POST', '/household/invite');
    return `${base.split('#')[0]}#join=${token}`;
  }

  // ── Phones in this house ──
  const sheet = document.createElement('dialog');
  sheet.className = 'sheet phones-sheet';
  sheet.id = 'phonesSheet';
  document.body.append(sheet);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close();
  });
  let shown = false;
  let data = null;

  async function openPhones() {
    haptic('tap');
    shown = false;
    if (isDemo) data = { code: '000000', devices: [{ id: 'demo', name: 'This phone', lastSeen: Date.now(), current: true }], demo: true };
    else {
      try {
        data = await api('GET', '/household/devices');
      } catch (err) {
        return note(/404/.test(err.message) ? 'Anyone on this Wi-Fi can use Hearth (HEARTH_OPEN=1).' : err.message, true);
      }
    }
    renderPhones();
    if (!sheet.open) sheet.showModal();
  }

  function renderPhones() {
    const n = data.devices.length;
    sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <h3>Phones in this house</h3>
      <p class="sub">${data.demo ? 'In the demo every phone is in. At home, new phones need the code.' : 'Only these can work the TVs. A new phone types the code once.'}</p>
      <button type="button" class="house-code${shown ? ' shown' : ''}" data-press="up" data-house="reveal" aria-label="${shown ? `House code ${spaced(data.code)}` : 'Show the house code'}">
        <small class="mono">House code</small>
        <b class="mono">${shown ? spaced(data.code) : '••• •••'}</b>
        <small class="mono">${shown ? 'Tap to hide' : 'Tap to show'}</small>
      </button>
      <ul class="phones">${data.devices
        .map((d) => `<li data-id="${esc(d.id)}">
          <span class="ph-ico" aria-hidden="true">${/iPad|tablet/i.test(d.name) ? '▭' : /Mac|PC|Linux|Chromebook/.test(d.name) ? '⌨' : '▯'}</span>
          <span class="ph-meta"><input class="ph-name" value="${esc(d.name)}" maxlength="40" aria-label="Name of this phone" ${data.demo ? 'disabled' : ''}><small class="mono">${d.current ? 'This phone · ' : ''}${ago(d.lastSeen)}</small></span>
          ${data.demo ? '' : `<button type="button" class="danger hold small" data-press="confirm" data-house="remove" data-id="${esc(d.id)}"><span class="charge" aria-hidden="true"></span>Hold to remove</button>`}
        </li>`)
        .join('') || '<li class="ph-empty mono">No phones yet. This computer is always in.</li>'}</ul>
      <p class="sub small mono">${n} phone${n === 1 ? '' : 's'} · the computer running Hearth is always in</p>
      <div class="sheet-actions">
        ${data.demo ? '<span></span>' : '<button type="button" class="ghost" data-press="up" data-house="new-code">New code</button>'}
        <button type="button" class="cta small" data-close>Done</button>
      </div>`;
    for (const input of sheet.querySelectorAll('.ph-name')) {
      input.addEventListener('keydown', (e) => e.key === 'Enter' && input.blur());
      input.addEventListener('change', () => rename(input.closest('li').dataset.id, input.value));
    }
  }

  async function rename(id, name) {
    try {
      await api('PATCH', `/household/devices/${id}`, { name });
      feedback('success');
    } catch (err) {
      note(err.message, true);
    }
  }

  async function remove(id) {
    const me = data.devices.find((d) => d.id === id)?.current;
    try {
      await api('DELETE', `/household/devices/${id}`);
      feedback('success');
      if (me) {
        sheet.close();
        return locked();
      }
      data.devices = data.devices.filter((d) => d.id !== id);
      note('Removed. It needs the code to come back.');
      renderPhones();
    } catch (err) {
      note(err.message, true);
    }
  }

  async function newCode() {
    try {
      const { code } = await api('POST', '/household/code', {});
      data.code = code;
      shown = true;
      feedback('success');
      note('New code. Phones already in stay in.');
      renderPhones();
    } catch (err) {
      note(err.message, true);
    }
  }

  return {
    gate,
    locked,
    recheck,
    invite,
    openPhones,
    handle(el) {
      const a = el.dataset.house;
      if (a === 'digit') {
        haptic('tap');
        return type(el.dataset.d);
      }
      if (a === 'del') {
        haptic('tap');
        return del();
      }
      if (a === 'reveal') {
        haptic('tap');
        shown = !shown;
        return renderPhones();
      }
      if (a === 'remove') return remove(el.dataset.id);
      if (a === 'new-code') return newCode();
      if (a === 'phones') return openPhones();
    },
  };
}
