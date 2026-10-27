// Fixing connections, in one tap: a stepper that shows each check as it
// happens (✓ / ⚠ / ✕), plain words for everyone, the raw facts for nerds,
// and a straight jump into the right pairing step when a TV needs it.
// Also: the "Codes & pairing" section of each TV's settings, and the Google
// TV "Unlock full remote" code entry.
import { feedback, haptic } from './feel.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ORDER = ['network', 'wake', 'find', 'reconnect', 'verify', 'pair'];
const LABEL = {
  network: 'On the network?',
  wake: 'Wake it up',
  find: 'Look for it again',
  reconnect: 'Reconnect',
  verify: 'Check it answers',
  pair: 'Trust',
};
const ICON = { running: '', ok: '✓', warn: '!', fail: '✕', pending: '' };
const PAIR_LABEL = {
  'lg-pin': 'Pair again with a number',
  'lg-allow': 'Pair again with Allow',
  'samsung-allow': 'Pair again',
  'googletv-code': 'Unlock the full remote',
  'appletv-pin': 'Pair again with a code',
  'roku-network-access': 'Show me where',
};

export function createDoctor({ api, note, getTv, onPair, onGuide = null }) {
  const sheet = document.createElement('dialog');
  sheet.className = 'sheet doctor-sheet';
  sheet.id = 'doctorSheet';
  document.body.append(sheet);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close();
  });
  let watching = null; // tv id whose steps stream into the sheet
  let steps = {};

  const row = (step) => {
    const s = steps[step] ?? { status: 'pending', detail: '' };
    return `<li class="dr-step st-${s.status}" data-step="${step}">
      <span class="dr-dot" aria-hidden="true">${ICON[s.status] ?? ''}</span>
      <span class="dr-text"><b>${LABEL[step]}</b>${s.detail ? `<small>${esc(s.detail)}</small>` : ''}
      ${s.nerd ? `<details class="dr-nerd"><summary class="mono">details</summary><pre class="mono">${esc(JSON.stringify(s.nerd, null, 2))}</pre></details>` : ''}</span>
    </li>`;
  };

  function paint(tv, report = null) {
    const body = `
      <div class="sheet-grip"></div>
      <h3>${report ? (report.ok ? 'Fixed ✓' : report.needsPairing ? 'One more step' : 'Not fixed yet') : `Fixing ${esc(tv?.name ?? 'the TV')}…`}</h3>
      <p class="sub">${report ? esc(report.summary) : 'Checking each thing in turn. This can take up to half a minute.'}</p>
      <ol class="dr-steps">${ORDER.map(row).join('')}</ol>
      ${report && !report.ok && onGuide ? `<button type="button" class="chip big dr-guide" data-press="up" data-doctor="guide" data-tv="${esc(tv.id)}">How to fix my ${esc(tv.model || 'TV')} · or send it to us</button>` : ''}
      <div class="sheet-actions">
        ${report && !report.ok && !report.needsPairing ? '<button type="button" class="ghost" data-press="up" data-doctor="again">Try again</button>' : '<span></span>'}
        ${report?.needsPairing
          ? `<button type="button" class="cta small" data-press="up" data-doctor="pair" data-how="${esc(report.how)}" data-tv="${esc(tv.id)}">${esc(PAIR_LABEL[report.how] ?? 'Pair again')}</button>`
          : `<button type="button" class="cta small" data-press="up" data-doctor="close">${report ? 'Done' : 'Hide'}</button>`}
      </div>`;
    sheet.innerHTML = body;
  }

  async function fix(id) {
    const tv = getTv(id);
    if (!tv) return;
    haptic('tap');
    watching = id;
    steps = {};
    paint(tv);
    if (!sheet.open) sheet.showModal();
    try {
      const report = await api('POST', `/tvs/${id}/doctor`);
      for (const s of report.steps ?? []) steps[s.step] = s;
      if (watching !== id) return;
      feedback(report.ok ? 'success' : report.needsPairing ? 'press' : 'error');
      paint(getTv(id) ?? tv, report);
    } catch (err) {
      feedback('error');
      steps.verify = { status: 'fail', detail: err.message };
      paint(tv, { ok: false, summary: err.message });
    }
  }

  async function fixAll() {
    haptic('tap');
    watching = null;
    sheet.innerHTML = `<div class="sheet-grip"></div><h3>Fixing every TV…</h3><p class="sub">Each TV is checked at the same time.</p><ul class="dr-all"><li class="dr-step st-running"><span class="dr-dot"></span><span class="dr-text"><b>Working…</b></span></li></ul>`;
    if (!sheet.open) sheet.showModal();
    try {
      const { reports } = await api('POST', '/doctor');
      const ok = reports.filter((r) => r.ok).length;
      feedback(ok === reports.length ? 'success' : 'press');
      sheet.innerHTML = `<div class="sheet-grip"></div>
        <h3>${ok === reports.length ? 'Every TV is fine ✓' : `${ok} of ${reports.length} fine`}</h3>
        <ul class="dr-all">${reports
          .map((r) => `<li class="dr-step st-${r.ok ? 'ok' : r.needsPairing ? 'warn' : 'fail'}">
            <span class="dr-dot" aria-hidden="true">${r.ok ? '✓' : r.needsPairing ? '!' : '✕'}</span>
            <span class="dr-text"><b>${esc(r.name)}</b><small>${esc(r.summary)}</small></span>
            ${r.needsPairing ? `<button type="button" class="chip" data-press="up" data-doctor="pair" data-how="${esc(r.how)}" data-tv="${esc(r.id)}">${esc(PAIR_LABEL[r.how] ?? 'Pair')}</button>` : r.ok ? '' : `<button type="button" class="chip" data-press="up" data-doctor="fix" data-tv="${esc(r.id)}">Details</button>`}
          </li>`)
          .join('')}</ul>
        <div class="sheet-actions"><span></span><button type="button" class="cta small" data-press="up" data-doctor="close">Done</button></div>`;
    } catch (err) {
      note(err.message, true);
      sheet.close();
    }
  }

  // ── Google TV: unlock the full remote with the code on screen ──
  async function unlock(id) {
    const tv = getTv(id);
    haptic('tap');
    watching = null;
    sheet.innerHTML = `<div class="sheet-grip"></div>
      <div class="dr-art" aria-hidden="true"><div class="dr-tv"><span class="dr-code mono">• • • • • •</span></div></div>
      <h3 id="drTitle">Asking ${esc(tv?.name ?? 'the TV')} for a code…</h3>
      <p class="sub" id="drSub">Look at the TV: a box with 6 letters and numbers is about to appear.</p>
      <form id="drCodeForm" class="fields" hidden>
        <input class="ip-input dr-input" id="drCode" maxlength="6" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="A1B2C3" aria-label="Code on the TV">
        <div class="sheet-actions">
          <button type="button" class="ghost" data-press="up" data-doctor="gtv-unlock" data-tv="${esc(id)}">Show a new code</button>
          <button type="submit" class="cta small">Unlock</button>
        </div>
      </form>`;
    if (!sheet.open) sheet.showModal();
    try {
      const res = await api('POST', `/tvs/${id}/pair`, { mode: 'code' });
      if (!res.needsCode) throw new Error('The TV didn’t offer a code');
    } catch (err) {
      feedback('error');
      sheet.querySelector('#drTitle').textContent = 'The TV didn’t answer';
      sheet.querySelector('#drSub').textContent = `${err.message}. Make sure it’s on, then try again.`;
      sheet.querySelector('#drCodeForm').hidden = false;
      return;
    }
    haptic('press');
    sheet.querySelector('#drTitle').textContent = 'Type the code on the TV';
    sheet.querySelector('#drSub').textContent = '6 letters and numbers (0–9, A–F). You only do this once.';
    const form = sheet.querySelector('#drCodeForm');
    const input = sheet.querySelector('#drCode');
    form.hidden = false;
    input.addEventListener('input', () => {
      input.value = input.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6);
    });
    setTimeout(() => input.focus(), 150);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (input.value.length !== 6) {
        input.classList.remove('shake');
        void input.offsetWidth;
        input.classList.add('shake');
        return feedback('error');
      }
      try {
        await api('POST', `/tvs/${id}/pair`, { code: input.value });
        feedback('success');
        // The settings sheet behind us still says "Unlock": refresh it once
        // the TV's new capabilities have arrived.
        setTimeout(() => {
          const host = document.querySelector('#codesBox');
          if (document.querySelector('#editSheet')?.open && host) renderCodes(host, getTv(id));
        }, 400);
        sheet.innerHTML = `<div class="sheet-grip"></div><h3>Unlocked 🎉</h3><p class="sub">Arrows, OK, back, home and power now work on ${esc(tv?.name ?? 'this TV')}.</p><div class="sheet-actions"><span></span><button type="button" class="cta small" data-press="up" data-doctor="close">Done</button></div>`;
      } catch (err) {
        feedback('error');
        input.classList.remove('shake');
        void input.offsetWidth;
        input.classList.add('shake');
        note(err.message, true);
        input.select();
      }
    });
  }

  // ── The "Codes & pairing" block in a TV's settings sheet ──
  function renderCodes(host, tv) {
    if (!host || !tv) return;
    const b = (doctor, label, sub, extra = '') =>
      `<button type="button" class="toggle" data-press="up" data-doctor="${doctor}" data-tv="${esc(tv.id)}" ${extra}><span><b>${label}</b><small class="mono">${sub}</small></span><span aria-hidden="true">›</span></button>`;
    const rows = [b('fix', 'Fix connection', 'Wake · find · reconnect · check')];
    if (tv.brand === 'lg') {
      rows.push(b('pair', 'Pair again with a number', 'The TV shows a number; no remote needed', 'data-how="lg-pin"'));
      rows.push(b('pair', 'Pair again with Allow', 'Press Allow with the TV’s remote', 'data-how="lg-allow"'));
    } else if (tv.brand === 'samsung') {
      rows.push(b('pair', 'Pair again', 'Older Samsungs connect by themselves; newer ones ask once', 'data-how="samsung-allow"'));
    } else if (tv.brand === 'androidtv') {
      rows.push(
        tv.capabilities?.remote
          ? b('gtv-unlock', 'Full remote: unlocked ✓', 'Tap to unlock again with a new code')
          : b('gtv-unlock', 'Unlock full remote (arrows & power)', 'Type the 6-character code shown on the TV'),
      );
    } else if (tv.brand === 'roku') {
      rows.push(`<p class="sub left">Roku needs no pairing. If it refuses commands: on the Roku, Settings → System → Advanced system settings → Control by mobile apps → Network access → Default.</p>`);
    }
    host.innerHTML = `<h4 class="mono dr-h">Codes &amp; pairing</h4>${rows.join('')}`;
  }

  return {
    fix,
    fixAll,
    unlock,
    renderCodes,
    onEvent(e) {
      if (!sheet.open || e.id !== watching) return;
      steps[e.step] = e;
      const li = sheet.querySelector(`.dr-step[data-step="${e.step}"]`);
      if (li) li.outerHTML = row(e.step);
      if (e.status === 'ok') haptic('tick');
    },
    onHealed(info) {
      feedback('success');
      note(info.message);
    },
    async handle(el) {
      const a = el.dataset.doctor;
      const id = el.dataset.tv;
      if (a === 'close') return sheet.close();
      if (a === 'fix') return fix(id);
      if (a === 'all') return fixAll();
      if (a === 'again') return fix(watching);
      if (a === 'gtv-unlock') return unlock(id ?? watching);
      if (a === 'guide') {
        // What failed, in the guide's words, for a model-specific fix.
        const failed = (s) => s?.status === 'fail' || s?.status === 'warn';
        const when = failed(steps.network) ? 'not-found' : failed(steps.wake) ? 'wont-wake' : failed(steps.pair) || failed(steps.verify) ? 'refused' : 'drops';
        const tv = getTv(id);
        sheet.close();
        return onGuide?.(tv, {
          when,
          steps: Object.values(steps).map((s) => ({ step: s.step, status: s.status, detail: s.detail })),
          error: steps.verify?.detail ?? '',
        });
      }
      if (a === 'pair') {
        const how = el.dataset.how;
        if (how === 'googletv-code') return unlock(id);
        if (how === 'roku-network-access') {
          return note('On the Roku: Settings → System → Advanced system settings → Control by mobile apps → Network access → Default');
        }
        sheet.close();
        document.querySelector('#editSheet')?.close();
        return onPair(getTv(id), how);
      }
    },
  };
}
