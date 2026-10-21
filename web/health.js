// Health & diagnostics: a report card for every TV. "Simple" says what a
// person needs to know; "Nerd mode" shows every signal Hearth collects. AI
// insights come from the hearth Worker (Gemma 4 on Cloudflare, free) or the
// person's own key, which lives only in this browser and rides along per call.
import { detectProvider } from './vendor/insight-schema.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const AI_KEY = 'hearth.ai';
const NERD_KEY = 'hearth.nerd';
const SEV = { high: 'Fix this', medium: 'Worth fixing', low: 'Good to know', tip: 'Tip', good: 'All good' };
const BRAND = { lg: 'LG', samsung: 'Samsung', roku: 'Roku', androidtv: 'Google TV' };
const LABEL = { responsiveness: 'Responsiveness', reliability: 'Reliability', connection: 'Connection', software: 'Software', wake: 'Wake from sleep', coverage: 'Control coverage' };

export function loadAi() {
  try {
    return { on: true, mode: 'free', ...JSON.parse(localStorage.getItem(AI_KEY) || '{}') };
  } catch {
    return { on: true, mode: 'free' };
  }
}
function saveAi(ai) {
  try {
    localStorage.setItem(AI_KEY, JSON.stringify(ai));
  } catch {}
}
const nerdOn = () => {
  try {
    return localStorage.getItem(NERD_KEY) === '1';
  } catch {
    return false;
  }
};

function ring(score, gradeLetter, size = 64) {
  const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
  const hue = score == null ? 220 : score >= 90 ? 145 : score >= 80 ? 95 : score >= 70 ? 45 : score >= 60 ? 25 : 5;
  return `<span class="h-ring" style="--size:${size}px;--hue:${hue}" aria-label="Grade ${esc(gradeLetter)}, ${score ?? 'no'} score">
    <svg viewBox="0 0 64 64" aria-hidden="true"><circle class="trk" cx="32" cy="32" r="27"/><circle class="lvl" cx="32" cy="32" r="27" pathLength="100" stroke-dasharray="${pct} 100"/></svg>
    <b>${esc(gradeLetter)}</b><small class="mono">${score ?? '–'}</small></span>`;
}

const ms = (x) => (x == null ? '–' : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);
const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
const hours = (msv) => (msv < 3_600_000 ? `${Math.round(msv / 60000)} min` : `${(msv / 3_600_000).toFixed(1)} h`);
const when = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–');

function sparkline(values) {
  if (!values?.length) return '<p class="hint mono">No commands yet.</p>';
  const max = Math.max(...values, 100);
  const w = 300;
  const h = 64;
  const pts = values.map((v, i) => `${((i / Math.max(1, values.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 6) - 3).toFixed(1)}`).join(' ');
  return `<svg class="h-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Latency of the last ${values.length} commands"><polyline points="${pts}"/></svg>
    <p class="h-axis mono"><span>last ${values.length} commands</span><span>max ${ms(Math.max(...values))}</span></p>`;
}

function histogram(values) {
  const buckets = [[0, 50], [50, 100], [100, 200], [200, 400], [400, 800], [800, Infinity]];
  const counts = buckets.map(([a, b]) => values.filter((v) => v >= a && v < b).length);
  const top = Math.max(1, ...counts);
  return `<div class="h-hist">${buckets
    .map(([a, b], i) => `<div><i style="height:${(counts[i] / top) * 100}%"></i><small class="mono">${b === Infinity ? `${a}+` : `<${b}`}</small><b class="mono">${counts[i]}</b></div>`)
    .join('')}</div>`;
}

function timeline(points, since) {
  // 24 h of online/offline as a strip.
  const now = Date.now();
  const from = now - 86_400_000;
  if (!points?.length) return '<p class="hint mono">No history yet.</p>';
  let state = false;
  let at = Math.max(from, since ?? from);
  const segs = [];
  for (const p of points) {
    if (p.t <= at) {
      state = p.v;
      continue;
    }
    segs.push({ a: at, b: p.t, on: state });
    state = p.v;
    at = p.t;
  }
  segs.push({ a: at, b: now, on: state });
  return `<div class="h-strip">${segs
    .map((s) => `<i class="${s.on ? 'on' : ''}" style="left:${((s.a - from) / 86_400_000) * 100}%;width:${((s.b - s.a) / 86_400_000) * 100}%"></i>`)
    .join('')}</div><p class="h-axis mono"><span>24 h ago</span><span>now</span></p>`;
}

const table = (rows) => `<table class="h-table kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td class="mono">${esc(v ?? '–')}</td></tr>`).join('')}</table>`;

export function createHealth({ root, note, haptic, feedback, demo }) {
  let view = 'house';
  let tvId = null;
  let last = null;
  let busy = { diag: false, ai: false };
  let aiError = '';

  async function call(method, path, body, headers = {}) {
    if (demo) return demo.api(method, path, body);
    const init = { method, headers: { ...headers } };
    if (method !== 'GET') {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    const res = await fetch(`api${path}`, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
    return data;
  }

  const aiHeaders = (ai) => (ai.mode === 'byok' && ai.key ? { 'x-hearth-key': ai.key } : {});
  const aiBody = (ai, refresh) => (ai.mode === 'byok' && ai.key ? { provider: ai.provider, model: ai.model, refresh } : { provider: 'edge', refresh });

  function shell(inner) {
    root.innerHTML = `<div class="h-wrap">
      <header class="h-top">
        <button type="button" class="icon-btn" data-press="up" data-h="${view === 'tv' ? 'house' : 'close'}" aria-label="${view === 'tv' ? 'All TVs' : 'Close'}"><svg><use href="#i-left"/></svg></button>
        <h2>${view === 'tv' ? 'TV health' : 'Health'}</h2>
        <label class="h-nerd"><span class="mono">Nerd mode</span><input type="checkbox" data-h="nerd" ${nerdOn() ? 'checked' : ''}></label>
      </header>
      ${inner}
    </div>`;
  }

  // ── Whole house ─────────────────────────────
  async function renderHouse() {
    view = 'house';
    shell('<p class="hint mono">Checking every TV…</p>');
    let list;
    try {
      list = await call('GET', '/report');
    } catch (err) {
      return shell(`<p class="hint">${esc(err.message)}</p>`);
    }
    const scored = list.filter((t) => t.score != null);
    const avg = scored.length ? Math.round(scored.reduce((a, t) => a + t.score, 0) / scored.length) : null;
    const g = avg == null ? '?' : avg >= 90 ? 'A' : avg >= 80 ? 'B' : avg >= 70 ? 'C' : avg >= 60 ? 'D' : 'F';
    shell(`
      <section class="h-hero">
        ${ring(avg, g, 96)}
        <div><p class="kicker mono">The whole house</p><h3>${list.length} TV${list.length === 1 ? '' : 's'}${avg != null ? ` · average ${g}` : ''}</h3>
        <p class="h-sub">${esc(list.filter((t) => t.worst).length ? `${list.filter((t) => t.worst).length} need${list.filter((t) => t.worst).length === 1 ? 's' : ''} attention.` : 'Nothing urgent.')}</p></div>
      </section>
      <div class="h-cards">${list
        .map((t) => `<button type="button" class="h-card" data-press="up" data-h="tv" data-id="${esc(t.id)}">
          ${ring(t.score, t.grade, 58)}
          <span class="h-card-main"><b>${esc(t.name)}</b><small class="mono">${esc(BRAND[t.brand] ?? t.brand)} ${esc(t.model)}${t.online ? '' : ' · off'}</small>
          <span class="h-verdict">${esc(t.verdict)}</span>
          ${t.worst && !String(t.verdict).startsWith(t.worst) ? `<span class="h-chip warn mono">${esc(t.worst)}</span>` : ''}</span>
        </button>`)
        .join('')}</div>
      <button type="button" class="cta h-wide" data-press="up" data-h="diagnose-all">Run diagnostics on every TV</button>
      <p class="h-foot mono">Scores come from what Hearth measures: speed, reliability, connection, software, wake-ups and control. ${loadAi().on ? 'AI notes are written by ' + (loadAi().mode === 'byok' ? 'your own AI key' : 'Gemma 4 on Hearth Cloud') + ' from an anonymised report.' : 'AI notes are off.'}</p>`);
  }

  // ── One TV ──────────────────────────────────
  async function renderTv(fresh = false) {
    view = 'tv';
    if (!last || last.tv.id !== tvId) {
      shell('<p class="hint mono">Reading the TV…</p>');
      try {
        last = await call('GET', `/tvs/${tvId}/health`);
      } catch (err) {
        return shell(`<p class="hint">${esc(err.message)}</p>`);
      }
    }
    paintTv();
    if (fresh || !last.diagnostics) diagnose();
    const ai = loadAi();
    if (ai.on && !last.ai && !busy.ai && !aiError) askAi(false);
  }

  async function diagnose() {
    if (busy.diag) return;
    busy.diag = true;
    paintTv();
    try {
      last = await call('GET', `/tvs/${tvId}/diagnostics`);
    } catch (err) {
      note(err.message, true);
    }
    busy.diag = false;
    if (view === 'tv') paintTv();
  }

  async function askAi(refresh) {
    const ai = loadAi();
    if (!ai.on) return;
    busy.ai = true;
    aiError = '';
    if (view === 'tv') paintTv();
    try {
      last = await call('POST', `/tvs/${tvId}/insights`, aiBody(ai, refresh), aiHeaders(ai));
      feedback?.('success');
    } catch (err) {
      aiError = err.message;
    }
    busy.ai = false;
    if (view === 'tv') paintTv();
  }

  function aiCard(h) {
    const ai = loadAi();
    if (!ai.on) return `<section class="h-ai off"><p class="mono">AI notes are off · <button type="button" class="link" data-press="up" data-h="ai-on">turn on</button></p></section>`;
    if (busy.ai && !h.ai) return `<section class="h-ai loading"><span class="h-dots"><i></i><i></i><i></i></span><p class="mono">${ai.mode === 'byok' ? 'Asking your AI…' : 'Asking Gemma 4 on Hearth Cloud…'}</p></section>`;
    if (aiError && !h.ai) return `<section class="h-ai err"><p>${esc(aiError)}</p><button type="button" class="ghost" data-press="up" data-h="ai-retry">Try again</button></section>`;
    if (!h.ai) return '';
    const i = h.ai.insight;
    return `<section class="h-ai">
      <p class="h-ai-badge mono">AI · ${esc(h.ai.vendor || h.ai.providerLabel || h.ai.provider)}${h.ai.cached ? ' · saved' : ''}</p>
      <h4>${esc(i.headline)}</h4>
      <p>${esc(i.verdict_for_everyone)}</p>
      ${i.top_actions.length ? `<ol class="h-actions">${i.top_actions.map((a) => `<li><b>${esc(a.action)}</b>${a.why ? `<small>${esc(a.why)}</small>` : ''}</li>`).join('')}</ol>` : ''}
      <p class="h-ai-foot mono"><button type="button" class="link" data-press="up" data-h="sent">What’s sent</button> · <button type="button" class="link" data-press="up" data-h="ai-retry">${busy.ai ? 'Thinking…' : 'Ask again'}</button></p>
    </section>`;
  }

  function nerd(h) {
    const t = h.telemetry;
    const d = h.diagnostics;
    const c = t.commands;
    const rows = Object.entries(c.byAction).sort((a, b) => b[1].count - a[1].count).slice(0, 12);
    const i = h.ai?.insight;
    return `<section class="h-nerd-wrap">
      <h4 class="mono">Latency</h4>
      <div class="h-stats mono"><span>p50 <b>${ms(c.p50)}</b></span><span>p95 <b>${ms(c.p95)}</b></span><span>p99 <b>${ms(c.p99)}</b></span><span>max <b>${ms(c.max)}</b></span><span>ok <b>${c.successPct ?? '–'}%</b></span><span>n <b>${c.count}</b></span></div>
      ${sparkline(c.latencies)}
      ${c.latencies.length ? histogram(c.latencies) : ''}
      <h4 class="mono">Commands</h4>
      ${rows.length ? `<table class="h-table"><tr><th>Action</th><th>Count</th><th>OK</th><th>p50</th></tr>${rows.map(([a, s]) => `<tr><td class="mono">${esc(a)}</td><td class="mono">${s.count}</td><td class="mono">${s.ok}</td><td class="mono">${ms(s.p50)}</td></tr>`).join('')}</table>` : '<p class="hint mono">None yet.</p>'}
      ${c.errors.length ? `<h4 class="mono">Errors</h4>${table(c.errors.map((e) => [e.message, `×${e.count}`]))}` : ''}
      <details><summary class="mono">Command log (${c.recent.length})</summary>${table(c.recent.map((x) => [when(x.t), `${x.a} · ${x.ok ? 'ok' : 'fail'} · ${ms(x.ms)}${x.e ? ` · ${x.e}` : ''}`]))}</details>
      <h4 class="mono">Online, last 24 h</h4>
      ${timeline(t.onlineTimeline, t.since)}
      ${table([
        ['Online (24 h)', pct(t.availability.h24)],
        ['Online (7 d)', pct(t.availability.d7)],
        ['Switched on (24 h)', pct(t.availability.onH24)],
        ['Disconnects (24 h)', `${t.connections.downs24h} (${t.connections.unexpectedDrops24h} unexpected)`],
        ['Avg session', t.connections.avgSessionMs ? hours(t.connections.avgSessionMs) : '–'],
        ['Wake-ups', t.wake.attempts ? `${t.wake.ok}/${t.wake.attempts} · avg ${ms(t.wake.avgMs)}` : 'none tried'],
        ['Seen on network', `${t.sightings.count}× ${Object.entries(t.sightings.via).map(([k, v]) => `${k} ${v}`).join(', ')}`],
      ])}
      <h4 class="mono">Screen time</h4>
      ${t.screenTime.length ? `<div class="h-bars">${t.screenTime.map((a) => `<div><span>${esc(a.app)}</span><i style="width:${(a.ms / t.screenTime[0].ms) * 100}%"></i><b class="mono">${hours(a.ms)}</b></div>`).join('')}</div>` : '<p class="hint mono">Nothing tracked yet.</p>'}
      ${table([['Volume avg', t.volume.avg], ['Volume max', t.volume.max], ['Time at 60+', t.volume.highPct == null ? '–' : `${t.volume.highPct}%`], ['Muted', t.volume.mutedPct == null ? '–' : `${t.volume.mutedPct}%`]])}
      ${d ? `
      <h4 class="mono">Network</h4>
      ${table([
        ['Protocol', d.network.protocol],
        ['Link', d.network.type],
        ['Wi-Fi signal', d.network.signalDbm != null ? `${d.network.signalDbm} dBm` : 'not reported'],
        ['Noise / SNR', d.network.noiseDbm != null ? `${d.network.noiseDbm} dBm / ${d.network.snrDb} dB` : '–'],
        ['TCP round trip', d.network.rtt?.ok ? `${d.network.rtt.min}–${d.network.rtt.max} ms, avg ${d.network.rtt.avg}, jitter ${d.network.rtt.jitter}, loss ${d.network.rtt.lossPct}%` : 'no answer'],
        ['Open ports', d.network.openPorts.map((p) => `${p.port} ${p.service}`).join(', ')],
        ['IP', d.identity.ip],
        ['MAC (stored / ARP)', `${(d.identity.macs || []).join(', ') || '–'} / ${d.identity.arpMac ?? '–'}`],
        ['Wake broadcast', d.network.wolBroadcast],
      ])}
      <h4 class="mono">Software</h4>
      ${table([['OS', d.software.os], ['Version', d.software.version], ['Build', d.software.build], ['Update waiting', d.software.updateAvailable == null ? 'unknown' : d.software.updateAvailable ? 'yes' : 'no'], ['Model', d.identity.model], ['Serial', d.identity.serial]])}
      <h4 class="mono">Every signal</h4>
      ${table(Object.entries(d.signals).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v]))}
      <p class="h-axis mono"><span>diagnostics took ${d.tookMs} ms</span><span>${when(d.at)}</span></p>` : '<p class="hint mono">Run diagnostics for network, software and raw signals.</p>'}
      ${i ? `
      <h4 class="mono">AI notes</h4>
      <ul class="h-notes">${i.nerd_notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
      ${table([
        ['Platform', i.model_profile.platform],
        ['Year (AI)', i.model_profile.year],
        ['Device notes', i.model_profile.panel_or_device_notes],
        ['Known issues', i.model_profile.known_issues.join(' · ')],
        ['Privacy', i.model_profile.privacy_settings_to_change.join(' · ')],
        ['Firmware', i.model_profile.firmware_advice],
        ['Grade adjustment', `${i.ai_grade_adjustment.points >= 0 ? '+' : ''}${i.ai_grade_adjustment.points}${i.ai_grade_adjustment.reason ? ` · ${i.ai_grade_adjustment.reason}` : ''}`],
        ['Brain', `${h.ai.providerLabel ?? h.ai.provider} · ${h.ai.model}${h.ai.colo ? ` · ${h.ai.colo}` : ''}`],
        ['Latency', ms(h.ai.ms)],
        ['Tokens in / out', `${h.ai.inTokens ?? '–'} / ${h.ai.outTokens ?? '–'}${h.ai.neurons ? ` · ${h.ai.neurons} neurons` : ''}`],
        ['Cost', h.ai.costUsd != null ? `$${h.ai.costUsd.toFixed(5)} · ${h.ai.billedTo}` : h.ai.billedTo],
      ])}` : ''}
      <details><summary class="mono">Raw JSON</summary><button type="button" class="ghost" data-press="up" data-h="copy">Copy</button><pre class="h-raw mono">${esc(JSON.stringify({ rating: h.rating, telemetry: h.telemetry, diagnostics: h.diagnostics, ai: h.ai }, null, 2))}</pre></details>
    </section>`;
  }

  function paintTv() {
    const h = last;
    if (!h) return;
    const r = h.rating;
    const needs = r.findings.filter((f) => f.severity !== 'tip' && f.severity !== 'good').slice(0, 3);
    const tips = r.findings.filter((f) => f.severity === 'tip' || f.severity === 'good');
    shell(`
      <section class="h-hero">
        ${ring(r.overall, r.grade, 104)}
        <div><p class="kicker mono">${esc(BRAND[h.tv.brand] ?? h.tv.brand)} ${esc(h.diagnostics?.identity.model || h.tv.model)}${r.year ? ` · ${r.year.year}${r.year.source === 'ai' ? ' (AI est.)' : ''}` : ''}</p>
        <h3>${esc(h.tv.name)}</h3><p class="h-sub">${esc(h.ai?.insight.verdict_for_everyone || r.verdict)}</p>
        ${r.aiAdjustment ? `<p class="h-chip mono">AI ${r.aiAdjustment.points > 0 ? '+' : ''}${r.aiAdjustment.points}: ${esc(r.aiAdjustment.reason)}</p>` : ''}</div>
      </section>
      <div class="h-row"><button type="button" class="ghost" data-press="up" data-h="diagnose">${busy.diag ? 'Diagnosing…' : 'Run diagnostics'}</button></div>
      ${aiCard(h)}
      <section class="h-need">
        <h4 class="mono">What you need to know</h4>
        ${needs.length ? needs.map((f) => `<article class="h-find ${f.severity}"><span class="h-sev mono">${SEV[f.severity]}</span><b>${esc(f.title)}</b><p>${esc(f.detail)}</p>${f.fix ? `<p class="h-fix">${esc(f.fix)}</p>` : ''}</article>`).join('') : '<article class="h-find good"><b>Nothing to fix.</b></article>'}
        ${tips.map((f) => `<details class="h-tip"><summary><span class="h-sev mono">${SEV[f.severity]}</span> ${esc(f.title)}</summary><p>${esc(f.detail)}</p>${f.fix ? `<p class="h-fix">${esc(f.fix)}</p>` : ''}</details>`).join('')}
      </section>
      <section class="h-subs">
        <h4 class="mono">Scorecard</h4>
        ${Object.entries(r.sub).map(([k, s]) => `<details class="h-sub-row"><summary><span>${LABEL[k] ?? k}</span><i><em style="width:${s.score ?? 0}%"></em></i><b class="mono">${s.score ?? '–'}</b></summary><ul>${s.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>${s.list ? `<ul class="h-cov">${Object.entries(s.list).map(([n, ok]) => `<li class="${ok ? 'yes' : 'no'}">${ok ? '✓' : '✕'} ${esc(n)}</li>`).join('')}</ul>` : ''}</details>`).join('')}
      </section>
      ${nerdOn() ? nerd(h) : '<p class="h-foot mono">Turn on Nerd mode for latency graphs, logs, ports, firmware and every raw signal.</p>'}
      <dialog class="sheet" id="sentSheet"><div class="sheet-grip"></div><h3>What’s sent</h3>
        <p class="sub">Only this goes to ${loadAi().mode === 'byok' ? 'your AI provider (via Hearth Cloud)' : 'Hearth Cloud (Gemma 4 on Cloudflare)'}: model, software, scores and stats. Never names, addresses, MACs, serials or Wi-Fi names. Your key, if any, is used for that one call and never stored.</p>
        <pre class="h-raw mono">${esc(JSON.stringify(h.aiPayload, null, 2))}</pre>
        <div class="sheet-actions"><button type="button" class="ghost" data-press="up" data-h="ai-off">Turn AI notes off</button><button type="button" class="cta small" data-press="up" data-h="sent-close">Done</button></div></dialog>`);
  }

  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-h]');
    if (!el || el.tagName === 'INPUT') return;
    const a = el.dataset.h;
    haptic?.('tap');
    if (a === 'close') return close();
    if (a === 'house') {
      last = null;
      return renderHouse();
    }
    if (a === 'tv') return openTv(el.dataset.id);
    if (a === 'diagnose') return diagnose();
    if (a === 'diagnose-all') {
      el.textContent = 'Diagnosing…';
      const list = await call('GET', '/report').catch(() => []);
      await Promise.all(list.map((t) => call('GET', `/tvs/${t.id}/diagnostics`).catch(() => null)));
      return renderHouse();
    }
    if (a === 'ai-retry') return askAi(true);
    if (a === 'ai-on' || a === 'ai-off') {
      const ai = loadAi();
      ai.on = a === 'ai-on';
      saveAi(ai);
      root.querySelector('#sentSheet')?.close();
      if (ai.on) askAi(false);
      return paintTv();
    }
    if (a === 'sent') return root.querySelector('#sentSheet')?.showModal();
    if (a === 'sent-close') return root.querySelector('#sentSheet')?.close();
    if (a === 'copy') {
      const text = root.querySelector('.h-raw')?.textContent ?? '';
      await navigator.clipboard?.writeText(text).catch(() => {});
      return note('Copied');
    }
  });
  root.addEventListener('change', (e) => {
    if (e.target.dataset.h !== 'nerd') return;
    try {
      localStorage.setItem(NERD_KEY, e.target.checked ? '1' : '0');
    } catch {}
    haptic?.('press');
    if (view === 'tv') paintTv();
  });

  function open() {
    root.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function close() {
    root.hidden = true;
    root.innerHTML = '';
    document.body.style.overflow = '';
    last = null;
  }
  function openTv(id) {
    open();
    if (id !== tvId) {
      aiError = '';
      last = null;
    }
    tvId = id;
    renderTv(true);
  }

  // ── ⚙ AI settings (rendered into the settings sheet) ──
  function renderAiSettings(host) {
    const ai = loadAi();
    host.innerHTML = `
      <label class="toggle"><span><b>AI health notes</b><small class="mono">Plain-English advice on each TV</small></span><input type="checkbox" id="aiOn" ${ai.on ? 'checked' : ''}></label>
      <div class="ai-mode" ${ai.on ? '' : 'hidden'}>
        <div class="chips">
          <button type="button" class="chip ${ai.mode !== 'byok' ? 'active' : ''}" data-press="up" data-ai="free">Free · Gemma 4</button>
          <button type="button" class="chip ${ai.mode === 'byok' ? 'active' : ''}" data-press="up" data-ai="byok">Your own key</button>
        </div>
        ${ai.mode === 'byok' ? `
          ${ai.key ? `<p class="sub left">Connected: ${esc(ai.label ?? ai.provider)} · key ••••${esc(ai.key.slice(-4))}</p>
            <label class="fields"><span class="mono">Model</span><select id="aiModel">${(ai.models?.length ? ai.models : [ai.model]).map((m) => `<option ${m === ai.model ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
            <div class="sheet-actions"><button type="button" class="danger" data-press="up" data-ai="forget">Remove key</button></div>`
          : `<form class="say" id="aiKeyForm"><input id="aiKey" type="password" autocomplete="off" placeholder="Paste an Anthropic, OpenAI, xAI or Google key"><button type="submit" aria-label="Connect"><svg><use href="#i-plus"/></svg></button></form>
            <p class="sub left" id="aiKeyHint">Stays in this browser. Sent with each request, used once, never stored by Hearth.</p>`}` : '<p class="sub left">Runs on Hearth Cloud (Cloudflare). Sends an anonymised report: no names, addresses or serials.</p>'}
      </div>`;
    host.querySelector('#aiOn').addEventListener('change', (e) => {
      const next = loadAi();
      next.on = e.target.checked;
      saveAi(next);
      renderAiSettings(host);
    });
    host.querySelector('#aiModel')?.addEventListener('change', (e) => {
      const next = loadAi();
      next.model = e.target.value;
      saveAi(next);
    });
    host.querySelectorAll('[data-ai]').forEach((b) =>
      b.addEventListener('click', () => {
        const next = loadAi();
        if (b.dataset.ai === 'free') next.mode = 'free';
        if (b.dataset.ai === 'byok') next.mode = 'byok';
        if (b.dataset.ai === 'forget') {
          delete next.key;
          delete next.models;
          delete next.model;
          next.mode = 'free';
        }
        saveAi(next);
        renderAiSettings(host);
      }),
    );
    host.querySelector('#aiKeyForm')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const hint = host.querySelector('#aiKeyHint');
      const d = detectProvider(host.querySelector('#aiKey').value);
      if (!d.provider) {
        hint.textContent = d.reason || 'Paste a key first.';
        return;
      }
      hint.textContent = 'Checking the key…';
      try {
        const res = await call('POST', '/ai/models', { provider: d.provider }, { 'x-hearth-key': d.key });
        saveAi({ ...loadAi(), mode: 'byok', on: true, key: d.key, provider: res.provider, label: res.label, models: res.models, model: res.suggested });
        feedback?.('success');
        renderAiSettings(host);
      } catch (err) {
        hint.textContent = err.message;
      }
    });
  }

  return {
    openHouse() {
      open();
      renderHouse();
    },
    openTv,
    close,
    renderAiSettings,
    get isOpen() {
      return !root.hidden;
    },
  };
}
