// "Tell everyone": one message on every TV that can show it ("Dinner's
// ready"), a plain reason for each one that can't, and an optional pause so
// the people watching those still notice. Server: src/announce.js.
import { feedback, haptic } from './feel.js';
import { track } from './analytics.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const QUICK = ['Dinner’s ready! 🍽️', 'Bedtime in 10 minutes 🌙', 'Leaving in 5, shoes on 👟', 'Come to the kitchen 👋', 'Screens off in 10 ⏰'];
const RECENT_KEY = 'hearth.say.recent';
const PAUSE_KEY = 'hearth.say.pause';

const read = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? d : JSON.parse(v);
  } catch {
    return d;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

export function createAnnounce({ api, note }) {
  const sheet = document.querySelector('#announceSheet');
  let plan = [];
  let sending = false;

  const chips = () => {
    const recent = read(RECENT_KEY, []).filter((m) => typeof m === 'string');
    const seen = new Set();
    return [...recent, ...QUICK].filter((m) => !seen.has(m.toLowerCase()) && seen.add(m.toLowerCase())).slice(0, 6);
  };

  function row(t, { pause }) {
    if (t.can) return `<li class="ann-tv ann-yes"><i aria-hidden="true">✓</i><span><b>${esc(t.name)}</b><small>Shows it on screen</small></span></li>`;
    const pausing = pause && t.pause;
    return `<li class="ann-tv ${pausing ? 'ann-pause' : 'ann-no'}"><i aria-hidden="true">${pausing ? '⏸' : '–'}</i><span><b>${esc(t.name)}</b><small>${pausing ? 'Can’t show it, so it pauses' : esc(t.why)}</small></span></li>`;
  }

  function draw(message = '') {
    const pause = read(PAUSE_KEY, false) === true;
    const shows = plan.filter((t) => t.can).length;
    const pausable = plan.filter((t) => !t.can && t.pause).length;
    const lead = !plan.length
      ? 'Add a TV first.'
      : shows
        ? `Shows on ${shows === plan.length ? (shows === 1 ? 'your TV' : `all ${shows} TVs`) : `${shows} of ${plan.length} TVs`}. Only LG TVs can put words on the screen.`
        : 'None of your TVs can show it right now. Here’s why.';
    sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <h3>Tell everyone</h3>
      <p class="sub">${lead}</p>
      <form class="fields ann-form" autocomplete="off">
        <div class="chips ann-chips">${chips().map((m) => `<button type="button" class="chip" data-press="up" data-say="${esc(m)}">${esc(m)}</button>`).join('')}</div>
        <label class="ann-input"><span class="mono">Message</span><input name="message" maxlength="120" placeholder="Dinner’s ready!" value="${esc(message)}" enterkeyhint="send"></label>
        <ul class="ann-tvs">${plan.map((t) => row(t, { pause })).join('')}</ul>
        ${pausable ? `<label class="ann-toggle"><input type="checkbox" name="pause" ${pause ? 'checked' : ''}><span>Pause the ${pausable === 1 ? 'TV' : `${pausable} TVs`} that can’t show it<small>So whoever’s watching still notices.</small></span></label>` : ''}
        <div class="sheet-actions">
          <button type="button" class="ghost" data-press="up" data-ann="close">Close</button>
          <button type="submit" class="cta small" ${shows || pausable ? '' : 'disabled'}>Send</button>
        </div>
      </form>`;
    const form = sheet.querySelector('form');
    const input = form.message;
    for (const b of sheet.querySelectorAll('[data-say]'))
      b.addEventListener('click', () => {
        input.value = b.dataset.say;
        haptic('tick');
        input.focus({ preventScroll: true });
      });
    sheet.querySelector('[data-ann="close"]').addEventListener('click', () => sheet.close());
    form.pause?.addEventListener('change', (e) => {
      write(PAUSE_KEY, e.target.checked);
      sheet.querySelector('.ann-tvs').innerHTML = plan.map((t) => row(t, { pause: e.target.checked })).join('');
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send(input.value, Boolean(form.pause?.checked));
    });
  }

  function drawResults(message, results) {
    const shown = results.filter((r) => r.how === 'shown').length;
    const paused = results.filter((r) => r.how === 'paused').length;
    const icon = (r) => (r.how === 'shown' ? '✓' : r.how === 'paused' ? '⏸' : '–');
    const line = (r) => (r.how === 'shown' ? 'On screen now' : r.how === 'paused' ? 'Paused (can’t show messages)' : esc(r.why));
    sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <h3>${shown ? 'Sent' : paused ? 'Paused' : 'Nobody got it'}</h3>
      <p class="sub ann-said">“${esc(message)}”</p>
      <ul class="ann-tvs">${results.map((r) => `<li class="ann-tv ${r.how === 'shown' ? 'ann-yes' : r.how === 'paused' ? 'ann-pause' : 'ann-no'}"><i aria-hidden="true">${icon(r)}</i><span><b>${esc(r.name)}</b><small>${line(r)}</small></span></li>`).join('')}</ul>
      <div class="sheet-actions">
        <button type="button" class="ghost" data-press="up" data-ann="again">Another</button>
        <button type="button" class="cta small" data-press="up" data-ann="close">Done</button>
      </div>`;
    sheet.querySelector('[data-ann="close"]').addEventListener('click', () => sheet.close());
    sheet.querySelector('[data-ann="again"]').addEventListener('click', () => open());
  }

  async function send(raw, pause) {
    const message = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!message) {
      note('Type a message, or tap one of the quick ones', true);
      sheet.querySelector('input[name="message"]')?.focus();
      return;
    }
    if (sending) return;
    sending = true;
    haptic('press');
    const btn = sheet.querySelector('button[type="submit"]');
    if (btn) (btn.disabled = true), (btn.textContent = 'Sending…');
    try {
      const { results } = await api('POST', '/announce', { message, pause });
      const shown = results.filter((r) => r.how === 'shown').length;
      const paused = results.filter((r) => r.how === 'paused').length;
      feedback(shown || paused ? 'success' : 'error');
      write(RECENT_KEY, [message, ...read(RECENT_KEY, []).filter((m) => m !== message)].slice(0, 3));
      track('announce', { step: 'sent', shown, paused, skipped: results.length - shown - paused, tvs: results.length, pause, quick: QUICK.includes(message) });
      note(shown ? `On ${shown} TV${shown > 1 ? 's' : ''}${paused ? `, ${paused} paused` : ''}` : paused ? `Paused ${paused} TV${paused > 1 ? 's' : ''}` : 'No TV could show it', !shown && !paused);
      drawResults(message, results);
    } catch (err) {
      feedback('error');
      note(err.message, true);
      if (btn) (btn.disabled = false), (btn.textContent = 'Send');
    } finally {
      sending = false;
    }
  }

  async function open(message = '') {
    sheet.innerHTML = '<div class="sheet-grip"></div><h3>Tell everyone</h3><p class="sub">Checking which TVs can show it…</p>';
    if (!sheet.open) sheet.showModal();
    try {
      plan = (await api('GET', '/announce')).tvs ?? [];
    } catch (err) {
      plan = [];
      note(err.message, true);
    }
    track('announce', { step: 'open', tvs: plan.length, can: plan.filter((t) => t.can).length });
    draw(message);
  }

  return { open, send };
}
