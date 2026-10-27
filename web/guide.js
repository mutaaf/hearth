// "We know your TV, here's how": a model-specific connection guide (built in,
// src/devices.js, plus the AI's take for that exact model) and, when nothing
// works, "send it to us": an anonymised report into the support queue that
// an agent works through to build support for that TV. Hearth checks back on
// the ticket and says so when it's done.
import { feedback, haptic } from './feel.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const BRANDS = [['lg', 'LG'], ['samsung', 'Samsung'], ['roku', 'Roku'], ['androidtv', 'Google TV'], ['appletv', 'Apple TV'], ['other', 'Something else']];
const brandName = (b) => Object.fromEntries(BRANDS)[b] ?? 'TV';
const TICKETS = 'hearth.support';
const WHEN_LABEL = {
  refused: 'It said no',
  'no-prompt': 'No Allow box',
  'not-found': 'Can’t find it',
  drops: 'Keeps dropping',
  'wont-wake': 'Won’t turn on',
  'auto-off': 'Turns itself off',
  setup: 'Setting up',
  other: 'Something else',
};

const loadTickets = () => {
  try {
    return JSON.parse(localStorage.getItem(TICKETS) || '[]');
  } catch {
    return [];
  }
};
const saveTickets = (list) => {
  try {
    localStorage.setItem(TICKETS, JSON.stringify(list.slice(-20)));
  } catch {}
};

export function createGuide({ api, note }) {
  const sheet = document.createElement('dialog');
  sheet.className = 'sheet guide-sheet';
  sheet.id = 'guideSheet';
  document.body.append(sheet);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close();
  });
  let ctx = null; // { tvId?, device?, symptom?, name? }
  let last = null; // { guide, ai, aiError }

  const ask = (c, ai) => api('POST', '/guide', { tvId: c.tvId, device: c.device, symptom: c.symptom, ai });

  // The short version, for the setup wizard: who it is and what to do.
  function card(g, { compact = false } = {}) {
    if (!g) return '';
    const who = g.known || g.source === 'AI' ? `We know this one · ${esc(g.family)}${g.year && !String(g.family).includes(g.year) ? ` · ${g.year}` : ''}` : `${esc(brandName(g.brand))} TV`;
    return `<section class="guide-card${compact ? ' compact' : ''}">
      <p class="guide-kicker mono">${who}</p>
      <p class="guide-summary">${esc(g.connect.summary)}</p>
      ${g.connect.before.length ? `<ol class="guide-steps">${g.connect.before.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
      ${g.connect.onTv && !compact ? `<p class="guide-ontv"><i aria-hidden="true">📺</i>${esc(g.connect.onTv)}</p>` : ''}
    </section>`;
  }

  // Fixes for what went wrong, the matching ones first.
  function fixes(g, when) {
    const list = g?.troubleshoot ?? [];
    const first = list.filter((t) => t.when === when);
    return (first.length ? first : list).slice(0, 3);
  }

  function paint() {
    const g = last?.guide;
    const name = ctx.name || (g?.model ? `${brandName(g.brand)} ${g.model}` : brandName(g?.brand));
    const when = ctx.symptom?.when;
    const tips = g ? fixes(g, when) : [];
    sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <h3>${when && when !== 'setup' ? 'Let’s get it talking' : 'Your TV, explained'}</h3>
      <p class="sub">${esc(name)}${g?.year ? ` · ${g.year}` : ''}${g?.os ? ` · ${esc(g.os)}` : ''}</p>
      ${g ? card(g) : '<p class="sub">Looking it up…</p>'}
      ${tips.length ? `<h4 class="mono guide-h">${when && WHEN_LABEL[when] ? `${esc(WHEN_LABEL[when])}? Try this` : 'If it gets stuck'}</h4>
        <ul class="guide-fixes">${tips.map((t) => `<li><b>${esc(WHEN_LABEL[t.when] ?? '')}</b>${esc(t.fix)}</li>`).join('')}</ul>` : ''}
      ${g?.keepReachable?.length ? `<h4 class="mono guide-h">Keep it reachable</h4>
        <ul class="guide-keep">${g.keepReachable.map((k) => `<li><b>${esc(k.title)}</b><small>${esc(k.path)}</small></li>`).join('')}</ul>` : ''}
      ${g?.quirks?.length ? `<details class="guide-quirks"><summary class="mono">Good to know</summary><ul>${g.quirks.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></details>` : ''}
      <p class="guide-src mono">${last?.ai ? `Built-in guide + AI (${esc(last.ai.cached ? 'saved answer' : 'fresh')}${last.ai.confidence ? `, ${esc(last.ai.confidence)} confidence` : ''})` : last?.aiError ? `Built-in guide · AI: ${esc(last.aiError)}` : 'Built-in guide'}</p>
      <div class="guide-actions">
        ${g?.model || ctx.device?.model || ctx.tvId ? `<button type="button" class="ghost" data-press="up" data-guide="ai">${last?.busy ? 'Asking the AI…' : last?.ai ? 'Ask the AI again' : `Ask the AI about my ${esc(brandName(g?.brand))}`}</button>` : ''}
        <button type="button" class="cta small" data-press="up" data-guide="report">Still stuck? Send it to us</button>
      </div>`;
  }

  async function open(c) {
    ctx = c;
    last = null;
    paint();
    if (!sheet.open) sheet.showModal();
    try {
      last = await ask(c, c.symptom ? undefined : false);
    } catch (err) {
      last = { guide: null, aiError: err.message };
    }
    if (ctx === c) paint();
  }

  async function askAi() {
    if (!ctx || last?.busy) return;
    const c = ctx;
    last = { ...last, busy: true };
    paint();
    try {
      last = await api('POST', '/guide', { tvId: c.tvId, device: c.device, symptom: c.symptom, ai: true, refresh: Boolean(last?.ai) });
      if (last.ai) feedback('success');
    } catch (err) {
      last = { ...last, busy: false, aiError: err.message };
    }
    if (ctx === c) paint();
  }

  // ── "Send it to us" ──
  function report(c = ctx) {
    ctx = c;
    const brand = c.device?.brand ?? last?.guide?.brand ?? '';
    const model = c.device?.model ?? last?.guide?.model ?? '';
    const when = c.symptom?.when ?? 'other';
    sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <h3>Send it to us</h3>
      <p class="sub">We read every one, and teach Hearth your TV. You’ll see a note here when it’s done.</p>
      <form class="fields guide-form" id="supportForm">
        ${c.tvId ? '' : `<div class="guide-brands" role="radiogroup" aria-label="Brand">${BRANDS.map(([id, label]) => `<button type="button" role="radio" aria-checked="${id === brand}" class="chip${id === brand ? ' active' : ''}" data-press="up" data-guide="brand" data-brand="${id}">${label}</button>`).join('')}</div>
        <label><span class="mono">Model (on a sticker on the back, or in the TV’s settings)</span><input id="supportModel" maxlength="40" value="${esc(model)}" placeholder="UN55KU6290" autocomplete="off" autocapitalize="characters"></label>`}
        <label><span class="mono">What happens? (optional)</span><textarea id="supportNote" maxlength="500" rows="3" placeholder="It shows up, then says it can’t connect…"></textarea></label>
        <details class="guide-sent"><summary class="mono">What we’ll send</summary>
          <ul><li>The brand and model${c.tvId ? ` (${esc(brandName(brand))} ${esc(model) || 'model unknown'})` : ''}, and its software version if Hearth knows it</li>
          <li>What went wrong: ${esc(WHEN_LABEL[when] ?? when)}${c.symptom?.steps?.length ? `, and which checks passed or failed` : ''}</li>
          <li>Your note, with any addresses or long numbers taken out</li>
          <li>This app’s version</li></ul>
          <p>Never the TV’s name or room, network addresses, serial numbers or anything about you.</p></details>
        <div class="sheet-actions">
          <button type="button" class="ghost" data-press="up" data-guide="back">Back</button>
          <button type="submit" class="cta small">Send</button>
        </div>
      </form>`;
    if (!sheet.open) sheet.showModal();
    const form = sheet.querySelector('#supportForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const picked = sheet.querySelector('.guide-brands [aria-checked="true"]')?.dataset.brand ?? brand;
      if (!c.tvId && !picked) return note('Pick the TV’s brand first.', true);
      const device = c.tvId ? c.device : { brand: picked, model: sheet.querySelector('#supportModel')?.value.trim() ?? '' };
      const host = window.HearthHost;
      const body = {
        tvId: c.tvId,
        report: {
          device: { ...device, firmware: c.device?.firmware },
          symptom: c.symptom ?? { when: 'other' },
          app: { platform: host?.native ? 'ios' : 'web', version: host?.version ?? '' },
          guideKnown: Boolean(last?.guide?.known),
          note: sheet.querySelector('#supportNote').value,
        },
      };
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      try {
        const { id } = await api('POST', '/support', body);
        saveTickets([...loadTickets(), { id, label: `${brandName(device.brand)} ${device.model || ''}`.trim(), at: Date.now(), checked: 0 }]);
        feedback('success');
        sheet.innerHTML = `<div class="sheet-grip"></div><h3>Got it 🙌</h3>
          <p class="sub">Ticket <b class="mono">${esc(id)}</b>. We’ll work on your ${esc(brandName(device.brand))}${device.model ? ` ${esc(device.model)}` : ''} and Hearth will tell you here when it’s ready.</p>
          <div class="sheet-actions"><span></span><button type="button" class="cta small" data-press="up" data-guide="close">Done</button></div>`;
      } catch (err) {
        feedback('error');
        btn.disabled = false;
        btn.textContent = 'Send';
        note(err.message, true);
      }
    });
  }

  // Tickets this phone sent: ask how they're doing, at most every 6 hours.
  async function checkTickets() {
    const list = loadTickets();
    let changed = false;
    for (const t of list) {
      if (t.done || Date.now() - (t.checked || 0) < 6 * 3_600_000) continue;
      t.checked = Date.now();
      changed = true;
      try {
        const s = await api('GET', `/support/${t.id}`);
        if (s.status === 'supported') {
          t.done = true;
          note(`Good news: Hearth now supports your ${t.label}. ${s.resolution ?? 'Update Hearth to get it.'}`);
        } else if (s.status === 'wont-fix' || s.status === 'duplicate') t.done = true;
      } catch {}
    }
    if (changed) saveTickets(list);
  }

  return {
    card,
    fixes,
    open,
    report,
    checkTickets,
    // The built-in guide for a TV we just found (no AI unless it's unknown).
    lookup: (device) => api('POST', '/guide', { device }).catch(() => null),
    handle(el) {
      const a = el.dataset.guide;
      if (a === 'close') return sheet.close();
      if (a === 'ai') return askAi();
      if (a === 'report') return report();
      if (a === 'back') return last ? paint() : sheet.close();
      if (a === 'brand') {
        haptic('tap');
        for (const b of sheet.querySelectorAll('.guide-brands [data-brand]')) {
          const on = b === el;
          b.classList.toggle('active', on);
          b.setAttribute('aria-checked', String(on));
        }
      }
    },
  };
}
