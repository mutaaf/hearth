// The wake coach: "Turn on from your phone", for one TV. It works out how
// this TV can be woken (hub GET /tvs/:id/wake-plan: over the Wi-Fi, through
// the Roku or Apple TV on its HDMI, or not at all), shows the exact settings
// for this model, then tests it for real: switch it off, Hearth turns it on,
// and only a test that worked saves anything. When it doesn't, the AI guide
// for this exact model chips in. An aurora up top tells the story: a signal
// while it looks or waits, the TV when it comes on, an ember when it didn't.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const BRAND = { roku: 'Roku', appletv: 'Apple TV' };

export function createWake({ api, getTv, onSaved = () => {}, feedback = () => {}, track = () => {}, note = () => {} }) {
  let dlg = null;
  let field = null;
  let run = 0;
  let timer = null;
  let st = null; // { id, plan, way, via, ticks:Set, step }

  function mount() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'sheet wake-sheet';
    dlg.id = 'wakeSheet';
    dlg.innerHTML = `
      <div class="sheet-grip"></div>
      <div class="wake-sky" aria-hidden="true"><canvas></canvas><div class="wake-glow"></div></div>
      <div class="wake-body" aria-live="polite"></div>`;
    document.body.append(dlg);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) return dlg.close();
      const b = e.target.closest('[data-wake]');
      if (b) handle(b);
    });
    dlg.addEventListener('close', () => {
      run++;
      clearInterval(timer);
      field?.destroy();
      field = null;
    });
    return dlg;
  }

  // The sky: one aurora for the whole coach, re-shaped as the story moves.
  function sky(shape, palette = 'ember', autonomy = 0.8) {
    dlg.dataset.mood = palette === 'ice' ? 'ice' : shape === 'hearth-flame' ? 'ember-low' : 'ember';
    const AF = window.AuroraField;
    if (!AF || reduced()) return;
    if (!field) {
      try {
        window.HearthShapes?.register(AF);
        const canvas = dlg.querySelector('.wake-sky canvas');
        field = AF.create(canvas, {
          palette, shapes: ['hearth-signal', 'hearth-tv', 'hearth-flame', 'hearth-remote'], initial: shape, cycle: 0, interactive: false,
          count: innerWidth < 500 ? 1100 : 1600, stars: 40, depth: 1.6, container: canvas, maxDpr: 2, fpsFloor: 24,
          radius: (w, h) => Math.min(w, h * 1.9) * 0.34,
        });
      } catch {
        field = null;
        return;
      }
    }
    field.setShape(shape, { pin: true });
    field.set({ palette, autonomy });
  }

  const body = () => dlg.querySelector('.wake-body');
  function paint(html) {
    body().innerHTML = html;
    body().scrollTop = 0;
  }
  const tv = () => getTv(st.id);

  // ── steps ──
  async function open(id, opts = {}) {
    mount();
    run++;
    clearInterval(timer);
    st = { id, plan: null, way: null, via: null, ticks: new Set(), from: opts.from ?? 'settings' };
    if (!dlg.open) dlg.showModal();
    sky('hearth-signal', 'ice', 1);
    paint(`<p class="wake-kicker mono">Turn on from your phone</p><h3>Checking ${esc(tv()?.name ?? 'your TV')}…</h3><p class="wake-say">Looking at the model and what else is in the house.</p>`);
    track('wake_coach', { step: 'open', from: st.from, brand: tv()?.brand ?? '' });
    const mine = run;
    try {
      st.plan = await api('GET', `/tvs/${id}/wake-plan`);
    } catch (err) {
      if (mine !== run) return;
      paint(`<h3>Couldn’t check it</h3><p class="wake-say">${esc(err.message)}</p><div class="sheet-actions"><span></span><button type="button" class="cta small" data-press="up" data-wake="close">Close</button></div>`);
      return;
    }
    if (mine !== run) return;
    st.via = st.plan.box?.via ?? null;
    plan();
  }

  function plan() {
    const p = st.plan;
    st.step = 'plan';
    const linked = p.box?.via && p.box.boxes.find((b) => b.id === p.box.via);
    sky(p.way === 'remote' ? 'hearth-remote' : p.way === 'box' ? 'hearth-tv' : 'hearth-signal', p.way === 'remote' ? 'ice' : 'ember', 0.7);
    const option = (way, title, text, rec) => `
      <button type="button" class="wake-way${rec ? ' rec' : ''}" data-press="up" data-wake="way" data-way="${way}">
        ${rec ? '<span class="wake-rec mono">Best for this TV</span>' : ''}
        <b>${esc(title)}</b><small>${esc(text)}</small>
      </button>`;
    const ways = [];
    if (p.network.possible) ways.push(option('network', p.network.auto ? 'Already set up' : 'Over the Wi-Fi', p.network.auto ? p.network.why : 'Switch on one setting with the TV’s own remote, then test it. About a minute.', p.way === 'network'));
    if (p.box.possible) ways.push(option('box', linked ? `Through ${linked.name}` : 'Through your Roku or Apple TV', linked ? 'Linked. Test it, or pick a different box.' : `${p.box.why} ${p.box.boxes.length === 1 ? p.box.boxes[0].name : `${p.box.boxes.length} boxes`} in your house.`, p.way === 'box'));
    paint(`
      <p class="wake-kicker mono">${esc(p.family)}${p.model ? ` · ${esc(p.model)}` : ''}</p>
      <h3>${esc(p.headline)}</h3>
      <p class="wake-say">${esc(p.why)}</p>
      ${ways.length ? `<div class="wake-ways">${ways.join('')}</div>` : `
        <ul class="checklist">
          <li><i>🔘</i><span>Use the TV’s own remote to switch it on. Hearth takes over the moment it’s on.</span></li>
          ${p.box.possible === false && !p.box.boxes?.length && p.box.why !== 'This is the box itself.' ? `<li><i>📺</i><span>${esc(p.box.why)}</span></li>` : ''}
        </ul>`}
      <div class="sheet-actions">
        <button type="button" class="ghost" data-press="up" data-wake="ai">✨ Ask AI about my ${esc(p.model || 'TV')}</button>
        ${ways.length ? '' : '<button type="button" class="cta small" data-press="up" data-wake="close">Got it</button>'}
      </div>`);
  }

  function setupNetwork() {
    const n = st.plan.network;
    st.way = 'network';
    st.step = 'setup';
    if (n.auto && !n.steps?.length) return test();
    sky('hearth-signal', 'ember', 0.8);
    paint(`
      <p class="wake-kicker mono">Step 1 of 2 · on the TV</p>
      <h3>${n.auto ? 'Nearly there' : 'One setting on the TV'}</h3>
      <p class="wake-say">${n.auto ? esc(n.why) + ' Check these too:' : 'With the TV on, open its settings with its own remote:'}</p>
      ${checklist(n.steps)}
      <div class="sheet-actions">
        <button type="button" class="ghost" data-press="up" data-wake="back">Back</button>
        <button type="button" class="cta small" data-press="up" data-wake="test">Done, test it</button>
      </div>`);
  }

  function setupBox() {
    const b = st.plan.box;
    st.way = 'box';
    st.step = 'setup';
    if (!st.via && b.boxes.length === 1) st.via = b.boxes[0].id;
    if (!st.via) return pickBox();
    const box = b.boxes.find((x) => x.id === st.via);
    sky('hearth-tv', 'ember', 0.8);
    paint(`
      <p class="wake-kicker mono">Step 1 of 2 · ${esc(box.name)} → ${esc(st.plan.name)}</p>
      <h3>Let the box turn the TV on</h3>
      <p class="wake-say">Plug ${esc(box.name)} into one of the TV’s HDMI ports, then switch these on. They let the box wake the TV over the HDMI cable.</p>
      ${checklist([b.tvStep, ...(b.boxSteps[box.brand] ?? [])])}
      <p class="wake-small mono">${esc(b.note)}</p>
      <div class="sheet-actions">
        <button type="button" class="ghost" data-press="up" data-wake="${b.boxes.length > 1 ? 'pick' : 'back'}">${b.boxes.length > 1 ? 'Other box' : 'Back'}</button>
        <button type="button" class="cta small" data-press="up" data-wake="test">Done, test it</button>
      </div>`);
  }

  function pickBox() {
    const b = st.plan.box;
    st.step = 'pick';
    sky('hearth-tv', 'ember', 0.9);
    paint(`
      <p class="wake-kicker mono">Through a box</p>
      <h3>Which one is plugged into ${esc(st.plan.name)}?</h3>
      <div class="wake-ways">${b.boxes
        .map((x) => `<button type="button" class="wake-way${x.id === st.via ? ' rec' : ''}" data-press="up" data-wake="box" data-id="${esc(x.id)}"><b>${esc(x.name)}</b><small>${esc([BRAND[x.brand], x.room].filter(Boolean).join(' · '))}</small></button>`)
        .join('')}</div>
      <div class="sheet-actions"><button type="button" class="ghost" data-press="up" data-wake="back">Back</button><span></span></div>`);
  }

  function checklist(steps = []) {
    return `<ol class="wake-steps">${steps
      .map((s, i) => `<li><button type="button" class="${st.ticks.has(i) ? 'done' : ''}" data-press="up" data-wake="tick" data-i="${i}" aria-pressed="${st.ticks.has(i)}"><span class="wake-n">${i + 1}</span><span><b>${esc(s.title)}</b><small>${esc(s.path)}</small></span></button></li>`)
      .join('')}</ol>`;
  }

  // Test: wait for the TV to be off, then Hearth turns it on and watches.
  const isAwake = (t) => Boolean(t?.state?.online && (t.state.power === 'on' || t.state.power === 'unknown'));
  function test() {
    st.step = 'test';
    clearInterval(timer);
    const name = esc(st.plan.name);
    const waiting = () => {
      sky('hearth-signal', 'ice', 1);
      paint(`
        <p class="wake-kicker mono">Step 2 of 2 · the test</p>
        <h3>Switch ${name} off</h3>
        <p class="wake-say">Use its own remote. As soon as it’s off, Hearth turns it back on${st.way === 'box' ? ' through the box' : ''}.</p>
        <p class="wake-wait mono"><span class="wake-dot"></span> Waiting for it to switch off…</p>
        <div class="sheet-actions">
          <button type="button" class="ghost" data-press="up" data-wake="back">Back</button>
          <button type="button" class="cta small" data-press="up" data-wake="go">It’s off</button>
        </div>`);
    };
    if (!isAwake(tv())) return go();
    waiting();
    const mine = run;
    let offFor = 0;
    timer = setInterval(() => {
      if (mine !== run || st.step !== 'test') return clearInterval(timer);
      offFor = isAwake(tv()) ? 0 : offFor + 1;
      if (offFor >= 3) go(); // off (or standby) for ~3 s
    }, 1000);
  }

  async function go() {
    clearInterval(timer);
    st.step = 'running';
    const mine = ++run;
    const t0 = Date.now();
    sky('hearth-signal', 'ice', 1);
    paint(`
      <p class="wake-kicker mono">The test</p>
      <h3>Turning ${esc(st.plan.name)} on…</h3>
      <p class="wake-say">${st.way === 'box' ? 'Waking the box; the TV should follow.' : 'Calling it over the Wi-Fi.'} This can take up to 30 seconds.</p>
      <p class="wake-wait mono"><span class="wake-dot"></span> <span class="wake-secs">0 s</span></p>`);
    timer = setInterval(() => {
      const el = body().querySelector('.wake-secs');
      if (el) el.textContent = `${Math.round((Date.now() - t0) / 1000)} s`;
    }, 1000);
    let res;
    try {
      res = await api('POST', `/tvs/${st.id}/wake-test`, st.way === 'box' ? { via: st.via } : {});
    } catch (err) {
      res = { ok: false, reason: 'error', error: err.message };
    }
    clearInterval(timer);
    if (mine !== run) return;
    track('wake_coach', { step: 'test', way: st.way, ok: res.ok, reason: res.reason ?? '', secs: res.ms ? Math.round(res.ms / 1000) : null });
    if (res.reason === 'already-on') return test();
    return res.ok ? worked(res) : failed(res);
  }

  async function worked(res) {
    st.step = 'worked';
    feedback('success');
    sky('hearth-tv', 'ember', 0.5);
    let saved = '';
    if (st.way === 'box' && st.via !== (tv()?.wakeVia ?? null)) {
      try {
        const t = await api('PATCH', `/tvs/${st.id}`, { wakeVia: st.via });
        onSaved(t);
        track('wake_via_set', { how: 'coach', on: true });
      } catch (err) {
        note(err.message, true);
      }
    }
    if (st.way === 'network' && tv()?.wakeVia) {
      try {
        onSaved(await api('PATCH', `/tvs/${st.id}`, { wakeVia: null }));
      } catch {}
    }
    const box = st.plan.box?.boxes?.find((b) => b.id === st.via);
    saved = st.way === 'box' ? `From now on, any button for ${esc(st.plan.name)} wakes it through ${esc(box?.name ?? 'the box')}.` : `From now on, any button for ${esc(st.plan.name)} wakes it.`;
    paint(`
      <p class="wake-kicker mono">It worked</p>
      <h3>${esc(st.plan.name)} came on in ${Math.max(1, Math.round(res.ms / 1000))} s</h3>
      <p class="wake-say">${saved}</p>
      <div class="sheet-actions"><span></span><button type="button" class="cta small" data-press="up" data-wake="close">Done</button></div>`);
  }

  function failed(res) {
    st.step = 'failed';
    feedback('error');
    sky('hearth-flame', 'ember', 0.35);
    const other = st.way === 'network' ? st.plan.box.possible && 'box' : st.plan.network.possible && 'network';
    paint(`
      <p class="wake-kicker mono">Not yet</p>
      <h3>${esc(st.plan.name)} didn’t come on</h3>
      <p class="wake-say">${res.error ? esc(res.error) : st.way === 'box' ? 'The box didn’t bring it on. Usually one of the HDMI settings is still off, or the box is powered by the TV.' : 'It didn’t answer. Usually the setting is still off, or the TV went into a deeper sleep.'}</p>
      <div class="wake-ai" id="wakeAi"><p class="wake-wait mono"><span class="wake-dot"></span> Asking the AI about the ${esc(st.plan.model || 'TV')}…</p></div>
      <div class="sheet-actions">
        ${other ? `<button type="button" class="ghost" data-press="up" data-wake="way" data-way="${other}">${other === 'box' ? 'Try a box' : 'Try Wi-Fi'}</button>` : '<span></span>'}
        <button type="button" class="cta small" data-press="up" data-wake="${st.way === 'box' ? 'setupbox' : 'setupnet'}">Check and retry</button>
      </div>`);
    ai(true);
  }

  // The AI guide for this exact model, wont-wake first (free tier; nothing
  // personal is sent: brand, model and which step failed).
  async function ai(inline) {
    const mine = run;
    if (!inline) {
      st.step = 'ai';
      sky('hearth-signal', 'ice', 1);
      paint(`<p class="wake-kicker mono">Hearth AI</p><h3>${esc(st.plan.model || st.plan.family)}</h3><div class="wake-ai" id="wakeAi"><p class="wake-wait mono"><span class="wake-dot"></span> Thinking about this exact model…</p></div><div class="sheet-actions"><button type="button" class="ghost" data-press="up" data-wake="back">Back</button><span></span></div>`);
    }
    track('wake_coach', { step: 'ai', inline });
    let out;
    try {
      out = await api('POST', '/guide', { tvId: st.id, symptom: { when: 'wont-wake', error: { box: 'Tried waking it through a streaming box on its HDMI (HDMI-CEC); it did not come on.', network: 'Tried Wake-on-LAN from the phone; it did not come on.' }[st.way] ?? '' }, ai: true });
    } catch (err) {
      out = { aiError: err.message };
    }
    if (mine !== run) return;
    const g = out.guide;
    const fixes = (g?.troubleshoot ?? []).filter((f) => f.when === 'wont-wake').map((f) => f.fix);
    const keep = (g?.keepReachable ?? []).map((k) => `${k.title}: ${k.path}`);
    const lines = [...new Set([...fixes, ...keep])].slice(0, 4);
    const host = dlg.querySelector('#wakeAi');
    if (!host) return;
    if (!inline) sky('hearth-tv', 'ember', 0.7);
    host.innerHTML = lines.length
      ? `<p class="wake-ai-head mono">${out.ai ? `✨ AI · ${out.ai.cached ? 'saved answer' : 'just now'}${out.ai.confidence ? ` · ${esc(out.ai.confidence)} confidence` : ''}` : '📖 Built-in guide'}</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>${out.aiError ? `<p class="wake-small mono">${esc(out.aiError)}</p>` : ''}`
      : `<p class="wake-small mono">${esc(out.aiError ?? 'No more tips for this model.')}</p>`;
  }

  function handle(b) {
    const a = b.dataset.wake;
    if (a === 'close') return dlg.close();
    if (a === 'way') return b.dataset.way === 'box' ? setupBox() : setupNetwork();
    if (a === 'setupbox') return setupBox();
    if (a === 'setupnet') return setupNetwork();
    if (a === 'pick') return pickBox();
    if (a === 'box') {
      st.via = b.dataset.id;
      feedback('tick');
      return setupBox();
    }
    if (a === 'tick') {
      const i = Number(b.dataset.i);
      st.ticks.has(i) ? st.ticks.delete(i) : st.ticks.add(i);
      b.classList.toggle('done', st.ticks.has(i));
      b.setAttribute('aria-pressed', String(st.ticks.has(i)));
      feedback('tick');
      return;
    }
    if (a === 'test') return test();
    if (a === 'go') return go();
    if (a === 'ai') return ai(false);
    if (a === 'back') {
      run++;
      clearInterval(timer);
      st.ticks.clear();
      return plan();
    }
  }

  return { open, isOpen: () => Boolean(dlg?.open) };
}
