// "Share this house": a family member's phone gets every TV already paired,
// with no Allow prompts or codes. Two sides in one sheet, with the wake
// coach's night-glass sky (wake.css) telling the story:
//
//   give()  Settings → Share this house: what goes, how it's kept safe, then
//           POST /handoff/create → a QR code, Share and Copy. The hub seals the
//           TVs and scenes before anything leaves; the key is only in the link.
//   join()  Settings → Join a house, setup's "Joining someone's house?", or a
//           link (#house=… / hearth://join#…): scan their code or paste the
//           link → POST /handoff/open shows what comes over and what it would
//           change → POST /handoff/accept → the TVs it got.
//
// The page never sees a pairing key: the hub answers with names, rooms,
// brands and a status per TV. Analytics: `share_house` {step, tvs}, counts only.
import { canShare, copy, smsHref } from './native.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const BRAND = { lg: 'LG', samsung: 'Samsung', roku: 'Roku', androidtv: 'Google TV', appletv: 'Apple TV' };
const INVITE = /([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;
const DEMO_INVITE = /join#demo\b/;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const inviteIn = (text) => INVITE.exec(String(text ?? ''))?.[0] ?? (DEMO_INVITE.test(String(text ?? '')) ? 'demo' : null);

export function createShare({ api, getTvs = () => [], onTvs = () => {}, feedback = () => {}, track = () => {}, note = () => {} }) {
  let dlg = null;
  let field = null;
  let run = 0;
  let cam = null; // { stream, timer }
  let st = {};

  function mount() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'sheet wake-sheet share-sheet';
    dlg.id = 'shareSheet';
    dlg.innerHTML = `
      <div class="sheet-grip"></div>
      <div class="wake-sky" aria-hidden="true"><canvas></canvas><div class="wake-glow"></div></div>
      <div class="wake-body share-body" aria-live="polite"></div>`;
    document.body.append(dlg);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) return dlg.close();
      const b = e.target.closest('[data-share]');
      if (b) handle(b);
    });
    dlg.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = dlg.querySelector('#sharePaste')?.value ?? '';
      if (inviteIn(text)) return opening(text, 'paste');
      feedback('error');
      note('That isn’t a Hearth invite. It starts with https://mutaafaziz.com/hearth/join#', true);
    });
    dlg.addEventListener('close', () => {
      run++;
      stopCamera();
      field?.destroy();
      field = null;
      // An opened invite nobody brought over: let the hub forget it.
      if (st.token && st.step !== 'done') api('POST', '/handoff/forget', { token: st.token }).catch(() => {});
      if (st.step && st.step !== 'done' && st.step !== 'made') track('share_house', { step: `${st.side}_close`, at: st.step, tvs: st.count ?? 0 });
    });
    return dlg;
  }

  function sky(shape, palette = 'ember', autonomy = 0.8) {
    dlg.dataset.mood = palette === 'ice' ? 'ice' : shape === 'hearth-flame' ? 'ember-low' : 'ember';
    const AF = window.AuroraField;
    if (!AF || reduced()) return;
    if (!field) {
      try {
        window.HearthShapes?.register(AF);
        const canvas = dlg.querySelector('.wake-sky canvas');
        field = AF.create(canvas, {
          palette, shapes: ['hearth-house', 'hearth-signal', 'hearth-tv', 'hearth-flame'], initial: shape, cycle: 0, interactive: false,
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

  const body = () => dlg.querySelector('.share-body');
  function paint(html, step) {
    st.step = step;
    body().innerHTML = html;
    body().scrollTop = 0;
  }
  function show(side) {
    mount();
    run++;
    stopCamera();
    st = { side };
    if (!dlg.open) dlg.showModal();
  }
  const paired = () => getTvs().filter((t) => t.paired);

  // ── give: Settings → Share this house ──
  function give() {
    show('give');
    const tvs = paired();
    st.count = tvs.length;
    track('share_house', { step: 'give_open', tvs: tvs.length });
    if (!tvs.length) {
      sky('hearth-tv', 'ice', 0.8);
      return paint(`
        <p class="wake-kicker mono">Share this house</p>
        <h3>Connect a TV first</h3>
        <p class="wake-say">Once a TV works from this phone, you can hand it to everyone in the family in one go.</p>
        <div class="sheet-actions"><span></span><button type="button" class="cta small" data-press="up" data-share="close">Got it</button></div>`, 'empty');
    }
    sky('hearth-house', 'ember', 0.7);
    paint(`
      <p class="wake-kicker mono">Share this house</p>
      <h3>Give someone every TV, already connected</h3>
      <p class="wake-say">Their phone gets ${tvs.length === 1 ? 'this TV' : `these ${tvs.length} TVs`} and your scenes. Nobody presses Allow or types a code.</p>
      <ul class="share-tvs">${tvs.map((t) => `<li><b>${esc(t.name)}</b><small class="mono">${esc([BRAND[t.brand], t.room].filter(Boolean).join(' · '))}</small></li>`).join('')}</ul>
      <ul class="checklist share-promise">
        <li><i>🔒</i><span>Locked on this phone with a one-time key. The key is only in the invite link.</span></li>
        <li><i>⏳</i><span>Hearth’s server holds a scrambled copy it can’t read, for 24 hours or until it’s opened once. Then it’s deleted.</span></li>
        <li><i>👪</i><span>Whoever opens the link can use these TVs. Send it to family only.</span></li>
      </ul>
      <div class="sheet-actions">
        <button type="button" class="ghost" data-press="up" data-share="close">Not now</button>
        <button type="button" class="cta small" data-press="up" data-share="make">Make the invite</button>
      </div>`, 'intro');
  }

  async function make() {
    const mine = ++run;
    sky('hearth-signal', 'ice', 1);
    paint(`
      <p class="wake-kicker mono">Share this house</p>
      <h3>Locking it up…</h3>
      <p class="wake-wait mono"><span class="wake-dot"></span> Sealing ${plural(st.count, 'TV')} on this phone</p>`, 'making');
    let out;
    try {
      out = await api('POST', '/handoff/create', {});
    } catch (err) {
      if (mine !== run) return;
      track('share_house', { step: 'give_error', tvs: st.count });
      return oops('Couldn’t make the invite', err.message, 'make');
    }
    if (mine !== run) return;
    st.made = out;
    feedback('success');
    track('share_house', { step: 'made', tvs: out.tvs });
    made();
  }

  function made() {
    const out = st.made;
    const until = out.expires ? new Date(out.expires) : null;
    const when = until && !isNaN(until) ? until.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'tomorrow';
    sky('hearth-tv', 'ember', 0.5);
    paint(`
      <p class="wake-kicker mono">Invite ready · works once · until ${esc(when)}</p>
      <h3>Scan this with their phone</h3>
      <div class="share-qr">${out.qr ?? ''}</div>
      <p class="wake-say share-how">Their iPhone camera opens it. No Hearth yet? The page helps them get it. Already have it? Settings → <b>Join a house</b>.</p>
      <div class="share-send">
        ${canShare() ? '<button type="button" class="cta small" data-press="up" data-share="send">Send the link</button>' : `<a class="cta small" href="${esc(smsHref(message()))}" data-share="sms">Send with Messages</a>`}
        <button type="button" class="ghost" data-press="up" data-share="copy">Copy link</button>
      </div>
      <p class="wake-small mono">${plural(out.tvs, 'TV')}${out.scenes ? ` · ${plural(out.scenes, 'scene')}` : ''} · the server only ever has the scrambled copy</p>
      <div class="sheet-actions"><span></span><button type="button" class="cta small" data-press="up" data-share="close">Done</button></div>`, 'made');
  }

  const message = () => `Here are the TVs in our house for Hearth. Open this on your phone (it works once, for 24 hours): ${st.made?.link ?? ''}`;

  // ── join: scan their code, or paste their link ──
  function join({ invite = null, how = 'settings' } = {}) {
    show('join');
    track('share_house', { step: 'join_open', how, tvs: 0 });
    if (invite) return opening(invite, 'link');
    scan();
  }

  function scan() {
    run++;
    stopCamera();
    sky('hearth-signal', 'ice', 1);
    const demo = Boolean(window.HearthDemo);
    const camOk = !demo && Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext !== false;
    paint(`
      <p class="wake-kicker mono">Join a house</p>
      <h3>Scan their code</h3>
      <p class="wake-say">On their phone: Settings → <b>Share this house</b>. Point this phone at the code.</p>
      ${demo ? '<div class="share-send share-demo"><button type="button" class="cta small" data-press="up" data-share="pretend">Open a pretend invite</button></div>' : ''}
      ${demo ? '' : camOk ? '<div class="share-cam"><video playsinline muted></video><i class="share-cam-frame" aria-hidden="true"></i><p class="share-cam-say mono">Starting the camera…</p></div>' : '<p class="wake-small mono share-nocam">No camera here. Open the iPhone Camera and point it at their code, or paste the link they sent.</p>'}
      <form class="share-paste">
        <label class="mono" for="sharePaste">Or paste the link they sent</label>
        <div><input id="sharePaste" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://mutaafaziz.com/hearth/join#…"><button type="submit" class="cta small" data-press="up">Open</button></div>
      </form>
      <div class="sheet-actions"><button type="button" class="ghost" data-press="up" data-share="close">Cancel</button><span></span></div>`, 'scan');
    if (camOk) startCamera();
  }

  async function loadDecoder() {
    if (window.jsQR) return window.jsQR;
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/jsqr.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.append(s);
    });
    return window.jsQR;
  }

  async function startCamera() {
    const mine = run;
    const say = (t) => {
      const el = dlg.querySelector('.share-cam-say');
      if (el) el.textContent = t;
    };
    let stream;
    try {
      const [decode, s] = await Promise.all([loadDecoder(), navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })]);
      stream = s;
      if (mine !== run) return stream.getTracks().forEach((t) => t.stop());
      const video = dlg.querySelector('.share-cam video');
      video.srcObject = stream;
      await video.play().catch(() => {});
      say('Point it at their code');
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      cam = { stream, timer: setInterval(() => {
        if (mine !== run || !video.videoWidth) return;
        const w = Math.min(640, video.videoWidth);
        const h = Math.round((video.videoHeight / video.videoWidth) * w);
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const code = decode(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (!code?.data) return;
        if (inviteIn(code.data)) {
          feedback('tick');
          opening(code.data, 'scan');
        } else say('That code isn’t a Hearth invite');
      }, 220) };
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop());
      if (mine !== run) return;
      const box = dlg.querySelector('.share-cam');
      if (box) box.outerHTML = `<p class="wake-small mono share-nocam">${err?.name === 'NotAllowedError' ? 'Hearth can’t use the camera. Allow it in Settings → Hearth → Camera, or' : 'The camera isn’t available here.'} Open the iPhone Camera and point it at their code, or paste the link they sent.</p>`;
    }
  }

  function stopCamera() {
    if (!cam) return;
    clearInterval(cam.timer);
    cam.stream.getTracks().forEach((t) => t.stop());
    cam = null;
  }

  async function opening(text, how) {
    stopCamera();
    const mine = ++run;
    sky('hearth-signal', 'ice', 1);
    paint(`
      <p class="wake-kicker mono">Join a house</p>
      <h3>Opening the invite…</h3>
      <p class="wake-wait mono"><span class="wake-dot"></span> Fetching it and unlocking it on this phone</p>`, 'opening');
    let out;
    try {
      out = await api('POST', '/handoff/open', { invite: String(text).trim() });
    } catch (err) {
      if (mine !== run) return;
      track('share_house', { step: 'join_error', how, status: err.status ?? 0, tvs: 0 });
      return oops('That invite didn’t open', err.message, 'scan');
    }
    if (mine !== run) return;
    st.token = out.token;
    st.preview = out;
    st.count = out.tvs.length;
    st.replace = new Set();
    // New TVs come along unless there's no room for all of them.
    const fresh = out.tvs.filter((t) => t.status === 'new');
    st.only = new Set([...out.tvs.filter((t) => t.status !== 'new').map((t) => t.ref), ...fresh.slice(0, out.room ?? Infinity).map((t) => t.ref)]);
    feedback('success');
    track('share_house', { step: 'preview', how, tvs: out.tvs.length, fresh: fresh.length });
    preview();
  }

  const LINE = {
    new: () => 'New here · comes connected',
    adopt: (t) => `You have it as “${esc(t.as)}” · gets their pairing`,
    same: (t) => `Already here as “${esc(t.as)}” ✓`,
    have: (t) => `You have it connected as “${esc(t.as)}” · keeping yours`,
    replace: (t) => `You have it as “${esc(t.as)}” · switching to theirs`,
    skip: (t) => (t.reason === 'unsupported' ? 'This Hearth can’t drive this one yet' : 'Left out'),
  };

  function preview() {
    const p = st.preview;
    const fresh = p.tvs.filter((t) => t.status === 'new');
    const room = p.room ?? null;
    const picked = fresh.filter((t) => st.only.has(t.ref)).length;
    const row = (t) => {
      const status = t.status === 'new' && !st.only.has(t.ref) ? 'skip' : t.status === 'have' && st.replace.has(t.ref) ? 'replace' : t.status;
      const pick = t.status === 'new' ? `<button type="button" class="share-pick${st.only.has(t.ref) ? ' on' : ''}" data-press="up" data-share="pick" data-ref="${esc(t.ref)}" aria-pressed="${st.only.has(t.ref)}"><span class="sr-only">Bring ${esc(t.name)}</span></button>` : '';
      const swap = t.status === 'have' ? `<button type="button" class="chip" data-press="up" data-share="swap" data-ref="${esc(t.ref)}">${st.replace.has(t.ref) ? 'Keep mine' : 'Use theirs'}</button>` : '';
      return `<li class="share-row st-${status}">${pick}<span><b>${esc(t.name)}</b><small class="mono">${esc([BRAND[t.brand] ?? t.brand, t.room].filter(Boolean).join(' · '))}</small><small>${LINE[status]?.(t) ?? ''}</small></span>${swap}</li>`;
    };
    const roomLine =
      room !== null && fresh.length > room
        ? `<p class="share-room">This Hearth has room for ${room === 0 ? 'no more TVs' : plural(room, 'more TV')}. Pick ${room === 0 ? 'none, or' : 'which ones, or'} bring them all and Hearth offers room for more. TVs you bring count like any TV you add.</p>`
        : '';
    const doing = picked + p.tvs.filter((t) => t.status === 'adopt' || (t.status === 'have' && st.replace.has(t.ref))).length;
    sky('hearth-house', 'ember', 0.7);
    paint(`
      <p class="wake-kicker mono">Join a house · ${plural(p.tvs.length, 'TV')}${p.scenes ? ` · ${plural(p.scenes, 'scene')}` : ''}</p>
      <h3>${fresh.length ? `${plural(fresh.length, 'TV')} to bring over` : 'You have these already'}</h3>
      <ul class="share-list">${p.tvs.map(row).join('')}</ul>
      ${roomLine}
      ${p.scenes ? '<p class="wake-small mono">Their scenes come too, for the TVs you bring. Scenes you already have stay as they are.</p>' : ''}
      <div class="sheet-actions">
        <button type="button" class="ghost" data-press="up" data-share="close">Cancel</button>
        <button type="button" class="cta small" data-press="up" data-share="accept"${doing || p.scenes ? '' : ' disabled'}>${doing ? `Bring ${doing === 1 ? 'it' : 'them'} over` : p.scenes ? 'Just the scenes' : 'Nothing to bring'}</button>
      </div>`, 'preview');
  }

  async function accept() {
    const mine = ++run;
    const only = [...st.only];
    sky('hearth-signal', 'ice', 1);
    paint(`
      <p class="wake-kicker mono">Join a house</p>
      <h3>Connecting…</h3>
      <p class="wake-wait mono"><span class="wake-dot"></span> Adding the TVs with their pairing</p>`, 'accepting');
    let out;
    try {
      out = await api('POST', '/handoff/accept', { token: st.token, only, replace: [...st.replace] });
    } catch (err) {
      if (mine !== run) return;
      track('share_house', { step: 'join_error', at: 'accept', status: err.status ?? 0, tvs: st.count });
      if (err.status === 402) {
        note(err.message, true);
        return preview();
      }
      return oops('Couldn’t bring them over', err.message, err.status === 410 ? 'scan' : 'preview');
    }
    if (mine !== run) return;
    st.step = 'done';
    st.token = null;
    onTvs([...out.added, ...out.updated]);
    feedback('success');
    track('share_house', { step: 'joined', tvs: out.added.length + out.updated.length, kept: out.kept.length, scenes: out.scenes });
    done(out);
  }

  function done(out) {
    const got = [...out.added, ...out.updated];
    sky('hearth-tv', 'ember', 0.5);
    paint(`
      <p class="wake-kicker mono">You’re in</p>
      <h3>${got.length ? `${plural(got.length, 'TV')} ready, no codes` : 'Nothing new to add'}</h3>
      <ul class="share-list">${got.map((t) => `<li class="share-row st-got"><i aria-hidden="true">✓</i><span><b>${esc(t.name)}</b><small class="mono">${esc([BRAND[t.brand], t.room].filter(Boolean).join(' · '))}</small></span></li>`).join('')}
      ${out.kept.map((t) => `<li class="share-row st-same"><i aria-hidden="true">·</i><span><b>${esc(t.name)}</b><small>Already here, left as it was</small></span></li>`).join('')}</ul>
      ${out.scenes ? `<p class="wake-say">${plural(out.scenes, 'scene')} came along too.</p>` : ''}
      ${out.skipped.some((s) => s.reason === 'unsupported') ? '<p class="wake-small mono">Some TVs need a newer Hearth on this phone.</p>' : ''}
      <div class="sheet-actions"><span></span><button type="button" class="cta small" data-press="up" data-share="finish">Open the remote</button></div>`, 'done');
  }

  function oops(title, why, back) {
    feedback('error');
    sky('hearth-flame', 'ember', 0.35);
    paint(`
      <p class="wake-kicker mono">Not yet</p>
      <h3>${esc(title)}</h3>
      <p class="wake-say">${esc(why)}</p>
      <div class="sheet-actions">
        <button type="button" class="ghost" data-press="up" data-share="close">Close</button>
        <button type="button" class="cta small" data-press="up" data-share="${back}">Try again</button>
      </div>`, 'error');
  }

  async function handle(b) {
    const a = b.dataset.share;
    if (a === 'close') return dlg.close();
    if (a === 'make') return make();
    if (a === 'scan') return scan();
    if (a === 'pretend') return opening('https://mutaafaziz.com/hearth/join#demo', 'demo');
    if (a === 'preview') return preview();
    if (a === 'accept') return accept();
    if (a === 'finish') {
      dlg.close();
      location.hash = '#/';
      return;
    }
    if (a === 'pick') {
      const ref = b.dataset.ref;
      st.only.has(ref) ? st.only.delete(ref) : st.only.add(ref);
      feedback('tick');
      return preview();
    }
    if (a === 'swap') {
      const ref = b.dataset.ref;
      st.replace.has(ref) ? st.replace.delete(ref) : st.replace.add(ref);
      feedback('tick');
      return preview();
    }
    if (a === 'copy') {
      const ok = await copy(st.made?.link ?? '');
      track('share_house', { step: 'copy', tvs: st.made?.tvs ?? 0 });
      return note(ok ? 'Link copied. Send it to family only.' : 'Couldn’t copy. Press and hold to share instead.', ok ? 'success' : true);
    }
    if (a === 'sms') return track('share_house', { step: 'send', how: 'sms', tvs: st.made?.tvs ?? 0 });
    if (a === 'send') {
      track('share_house', { step: 'send', how: 'sheet', tvs: st.made?.tvs ?? 0 });
      try {
        await navigator.share({ title: 'Our TVs, for Hearth', text: message() });
      } catch {}
    }
  }

  return { give, join, isOpen: () => Boolean(dlg?.open) };
}
