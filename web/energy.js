// What your TVs cost. A utility meter for the house: the aluminium disc spins
// as fast as the TVs that are on right now draw power, the odometer shows a
// month of TV, and each TV gets its own bill line and a fortnight of days.
//
// The power bill: a PDF is read *on this phone* (pdf.js) and only the lines
// with money and kWh leave it (src/bill-schema.js chargeLines, shown to the
// person first); a photo is cropped by the person to the charges box. Hearth
// Cloud's AI (or their own key) turns that into a price per kWh, and Hearth
// keeps only the numbers.
import { BILL_LIMITS, chargeLines } from './vendor/bill-schema.js';
import { loadAi } from './health.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const CENTS = new Set(['USD', 'CAD', 'AUD', 'NZD', 'EUR']);
const PDF_PAGES = 6;

export function createEnergy({ root, api, note, haptic, feedback, demo, getTvs }) {
  let report = null;
  let step = 'report'; // report | pick | review | crop | reading | type
  let pending = null; // { lines } or { image, preview }
  let crop = null;
  let error = '';

  const money = (n, digits = 2) => {
    const cur = report?.price.currency ?? 'USD';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
    } catch {
      return `${n.toFixed(digits)} ${cur}`;
    }
  };
  const perKwh = (p, cur = report?.price.currency) => (CENTS.has(cur) ? `${(p * 100).toFixed(p < 0.1 ? 2 : 1)}${cur === 'EUR' ? ' c' : '¢'}` : money(p, 3));

  // ── Live draw: the TVs that are on right now ──
  function drawingNow() {
    if (!report) return 0;
    const live = getTvs();
    return report.tvs.reduce((w, r) => {
      const t = live.get(r.id);
      const on = t?.state?.online && t.state.power === 'on';
      return w + (on ? r.watts.on : r.watts.standby);
    }, 0);
  }

  // The meter disc: one turn per "Kh" of energy, like the real thing.
  function disc(watts) {
    const secs = watts > 0 ? Math.max(0.7, Math.min(14, 400 / watts)) : 0;
    return `<div class="en-meter" aria-hidden="true">
      <div class="en-glass"><div class="en-plate">
        <span class="en-brand mono">HEARTH · TV METER</span>
        <div class="en-disc" style="--rev:${secs || 1}s;--play:${secs ? 'running' : 'paused'}"><i></i></div>
        <span class="en-kh mono">Kh 1.0 · 240V · 60~</span>
      </div></div>
    </div>`;
  }

  // Odometer: each digit is a drum that rolls to its value.
  function odometer(value) {
    const s = money(value, value >= 100 ? 0 : 2);
    return `<span class="en-odo" aria-label="${esc(s)}">${[...s]
      .map((ch, i) => (/\d/.test(ch)
        ? `<span class="en-drum" aria-hidden="true" style="--d:${ch};--i:${i}"><span>${'0123456789'.split('').map((n) => `<b>${n}</b>`).join('')}</span></span>`
        : `<span class="en-sep" aria-hidden="true">${esc(ch)}</span>`))
      .join('')}</span>`;
  }

  function bars(daily) {
    if (!daily?.length) return '';
    const top = Math.max(...daily.map((d) => d.cost), 0.01);
    return `<div class="en-bars" role="img" aria-label="Cost per day, last ${daily.length} days">${daily
      .map((d) => `<i style="--h:${Math.max(3, (d.cost / top) * 100)}%" title="${esc(d.day)}: ${esc(money(d.cost))} · ${d.onH} h on"></i>`)
      .join('')}</div>`;
  }

  // ── The report ──
  function paintReport() {
    const r = report;
    const h = r.house;
    const w = Math.round(drawingNow());
    const src = r.price.source;
    const b = r.bill;
    const ai = loadAi();
    const priceLine = src === 'bill'
      ? `From your bill${b?.end ? ` ending ${new Date(`${b.end}T12:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}`
      : src === 'manual' ? 'You typed it' : 'US average · add your bill for your real price';
    const young = h.trackedH < 48;
    root.innerHTML = `<div class="en-wrap">
      <header class="h-top">
        <button type="button" class="icon-btn" data-press="up" data-en="close" aria-label="Close"><svg><use href="#i-left"/></svg></button>
        <h2>What your TVs cost</h2><span></span>
      </header>

      <section class="en-hero">
        ${disc(w)}
        <div class="en-total">
          <p class="kicker mono">Every TV, a month</p>
          ${odometer(h.perMonth)}
          <p class="en-sub mono">${esc(money(h.perYear, 0))} a year · ${h.kwhPerMonth} kWh a month${h.shareOfBill != null ? ` · <b>${h.shareOfBill}%</b> of your bill` : ''}</p>
          <p class="en-live mono"><span class="en-dot ${w > 5 ? 'on' : ''}"></span>${w > 5 ? `Drawing ${w} W right now` : `Resting · ${w} W in standby`}</p>
        </div>
      </section>

      <section class="en-price ${src === 'bill' ? 'from-bill' : ''}">
        <div class="en-rate"><b class="mono">${esc(perKwh(r.price.pricePerKwh))}</b><small class="mono">per kWh</small></div>
        <div class="en-rate-meta">
          <p>${esc(priceLine)}</p>
          ${b ? `<p class="mono en-fine">${[b.total ? money(b.total) : null, b.kwh ? `${b.kwh.toLocaleString()} kWh` : null, b.days ? `${b.days} days` : null, b.fixed ? `${money(b.fixed)} fixed` : null].filter(Boolean).join(' · ')}</p>
            ${b.note ? `<p class="en-fine">${esc(b.note)}</p>` : ''}
            <p class="mono en-fine">${b.confidence === 'high' ? 'Read clearly' : b.confidence === 'low' ? 'A rough read: check it' : 'Partly worked out'}${b.via ? ` · ${esc(b.via.replace(/^@cf\/[\w-]+\//, ''))}` : ''}</p>` : ''}
        </div>
        <div class="en-price-actions">
          ${ai.on ? `<button type="button" class="cta small" data-press="up" data-en="add">${b ? 'New bill' : '⚡ Add your power bill'}</button>` : ''}
          <button type="button" class="ghost small" data-press="up" data-en="type">Type it</button>
          ${src !== 'default' ? '<button type="button" class="ghost small" data-press="confirm" data-en="forget"><span class="charge" aria-hidden="true"></span>Hold to forget</button>' : ''}
        </div>
      </section>

      <section class="en-list">
        ${r.tvs
          .slice()
          .sort((a, b2) => b2.perMonth - a.perMonth)
          .map((t) => `<article class="en-tv" data-brand="${esc(t.brand)}">
            <header>
              <div><h3>${esc(t.name)}</h3><p class="mono en-fine">${esc(t.watts.basis)} · ${t.watts.on} W on · ${t.watts.standby} W asleep${t.watts.yours ? ' · your numbers' : ''}</p></div>
              <div class="en-tv-cost"><b>${esc(money(t.perMonth))}</b><small class="mono">a month</small></div>
            </header>
            ${bars(t.daily)}
            <p class="mono en-fine en-tv-foot"><span>${t.onHPerDay} h on a day</span><span>${esc(money(t.perYear, 0))} a year</span><span>${esc(money(t.standbyPerYear))} of that asleep</span></p>
            <details class="en-watts"><summary class="mono">Know its real watts?</summary>
              <form data-watts="${esc(t.id)}">
                <label><small class="mono">On (W)</small><input name="onW" inputmode="decimal" value="${t.watts.yours ? t.watts.on : ''}" placeholder="${t.watts.estimate.on}"></label>
                <label><small class="mono">Asleep (W)</small><input name="standbyW" inputmode="decimal" value="${t.watts.yours ? t.watts.standby : ''}" placeholder="${t.watts.estimate.standby}"></label>
                <button type="submit" class="cta small">Save</button>
              </form>
              <p class="en-fine">It's on the sticker on the back, or the yellow EnergyGuide label. Leave blank for Hearth's estimate.</p>
            </details>
          </article>`)
          .join('')}
      </section>

      <p class="en-fine en-honest">${young ? `Hearth has watched these TVs for ${Math.round(h.trackedH)} hours, so a month is a guess from that. It firms up over a week.` : `From ${Math.round(h.trackedH / 24)} days of what the TVs actually did.`} Watts are estimated from each model's screen size and year unless you set them. Your bill never leaves this phone whole and isn't kept: only the price per kWh and its totals are.</p>
    </div>`;
  }

  // ── Adding a bill ──
  function sheet(inner, title = 'Your power bill') {
    root.innerHTML = `<div class="en-wrap">
      <header class="h-top">
        <button type="button" class="icon-btn" data-press="up" data-en="back" aria-label="Back"><svg><use href="#i-left"/></svg></button>
        <h2>${esc(title)}</h2><span></span>
      </header>
      ${error ? `<p class="en-error" role="alert">${esc(error)}</p>` : ''}
      ${inner}
    </div>`;
  }

  function paintPick() {
    sheet(`<section class="en-pick">
      <label class="en-drop">
        <input type="file" accept="application/pdf,.pdf" data-en-file="pdf" hidden>
        <span class="en-ico" aria-hidden="true">📄</span><b>The PDF from your electric company</b>
        <small>Best. Read on this phone; only the lines with prices and kWh are sent.</small>
      </label>
      <label class="en-drop">
        <input type="file" accept="image/*" capture="environment" data-en-file="photo" hidden>
        <span class="en-ico" aria-hidden="true">📷</span><b>A photo of a paper bill</b>
        <small>Then drag a box around just the charges. Your name and address stay out of it.</small>
      </label>
      <p class="en-fine">Read by ${esc(aiName())}. Hearth keeps the price per kWh and the bill's totals, never the bill.</p>
    </section>`);
  }

  function paintReview() {
    const { lines } = pending;
    sheet(`<section class="en-review">
      <p class="en-lead"><b>Only these ${lines.length} lines leave your home.</b> Names, addresses and account numbers were left out on this phone.</p>
      <ol class="en-lines mono">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
      <div class="sheet-actions">
        <button type="button" class="ghost" data-press="up" data-en="add">Pick another</button>
        <button type="button" class="cta" data-press="up" data-en="send">Read it with AI</button>
      </div>
    </section>`, 'Check what we send');
  }

  function paintCrop() {
    sheet(`<section class="en-crop">
      <p class="en-lead"><b>Drag a box around the charges</b>: the part with kWh and the amounts. Leave your name and address outside it.</p>
      <div class="en-stage" id="enStage"><img src="${pending.preview}" alt="Your bill" draggable="false"><div class="en-box" id="enBox"><i></i><i></i><i></i><i></i></div></div>
      <div class="sheet-actions">
        <button type="button" class="ghost" data-press="up" data-en="add">Another photo</button>
        <button type="button" class="cta" data-press="up" data-en="send-crop">Read this part</button>
      </div>
    </section>`, 'Just the charges');
    const stage = root.querySelector('#enStage');
    const box = root.querySelector('#enBox');
    crop = crop ?? { x: 0.06, y: 0.35, w: 0.88, h: 0.4 };
    const place = () => Object.assign(box.style, { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` });
    place();
    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      const r = stage.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const inside = x > crop.x && x < crop.x + crop.w && y > crop.y && y < crop.y + crop.h;
      drag = inside ? { mode: 'move', x, y, start: { ...crop } } : { mode: 'draw', x, y };
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {}
      e.preventDefault();
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = stage.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      if (drag.mode === 'move') {
        crop.x = Math.max(0, Math.min(1 - crop.w, drag.start.x + x - drag.x));
        crop.y = Math.max(0, Math.min(1 - crop.h, drag.start.y + y - drag.y));
      } else {
        crop = { x: Math.min(x, drag.x), y: Math.min(y, drag.y), w: Math.max(0.05, Math.abs(x - drag.x)), h: Math.max(0.04, Math.abs(y - drag.y)) };
      }
      place();
    });
    const end = () => {
      if (drag) haptic?.('tick');
      drag = null;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }

  function paintReading() {
    sheet(`<section class="en-reading">
      ${disc(900)}
      <p class="en-lead"><b>Reading your bill…</b></p>
      <p class="en-fine mono">${esc(aiName())} · usually 5–20 s</p>
    </section>`, 'Your power bill');
  }

  function paintType() {
    const p = report.price;
    sheet(`<section class="en-type">
      <p class="en-lead">What does one kWh cost you, all in? Divide the bill's electricity total by its kWh for a good number.</p>
      <form class="en-type-form" data-en-form="price">
        <input name="price" inputmode="decimal" autocomplete="off" placeholder="${CENTS.has(p.currency) ? (p.pricePerKwh * 100).toFixed(1) : p.pricePerKwh}" aria-label="Price per kWh">
        <span class="mono">${CENTS.has(p.currency) ? '¢ per kWh' : `${esc(p.currency)} per kWh`}</span>
        <button type="submit" class="cta">Use it</button>
      </form>
    </section>`, 'Price per kWh');
    root.querySelector('input[name=price]')?.focus();
  }

  function aiName() {
    const ai = loadAi();
    return ai.mode === 'byok' && ai.key ? `your ${ai.provider ?? 'AI'} key` : 'Hearth Cloud (free, Gemma on Cloudflare)';
  }

  function paint() {
    if (step === 'report') return paintReport();
    if (step === 'pick') return paintPick();
    if (step === 'review') return paintReview();
    if (step === 'crop') return paintCrop();
    if (step === 'reading') return paintReading();
    if (step === 'type') return paintType();
  }

  // ── Reading files on the phone ──
  async function readPdf(file) {
    const pdfjs = await import('./vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
    } catch (err) {
      throw new Error(/password/i.test(err?.name + err?.message) ? 'That PDF is locked with a password. Download it again without one, or take a photo.' : 'Couldn’t open that PDF.');
    }
    const text = [];
    for (let n = 1; n <= Math.min(doc.numPages, PDF_PAGES); n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      // Rebuild lines: group text pieces by their baseline, left to right.
      const rows = new Map();
      for (const it of tc.items) {
        if (!it.str?.trim()) continue;
        const y = Math.round(it.transform[5] / 3) * 3;
        (rows.get(y) ?? rows.set(y, []).get(y)).push({ x: it.transform[4], s: it.str });
      }
      for (const y of [...rows.keys()].sort((a, b) => b - a)) text.push(rows.get(y).sort((a, b) => a.x - b.x).map((p) => p.s).join(' '));
    }
    const lines = chargeLines(text.join('\n'));
    if (lines.length >= 2) return { lines };
    // A scanned PDF has no text: show page 1 as a picture and crop it.
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return { preview: canvas.toDataURL('image/jpeg', 0.9) };
  }

  function readPhoto(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve({ preview: r.result });
      r.onerror = () => reject(new Error('Couldn’t read that photo.'));
      r.readAsDataURL(file);
    });
  }

  // Cut the box out, at most 1600 px on the long side, as a JPEG under the cap.
  async function cropped() {
    const img = new Image();
    img.src = pending.preview;
    await img.decode();
    const sx = crop.x * img.naturalWidth;
    const sy = crop.y * img.naturalHeight;
    const sw = crop.w * img.naturalWidth;
    const sh = crop.h * img.naturalHeight;
    const scale = Math.min(1, 1600 / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    for (const q of [0.85, 0.7, 0.55]) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (url.length * 0.75 < BILL_LIMITS.imageBytes) return url;
    }
    throw new Error('That part is too big to send. Draw a smaller box.');
  }

  async function onFile(input) {
    const file = input.files?.[0];
    if (!file) return;
    error = '';
    try {
      const got = input.dataset.enFile === 'pdf' || /pdf/i.test(file.type) ? await readPdf(file) : await readPhoto(file);
      pending = got;
      crop = null;
      step = got.lines ? 'review' : 'crop';
      haptic?.('tap');
    } catch (err) {
      error = err.message;
      feedback?.('error');
    }
    paint();
  }

  async function send(body) {
    const prev = step;
    step = 'reading';
    paint();
    const ai = loadAi();
    const byok = ai.mode === 'byok' && ai.key;
    try {
      const full = { ...body, provider: byok ? ai.provider : 'edge', ...(byok && ai.model ? { model: ai.model } : {}) };
      const res = demo ? await demo.api('POST', '/energy/bill', full, byok ? { 'x-hearth-key': ai.key } : {}) : await fetchBill(full, byok ? ai.key : '');
      report = res;
      pending = null;
      step = 'report';
      error = '';
      feedback?.('success');
      note(`${perKwh(res.price.pricePerKwh, res.price.currency)} per kWh, from your bill`);
      paint();
      root.querySelector('.en-price')?.classList.add('fresh');
    } catch (err) {
      error = err.message;
      step = prev;
      feedback?.('error');
      paint();
    }
  }

  // The bill can be big (a photo) and slow (the AI): its own fetch, with the
  // key header only when the person uses their own key.
  async function fetchBill(body, key) {
    let res;
    try {
      res = await fetch('api/energy/bill', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { 'x-hearth-key': key } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout?.(100_000),
      });
    } catch {
      throw new Error('Couldn’t reach Hearth. Try again.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
    return data;
  }

  async function load() {
    report = await api('GET', '/energy');
  }

  // ── Events ──
  root.addEventListener('change', (e) => {
    if (e.target.matches('[data-en-file]')) onFile(e.target);
  });
  root.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    try {
      if (form.dataset.enForm === 'price') {
        const raw = String(new FormData(form).get('price') ?? '').replace(',', '.');
        const n = Number.parseFloat(raw);
        if (!Number.isFinite(n)) throw new Error('Type a number, like 15.2');
        const cents = CENTS.has(report.price.currency);
        report = await api('PUT', '/energy/price', { pricePerKwh: cents ? n / 100 : n, currency: report.price.currency });
        step = 'report';
        error = '';
        feedback?.('success');
        paint();
      } else if (form.dataset.watts) {
        const fd = new FormData(form);
        const val = (k) => (String(fd.get(k) ?? '').trim() === '' ? null : Number.parseFloat(String(fd.get(k)).replace(',', '.')));
        report = await api('PATCH', `/energy/tvs/${form.dataset.watts}`, { onW: val('onW'), standbyW: val('standbyW') });
        feedback?.('success');
        paint();
      }
    } catch (err) {
      error = err.message;
      if (step === 'report') note(err.message, true);
      else paint();
      feedback?.('error');
    }
  });

  async function handle(el) {
    const a = el.dataset.en;
    if (a === 'close') return close();
    haptic?.('tap');
    if (a === 'back') {
      error = '';
      step = step === 'review' || step === 'crop' ? 'pick' : 'report';
      return paint();
    }
    if (a === 'add') {
      error = '';
      step = 'pick';
      return paint();
    }
    if (a === 'type') {
      error = '';
      step = 'type';
      return paint();
    }
    if (a === 'send') return send({ lines: pending.lines });
    if (a === 'send-crop') {
      try {
        return send({ image: await cropped() });
      } catch (err) {
        error = err.message;
        return paint();
      }
    }
    if (a === 'forget') {
      report = await api('DELETE', '/energy/bill');
      note('Back to the average price');
      return paint();
    }
  }

  function close() {
    root.hidden = true;
    root.innerHTML = '';
    document.body.style.overflow = '';
    step = 'report';
    pending = null;
  }

  return {
    async open() {
      root.hidden = false;
      document.body.style.overflow = 'hidden';
      step = 'report';
      root.innerHTML = '<div class="en-wrap"><p class="hint mono">Reading the meter…</p></div>';
      try {
        await load();
        paint();
      } catch (err) {
        close();
        note(err.message, true);
      }
    },
    handle,
    // A TV changed: the disc follows what's on (only on the report).
    live() {
      if (root.hidden || step !== 'report' || !report) return;
      const w = Math.round(drawingNow());
      const d = root.querySelector('.en-disc');
      if (d) {
        const secs = w > 0 ? Math.max(0.7, Math.min(14, 400 / w)) : 0;
        d.style.setProperty('--rev', `${secs || 1}s`);
        d.style.setProperty('--play', secs ? 'running' : 'paused');
      }
      const l = root.querySelector('.en-live');
      if (l) l.innerHTML = `<span class="en-dot ${w > 5 ? 'on' : ''}"></span>${w > 5 ? `Drawing ${w} W right now` : `Resting · ${w} W in standby`}`;
    },
  };
}
