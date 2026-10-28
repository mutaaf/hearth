// The setup wizard: so easy a caveman can do it. One sentence and one giant
// button per screen. Open it and it's already looking; it keeps looking until
// a TV turns up (no "it's on" tap, no "try again" dead end) → press Allow on
// the TV's remote → tap a room → done. If nothing turns up, the fixes appear
// right there while it keeps looking.
import { feedback, haptic } from './feel.js';
import { track } from './analytics.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const brandName = (b) => ({ lg: 'LG', samsung: 'Samsung', roku: 'Roku', androidtv: 'Google TV', appletv: 'Apple TV' })[b] ?? 'TV';
const DOTS = ['search', 'pair', 'name', 'done'];
// Steps that sit under another step's progress dot.
const DOT_OF = { pick: 'search', none: 'search', manual: 'search', pairfail: 'pair', wake: 'search', lgchoose: 'pair', pin: 'pair' };
const PAIR_SECONDS = 60;
// Searching: a scan every few seconds; the fixes show up after HINT_AFTER,
// and after GIVE_UP it stops (battery) and says so.
const LOOK_EVERY = 2500;
const HINT_AFTER = 12_000;
const GIVE_UP = 180_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOMS = [
  ['🛋️', 'Living Room'], ['🛏️', 'Bedroom'], ['🧸', 'Kids’ Room'], ['🍳', 'Kitchen'],
  ['💻', 'Office'], ['🎮', 'Basement'], ['🏋️', 'Gym'], ['🏡', 'Den'],
];

export function createSetup({ root, api, onTv, onClose, note, guide = null }) {
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
    track('setup_step', { step, brand: state.candidate?.brand ?? state.tv?.brand ?? '', repair: Boolean(state.repair) });
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
          <li><i>⚙️</i><span>To make waking work next time, turn on <b>Turn on via Wi-Fi</b> (LG) or <b>Power On with Mobile</b> (Samsung 2017 and newer) in the TV’s settings.</span></li>
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

    async search() {
      const app = Boolean(window.HearthHost?.native);
      frame('search', `
        <div class="setup-art"><div class="field-art"></div></div>
        <h2 id="searchTitle">Turn on your TV.</h2>
        <p class="say-it" id="searchSub">Hearth is looking for it. Nothing to tap.</p>
        <ul class="checklist" id="searchHint" hidden>
          <li><i>📺</i><span>Is the TV <b>on</b>, with a picture? (Standby doesn’t count.)</span></li>
          <li><i>📶</i><span>Is this ${app ? 'phone' : 'device'} on the <b>same Wi-Fi</b> as the TV? Not the guest network.</span></li>
          ${app
            ? `<li><i>🔓</i><span>Hearth needs <b>Local Network</b> to see your TVs. Missed the question?
                 <button type="button" class="inline-btn" data-press="up" data-setup="settings">Open Settings</button> and turn it on.</span></li>`
            : '<li><i>💻</i><span>Is the computer running Hearth on that Wi-Fi too?</span></li>'}
        </ul>
        <div class="setup-actions">
          <button type="button" class="ghost" data-press="up" data-setup="manual">Type the TV’s number instead</button>
        </div>`);
      mountField('mind');
      const mine = run;
      const t0 = Date.now();
      let seen = 0; // TVs that answered but are already added
      while (mine === run) {
        const found = await api('POST', '/scan').catch(() => []);
        if (mine !== run) return;
        const fresh = found.filter((t) => !t.added);
        seen = found.length - fresh.length;
        if (fresh.length === 1) {
          const tv = fresh[0];
          field?.setShape('hearth-tv', { pin: true });
          feedback('success');
          root.querySelector('#searchTitle').textContent = `Found it!`;
          root.querySelector('#searchSub').innerHTML = `<b>${esc(tv.name)}</b> · ${brandName(tv.brand)} ${esc(tv.model)}`;
          root.querySelector('#searchHint').hidden = true;
          await sleep(1400);
          return mine === run && startPair({ candidate: tv, tvId: null });
        }
        if (fresh.length > 1) {
          field?.setShape('hearth-house', { pin: true });
          feedback('success');
          await sleep(900);
          return mine === run && go('pick', { found: fresh });
        }
        const waited = Date.now() - t0;
        if (waited > GIVE_UP) return go('none', { allAdded: seen > 0 });
        if (waited > HINT_AFTER) {
          root.querySelector('#searchHint').hidden = false;
          // A TV that's off (or in standby) isn't on the network to be found.
          // Ask for it to be switched on once; from then on the phone wakes it.
          root.querySelector('#searchTitle').textContent = 'Turn it on with its own remote.';
          root.querySelector('#searchSub').textContent = seen
            ? 'Your other TVs are here already. Switch the new one on and Hearth adds it the moment it wakes. After today, your phone turns it on.'
            : 'Switched-off TVs hide from Wi-Fi. Turn it on once and Hearth adds it the moment it wakes. After today, your phone turns it on.';
        }
        await sleep(LOOK_EVERY);
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
        }</p>
        <div id="pairGuide"></div>`);
      // We know this model? Say exactly what to expect on its screen.
      if (guide && tv?.brand && tv?.model) {
        guide.lookup({ brand: tv.brand, model: tv.model }).then((res) => {
          const host = mine === run && root.querySelector('#pairGuide');
          if (host && res?.guide) host.innerHTML = guide.card(res.guide, { compact: true });
        });
      }
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
          ? 'On the Apple TV: Settings → AirPlay and HomeKit → Allow Access → <b>Anyone on the Same Network</b>.'
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
        </div>
        ${guide ? `<div class="setup-help">
          <button type="button" class="chip" data-press="up" data-setup="guide">How to fix my ${esc(brandName(brand))}</button>
          <button type="button" class="chip" data-press="up" data-setup="report">Still stuck? Send it to us</button>
        </div>` : ''}`);
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
        <p class="say-it"><b>${esc(tv?.name)}</b> is on your remote now.${window.HearthHost ? '' : ' Every phone on your Wi-Fi can use it.'}</p>
        <div id="wakeTip"></div>
        <div class="setup-actions">
          <button type="button" class="cta" data-press="up" data-setup="finish">Open the remote</button>
          <button type="button" class="ghost" data-press="up" data-setup="again">Add another TV</button>
        </div>`);
      mountField('hearth-tv');
      confetti();
      // Phone app: now's the moment to ask about notifications (a TV left on
      // late at night, scheduled scenes). iOS asks only once.
      setTimeout(() => window.HearthHost?.askNotifications?.(), 1800);
      // So the phone can turn it on next time: the one setting that makes
      // waking work, for this exact model. (LG switches its own on: Hearth
      // sets it when it connects.)
      const mine = run;
      const tip = (html) => {
        const el = mine === run && root.querySelector('#wakeTip');
        if (el) el.innerHTML = `<p class="say-it wake-tip">⚡ ${html}</p>`;
      };
      const WAKE_SETTING = {
        samsung: [/power on|mobile/i, 'Settings → General → Network → Expert Settings → Power On with Mobile'],
        lg: [/wi-?fi|mobile|quick start/i, 'Settings → General → Devices → TV Management → Turn on via Wi-Fi'],
      };
      const ws = WAKE_SETTING[tv?.brand];
      if (ws && (tv.brand === 'samsung' || tv.state?.wakeOnLan === false)) {
        const say = (path) => tip(`One more thing so your phone can turn it on: <b>${esc(path)}</b> → On.`);
        if (guide && tv.model) {
          guide.lookup({ brand: tv.brand, model: tv.model }).then((res) => {
            const kept = res?.guide?.keepReachable ?? [];
            // Some sets (2016 Samsungs) can't be woken at all: say so plainly.
            const none = kept.find((x) => x.wake === false);
            if (none) return tip(esc(none.path));
            say(kept.find((x) => ws[0].test(`${x.title} ${x.path}`))?.path ?? ws[1]);
          });
        } else say(ws[1]);
      } else if (tv && tv.brand !== 'androidtv') {
        tip('Your phone can turn it on from now on: press any button.');
      }
    },

    none() {
      frame('none', `
        <h2>${state.allAdded ? 'All your TVs are already here.' : 'No TV answered yet.'}</h2>
        <ul class="checklist">
          <li><i>📺</i><span>Is the TV <b>on</b>, with a picture? (Standby doesn’t count.)</span></li>
          <li><i>📶</i><span>Is this phone on the <b>same Wi-Fi</b> as the TV? Not the guest network.</span></li>
          ${window.HearthHost?.native
            ? '<li><i>🔓</i><span>Is <b>Local Network</b> on for Hearth? <button type="button" class="inline-btn" data-press="up" data-setup="settings">Open Settings</button></span></li>'
            : '<li><i>💻</i><span>Is the computer running Hearth on that Wi-Fi too?</span></li>'}
        </ul>
        <div class="setup-actions">
          <button type="button" class="cta" data-press="up" data-setup="search">Look again</button>
          <button type="button" class="ghost" data-press="up" data-setup="manual">Type the TV’s number instead</button>
        </div>
        ${guide ? '<div class="setup-help"><button type="button" class="chip" data-press="up" data-setup="report">Still can’t find it? Send it to us</button></div>' : ''}`);
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
    // open() → start looking; open({ candidate }) → a TV we already
    // found (nearby banner); open({ tvId, candidate }) → an added, unpaired TV.
    open({ candidate = null, tvId = null, step = null, repair = false } = {}) {
      state = { candidate, tvId, repair };
      root.hidden = false;
      document.body.style.overflow = 'hidden';
      if (step) return go(step, { tv: candidate }); // doctor: straight to the right pairing step
      if (!candidate && !tvId) return go('search');
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
      if (action === 'settings') return window.HearthHost?.openSettings?.();
      if (action === 'guide' || action === 'report') {
        const tv = state.tv ?? state.candidate;
        const err = String(state.error ?? '');
        const when = state.step === 'none' ? 'not-found' : /refus|denied|reject|403|401/i.test(err) ? 'refused' : /time|prompt|408|allow/i.test(err) ? 'no-prompt' : 'other';
        const ctx = {
          tvId: state.tvId ?? undefined,
          device: tv?.brand ? { brand: tv.brand, model: tv.model ?? '' } : undefined,
          name: tv?.name,
          symptom: { when, steps: [{ step: state.step === 'none' ? 'search' : 'pair', status: 'fail', detail: err }], error: err },
        };
        return action === 'guide' ? guide?.open(ctx) : guide?.report(ctx);
      }
      if (action === 'again') return go('search', { candidate: null, tvId: null, tv: null });
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
