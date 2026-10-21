// The setup wizard: so easy a caveman can do it. One sentence and one giant
// button per screen. Turn the TV on → we find it → press Allow on the TV's
// remote → tap a room → done. Every dead end has a plain-words way out.
import { feedback, haptic } from './feel.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const brandName = (b) => ({ lg: 'LG', samsung: 'Samsung', roku: 'Roku', androidtv: 'Google TV', appletv: 'Apple TV' })[b] ?? 'TV';
const DOTS = ['on', 'search', 'pair', 'name', 'done'];
// Steps that sit under another step's progress dot.
const DOT_OF = { pick: 'search', none: 'search', manual: 'search', pairfail: 'pair', wake: 'on', lgchoose: 'pair', pin: 'pair' };
const PAIR_SECONDS = 60;
const ROOMS = [
  ['🛋️', 'Living Room'], ['🛏️', 'Bedroom'], ['🧸', 'Kids’ Room'], ['🍳', 'Kitchen'],
  ['💻', 'Office'], ['🎮', 'Basement'], ['🏋️', 'Gym'], ['🏡', 'Den'],
];

export function createSetup({ root, api, onTv, onClose, note }) {
  let state = {};
  let field = null;
  let run = 0; // bumps on every step change so late network replies are ignored
  let countdown = 0;

  function mountField(initial) {
    const AF = window.AuroraField;
    const host = root.querySelector('.field-art');
    if (!AF || !window.HearthShapes || !host) return;
    window.HearthShapes.register(AF);
    const canvas = document.createElement('canvas');
    host.append(canvas);
    try {
      field = AF.create(canvas, {
        shapes: ['mind', 'hearth-tv', 'hearth-house'], initial, cycle: 0,
        palette: 'ember', stars: 30, count: 1600, interactive: false,
      });
    } catch {
      canvas.remove();
    }
  }

  function unmountField() {
    field?.destroy();
    field = null;
  }

  function frame(step, body) {
    const at = DOTS.indexOf(DOT_OF[step] ?? step);
    root.innerHTML = `
      <div class="setup-top">
        <div class="setup-dots" aria-hidden="true">${DOTS.map((_, i) => `<i class="${i < at ? 'done' : i === at ? 'now' : ''}"></i>`).join('')}</div>
        <button type="button" class="icon-btn" data-press="up" data-setup="close" aria-label="Close setup">✕</button>
      </div>
      <div class="setup-body">${body}</div>`;
  }

  function go(step, extra = {}) {
    run++;
    clearInterval(countdown);
    unmountField();
    // Pairing again (doctor / Codes & pairing): the TV already has a room.
    if (step === 'name' && (extra.repair ?? state.repair)) step = 'done';
    Object.assign(state, extra, { step });
    STEPS[step]();
    root.querySelector('.setup-body')?.focus?.();
  }

  // Each brand has its own front door. LG: a number on screen (no remote) or
  // Allow. Samsung: Allow if it asks (older ones don't). Roku/Google TV: none.
  // Apple TV: a 4-digit code on screen, twice (remote, then what's playing).
  function startPair(extra = {}) {
    Object.assign(state, extra);
    const brand = state.candidate?.brand;
    go(brand === 'lg' ? 'lgchoose' : brand === 'appletv' ? 'pin' : 'pair');
  }

  async function ensureAdded() {
    if (state.tvId) return state.tvId;
    const added = await api('POST', '/tvs', state.candidate);
    onTv(added);
    state.tvId = added.id;
    state.tv = added;
    return added.id;
  }

  const STEPS = {
    async wake() {
      const tv = state.candidate;
      frame('wake', `
        <div class="setup-art"><div class="art-tv"><div class="set"><span></span></div><div class="foot"></div></div></div>
        <h2>Waking ${esc(tv?.name ?? 'the TV')}…</h2>
        <p class="say-it" id="wakeSub">Sending the wake-up signal. This can take 20 seconds.</p>`);
      const mine = run;
      try {
        await api('POST', `/tvs/${state.tvId}/power`, { on: true });
      } catch {}
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        if (mine !== run) return;
        const list = await api('GET', '/tvs').catch(() => []);
        const now = list.find((t) => t.id === state.tvId);
        if (now?.state?.online) {
          feedback('success');
          return startPair({ candidate: now });
        }
      }
      if (mine !== run) return;
      frame('wake', `
        <h2>It didn’t wake up.</h2>
        <ul class="checklist">
          <li><i>🔌</i><span>Turn it on any way you can (its remote, a button on the TV, or the TV’s own app). Then tap below.</span></li>
          <li><i>⚙️</i><span>To make waking work next time, turn on <b>Turn on via Wi-Fi</b> (LG) or <b>Power On with Mobile</b> (Samsung) in the TV’s settings.</span></li>
        </ul>
        <div class="setup-actions">
          <button type="button" class="cta" data-press="up" data-setup="pair">It’s on now</button>
          <button type="button" class="ghost" data-press="up" data-setup="wake">Try waking it again</button>
        </div>`);
    },

    lgchoose() {
      const tv = state.candidate;
      frame('pair', `
        <h2>How should we connect?</h2>
        <p class="say-it">${esc(tv?.name ?? 'Your LG')} needs to say yes once.</p>
        <div class="pick">
          <button type="button" data-press="up" data-setup="pin">
            <span class="tvdot" aria-hidden="true"></span>
            <span><b>Show a number on the TV</b><small>No remote needed · recommended</small></span>
          </button>
          <button type="button" data-press="up" data-setup="allow">
            <span class="tvdot" aria-hidden="true"></span>
            <span><b>I’ll press Allow</b><small>With the TV’s own remote</small></span>
          </button>
        </div>`);
    },

    async pin() {
      const tv = state.candidate;
      const apple = tv?.brand === 'appletv';
      frame('pair', `
        <div class="setup-art"><div class="field-art"></div></div>
        <h2 id="pinTitle">Look at the TV…</h2>
        <p class="say-it" id="pinSub">A number is about to appear on ${esc(tv?.name ?? 'the screen')}.</p>
        <form class="fields" id="pinForm" hidden>
          <input class="ip-input" id="pinInput" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="${apple ? '••••' : '••••••'}" aria-label="Number on the TV">
          <div class="setup-actions">
            <button type="submit" class="cta">Connect</button>
            <button type="button" class="ghost" data-press="up" data-setup="pin">Show the number again</button>
          </div>
        </form>`);
      mountField('hearth-tv');
      const mine = run;
      let res;
      try {
        const id = await ensureAdded();
        res = await api('POST', `/tvs/${id}/pair`, { mode: 'pin' });
        if (mine !== run) return;
        if (!res.needsPin) {
          onTv(res);
          feedback('success');
          return go('name', { tv: res });
        }
      } catch (err) {
        if (mine !== run) return;
        feedback('error');
        return go('pairfail', { error: err.message });
      }
      const ask = (r) => {
        haptic('press');
        // Apple TV asks twice: once for the remote, once for "what's playing".
        const of = r.steps > 1 ? `Step ${r.step} of ${r.steps}: ` : '';
        root.querySelector('#pinTitle').textContent = r.step > 1 ? `${of}One more number.` : `${of}Type the number on the TV.`;
        root.querySelector('#pinSub').textContent = !apple
          ? 'It’s on the screen right now.'
          : r.step > 1
            ? 'The remote works already. This new code lets Hearth see what’s playing.'
            : `${tv?.name ?? 'The Apple TV'} is showing 4 numbers. No remote needed.`;
        const input = root.querySelector('#pinInput');
        input.value = '';
        setTimeout(() => input.focus(), 200);
      };
      ask(res);
      const form = root.querySelector('#pinForm');
      form.hidden = false;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pin = root.querySelector('#pinInput').value.replace(/\D/g, '');
        if (!pin) return;
        try {
          const paired = await api('POST', `/tvs/${state.tvId}/pair`, { pin });
          onTv(paired);
          if (mine !== run) return;
          if (paired.needsPin) return ask(paired);
          feedback('success');
          go('name', { tv: paired });
        } catch (err) {
          feedback('error');
          note(err.message, true);
          root.querySelector('#pinInput').select();
        }
      });
    },

    on() {
      frame('on', `
        <div class="setup-art"><div class="art-tv"><div class="set"><span></span></div><div class="foot"></div><span class="finger"><i></i></span></div></div>
        <h2>Turn on your TV.</h2>
        <p class="say-it">Make sure the picture is showing. Then tap the big button.</p>
        <div class="setup-actions">
          <button type="button" class="cta" data-press="up" data-setup="search">It’s on 👍</button>
          <button type="button" class="ghost" data-press="up" data-setup="close">I’ll do it later</button>
        </div>`);
    },

    async search() {
      frame('search', `
        <div class="setup-art"><div class="field-art"></div></div>
        <h2 id="searchTitle">Looking for your TV…</h2>
        <p class="say-it" id="searchSub">Hold tight. This takes a few seconds.</p>`);
      mountField('mind');
      const mine = run;
      let found;
      try {
        found = await api('POST', '/scan');
      } catch (err) {
        if (mine === run) go('none', { reason: err.message });
        return;
      }
      if (mine !== run) return;
      const fresh = found.filter((t) => !t.added);
      if (fresh.length === 1) {
        const tv = fresh[0];
        field?.setShape('hearth-tv', { pin: true });
        feedback('success');
        root.querySelector('#searchTitle').textContent = `Found it!`;
        root.querySelector('#searchSub').innerHTML = `<b>${esc(tv.name)}</b> · ${brandName(tv.brand)} ${esc(tv.model)}`;
        setTimeout(() => mine === run && startPair({ candidate: tv, tvId: null }), 1400);
      } else if (fresh.length > 1) {
        field?.setShape('hearth-house', { pin: true });
        feedback('success');
        setTimeout(() => mine === run && go('pick', { found: fresh }), 900);
      } else {
        go('none', { allAdded: found.length > 0 });
      }
    },

    pick() {
      frame('pick', `
        <h2>Which TV?</h2>
        <p class="say-it">Tap the one you want to set up.</p>
        <div class="pick">${state.found
          .map((tv, i) => `<button type="button" data-press="up" data-setup="choose" data-i="${i}">
              <span class="tvdot" aria-hidden="true"></span>
              <span><b>${esc(tv.name)}</b><small>${brandName(tv.brand)} · ${esc(tv.model || tv.ip)}</small></span>
            </button>`)
          .join('')}</div>`);
    },

    async pair() {
      const tv = state.candidate;
      const asks = tv?.brand === 'lg' || tv?.brand === 'samsung';
      frame('pair', `
        ${asks ? '' : '<div class="setup-art"><div class="field-art"></div></div><!--'}
        <div class="setup-art">
          <div class="art-allow">
            <svg class="ring" viewBox="0 0 100 100"><circle class="track" cx="50" cy="50" r="46"/><circle class="left" id="ring" cx="50" cy="50" r="46" stroke-dasharray="289" stroke-dashoffset="0"/></svg>
            <div class="box"><small>Allow Hearth to connect?</small><div class="btns"><b>Deny</b><b class="yes">Allow</b></div></div>
            <span class="secs" id="secs">${PAIR_SECONDS}s</span>
          </div>
        </div>${asks ? '' : '-->'}
        <h2>${tv?.brand === 'lg' ? 'Grab the TV’s remote.' : 'Connecting…'}</h2>
        <p class="say-it">${
          tv?.brand === 'lg'
            ? `${esc(tv?.name ?? 'Your TV')} is asking a question. Point its remote at it and press <b>OK</b> on <b>Allow</b>.`
            : tv?.brand === 'samsung'
              ? `Most Samsungs connect by themselves. If ${esc(tv?.name ?? 'the TV')} asks, press <b>Allow</b>.`
              : `No buttons needed. ${esc(tv?.name ?? 'Your TV')} lets Hearth in on its own.`
        }</p>`);
      if (!asks) mountField('hearth-tv');
      const mine = run;
      let left = PAIR_SECONDS;
      countdown = setInterval(() => {
        left = Math.max(0, left - 1);
        const ring = root.querySelector('#ring');
        if (ring) ring.style.strokeDashoffset = String(289 * (1 - left / PAIR_SECONDS));
        const secs = root.querySelector('#secs');
        if (secs) secs.textContent = `${left}s`;
        if (left > 0 && left % 10 === 0) haptic('tick');
      }, 1000);
      try {
        const wasAdded = Boolean(state.tvId);
        const id = await ensureAdded();
        if (!wasAdded && state.tv?.paired) return mine === run && go('name', { tv: state.tv });
        const paired = await api('POST', `/tvs/${id}/pair`);
        onTv(paired);
        if (mine !== run) return;
        feedback('success');
        go('name', { tv: paired });
      } catch (err) {
        if (mine !== run) return;
        feedback('error');
        go('pairfail', { error: err.message });
      }
    },

    pairfail() {
      const brand = state.candidate?.brand ?? state.tv?.brand;
      const tip = brand === 'samsung'
        ? 'On the TV: Settings → General → External Device Manager → Device Connection Manager → turn it on.'
        : brand === 'appletv'
          ? 'On the Apple TV: Settings → AirPlay and HomeKit → Allow Access → <b>Anyone on the Same Network</b>. Still stuck? Run <b>npm run up</b> on the Hearth computer (it sets up Apple TV support).'
          : 'On the TV: Settings → General → Devices → External Devices → <b>LG Connect Apps</b> → On (older TVs: Settings → Network).';
      frame('pairfail', `
        <h2>Almost! Let’s try again.</h2>
        <ul class="checklist">
          <li><i>📺</i><span>Is the TV still on? The ${brand === 'appletv' ? 'code' : 'question box'} only shows while it’s on.</span></li>
          ${brand === 'appletv'
            ? '<li><i>🔢</i><span>Type the 4 numbers quickly; the Apple TV only shows them for a minute.</span></li>'
            : '<li><i>🎯</i><span>Press <b>OK</b> on <b>Allow</b> (not Deny) with the TV’s own remote.</span></li>'}
          <li><i>⚙️</i><span>${brand === 'appletv' ? 'No numbers at all?' : 'No box at all?'} ${tip}</span></li>
        </ul>
        <p class="say-it" style="font-size:13px">${esc(state.error ?? '')}</p>
        <div class="setup-actions">
          <button type="button" class="cta" data-press="up" data-setup="pair">Try again</button>
          <button type="button" class="ghost" data-press="up" data-setup="close">Later</button>
        </div>`);
    },

    name() {
      const current = state.tv?.name ?? 'TV';
      frame('name', `
        <h2>Which room is it in?</h2>
        <p class="say-it">So you know which remote is which.</p>
        <div class="rooms">
          ${ROOMS.map(([icon, room]) => `<button type="button" data-press="up" data-setup="room" data-room="${esc(room)}"><i>${icon}</i>${esc(room)}</button>`).join('')}
        </div>
        <div class="setup-actions">
          <button type="button" class="ghost" data-press="up" data-setup="room" data-room="">Keep “${esc(current)}”</button>
        </div>`);
    },

    done() {
      const tv = state.tv;
      frame('done', `
        <div class="setup-art"><div class="field-art"></div></div>
        <h2>You did it! 🎉</h2>
        <p class="say-it"><b>${esc(tv?.name)}</b> is on your remote now. Every phone on your Wi-Fi can use it.</p>
        <div class="setup-actions">
          <button type="button" class="cta" data-press="up" data-setup="finish">Open the remote</button>
          <button type="button" class="ghost" data-press="up" data-setup="again">Add another TV</button>
        </div>`);
      mountField('hearth-tv');
      confetti();
    },

    none() {
      frame('none', `
        <h2>${state.allAdded ? 'All your TVs are already here.' : 'No TV answered yet.'}</h2>
        <ul class="checklist">
          <li><i>📺</i><span>Is the TV <b>on</b>, with a picture? (Standby doesn’t count.)</span></li>
          <li><i>📶</i><span>Is this phone on the <b>same Wi-Fi</b> as the TV? Not the guest network.</span></li>
          <li><i>💻</i><span>Is the computer running Hearth on that Wi-Fi too?</span></li>
        </ul>
        <div class="setup-actions">
          <button type="button" class="cta" data-press="up" data-setup="search">Look again</button>
          <button type="button" class="ghost" data-press="up" data-setup="manual">Type the TV’s number instead</button>
        </div>`);
    },

    manual() {
      frame('manual', `
        <h2>Type the TV’s number.</h2>
        <p class="say-it">On the TV, open <b>Settings → Network → Network Status</b>. Look for the IP address. It looks like <b>192.168.1.40</b>.</p>
        <form class="fields" id="manualForm">
          <input class="ip-input" id="manualIp" inputmode="decimal" autocomplete="off" placeholder="192.168.1.40" aria-label="TV IP address">
          <div class="setup-actions">
            <button type="submit" class="cta">Add this TV</button>
            <button type="button" class="ghost" data-press="up" data-setup="search">Back</button>
          </div>
        </form>`);
      const form = root.querySelector('#manualForm');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ip = root.querySelector('#manualIp').value.trim();
        try {
          const tv = await api('POST', '/tvs', { ip });
          onTv(tv);
          feedback('success');
          if (tv.paired) go('done', { candidate: tv, tvId: tv.id, tv });
          else startPair({ candidate: tv, tvId: tv.id, tv });
        } catch (err) {
          feedback('error');
          note(err.message, true);
        }
      });
      setTimeout(() => root.querySelector('#manualIp')?.focus(), 300);
    },
  };

  function confetti() {
    const box = document.createElement('div');
    box.className = 'confetti';
    const colors = ['#f2541b', '#ffb27d', '#3fd36f', '#f5a524', '#9bbc0f', '#a3245b', '#fff'];
    for (let i = 0; i < 48; i++) {
      const bit = document.createElement('i');
      bit.style.left = `${Math.random() * 100}%`;
      bit.style.background = colors[i % colors.length];
      bit.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
      bit.style.setProperty('--rot', `${(Math.random() - 0.5) * 900}deg`);
      bit.style.animationDelay = `${Math.random() * 0.4}s`;
      box.append(bit);
    }
    document.body.append(box);
    setTimeout(() => box.remove(), 2400);
  }

  function close() {
    run++;
    clearInterval(countdown);
    unmountField();
    root.hidden = true;
    root.innerHTML = '';
    document.body.style.overflow = '';
    onClose?.();
  }

  return {
    get isOpen() {
      return !root.hidden;
    },
    // open() → start at "turn it on"; open({ candidate }) → a TV we already
    // found (nearby banner); open({ tvId, candidate }) → an added, unpaired TV.
    open({ candidate = null, tvId = null, step = null, repair = false } = {}) {
      state = { candidate, tvId, repair };
      root.hidden = false;
      document.body.style.overflow = 'hidden';
      if (step) return go(step, { tv: candidate }); // doctor: straight to the right pairing step
      if (!candidate && !tvId) return go('on');
      // An added TV that's off: wake it first (no pairing needed for that).
      if (tvId && candidate && !candidate.state?.online && candidate.canWake) return go('wake');
      startPair();
    },
    close,
    async handle(el) {
      const action = el.dataset.setup;
      if (action === 'close') return close();
      if (action === 'search') return go('search');
      if (action === 'manual') return go('manual');
      if (action === 'again') return go('on', { candidate: null, tvId: null, tv: null });
      if (action === 'pair') return startPair();
      if (action === 'choose') return startPair({ candidate: state.found[Number(el.dataset.i)], tvId: null });
      if (action === 'pin') return go('pin');
      if (action === 'allow') return go('pair');
      if (action === 'wake') return go('wake');
      if (action === 'finish') {
        const id = state.tv?.id ?? state.tvId;
        close();
        if (id) location.hash = `#/tv/${id}`;
        return;
      }
      if (action === 'room') {
        const room = el.dataset.room;
        const id = state.tv?.id ?? state.tvId;
        if (room && id) {
          try {
            const tv = await api('PATCH', `/tvs/${id}`, { name: room, room });
            onTv(tv);
            state.tv = tv;
          } catch (err) {
            note(err.message, true);
          }
        }
        feedback('success');
        return go('done');
      }
    },
  };
}
