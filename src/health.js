// The TV report card. Deterministic and explainable: every sub-score comes
// with the evidence behind it, and works with no AI at all. The AI layer
// (src/llm.js) only adds a narrative and a small, bounded grade adjustment.

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round = (x) => (x == null ? null : Math.round(x));

// ── Model year: only where the naming scheme is certain ──
const SAMSUNG_LETTER = { J: 2015, K: 2016, M: 2017, N: 2018, R: 2019, T: 2020, A: 2021, B: 2022, C: 2023, D: 2024, F: 2025 };
const LG_SERIES = { UH: 2016, UJ: 2017, UK: 2018, UM: 2019, UN: 2020, UP: 2021, UQ: 2022, UR: 2023, UT: 2024, UA: 2025 };
const LG_OLED = { 6: 2016, 7: 2017, 8: 2018, 9: 2019, X: 2020, 1: 2021, 2: 2022, 3: 2023, 4: 2024, 5: 2025 };

export function modelYear(brand, model) {
  const m = String(model ?? '').toUpperCase().replace(/\s+/g, '');
  if (!m) return null;
  if (brand === 'samsung') {
    // QLED/Neo: QN55Q60AAF → year letter after the series number.
    let x = m.match(/^QN\d{2}(?:Q|QN|LS)\d{2,3}([A-Z])/);
    if (x && SAMSUNG_LETTER[x[1]]) return { year: SAMSUNG_LETTER[x[1]], source: 'model code' };
    // LED: UN55KU6290 / UN43TU7000 / UN55AU8000 → letter after the size.
    x = m.match(/^(?:UN|UE|GU|HG)\d{2}([A-Z])/);
    if (x && SAMSUNG_LETTER[x[1]]) return { year: SAMSUNG_LETTER[x[1]], source: 'model code' };
    return null;
  }
  if (brand === 'lg') {
    let x = m.match(/^OLED\d{2}[A-Z]([0-9X])/);
    if (x && LG_OLED[x[1]]) return { year: LG_OLED[x[1]], source: 'model code' };
    x = m.match(/^\d{2}NANO\d{2}([A-Z]{2})/) || m.match(/^\d{2}([A-Z]{2})\d/);
    if (x && LG_SERIES[x[1]]) return { year: LG_SERIES[x[1]], source: 'model code' };
    return null;
  }
  return null;
}

// ── Sub-scores ───────────────────────────────
function responsiveness(t, d) {
  const p50 = t?.commands?.p50;
  if (p50 != null && t.commands.samples >= 3) {
    const s = p50 <= 60 ? 100 : clamp(100 - (Math.log(p50 / 60) / Math.log(800 / 60)) * 80, 20);
    return { score: round(s), evidence: [`Median ${p50} ms, p95 ${t.commands.p95} ms over ${t.commands.samples} commands`] };
  }
  const rtt = d?.network?.rtt;
  if (rtt?.avg != null) {
    const s = clamp(100 - Math.max(0, rtt.avg - 20) * 0.6, 30);
    return { score: round(s), evidence: [`Network round trip ${rtt.avg} ms (no command history yet)`] };
  }
  return { score: null, evidence: ['Not enough commands yet'] };
}

function reliability(t) {
  const pct = t?.commands?.successPct;
  const drops = t?.connections?.unexpectedDrops24h ?? 0;
  if (pct == null && !t?.connections?.sessions) return { score: null, evidence: ['Not enough history yet'] };
  const base = pct ?? 100;
  const s = clamp(base - drops * 8);
  const ev = [];
  if (pct != null) ev.push(`${pct}% of ${t.commands.count} commands succeeded`);
  ev.push(drops ? `${drops} unexpected disconnect${drops > 1 ? 's' : ''} in 24 h` : 'No unexpected disconnects in 24 h');
  return { score: round(s), evidence: ev };
}

function wake(t, view) {
  const w = t?.wake;
  if (w?.attempts) {
    const speed = w.avgMs == null ? 0 : w.avgMs < 10_000 ? 20 : w.avgMs < 30_000 ? 10 : 0;
    return { score: round(clamp(w.successPct * 0.8 + speed)), evidence: [`${w.ok}/${w.attempts} wake-ups worked${w.avgMs ? `, ${(w.avgMs / 1000).toFixed(1)} s on average` : ''}`] };
  }
  if (view.brand === 'androidtv') return { score: 35, evidence: ['Google TVs can’t be switched on over Cast'] };
  if (view.brand === 'appletv') {
    return view.paired ? { score: 80, evidence: ['Apple TVs wake over the network once paired'] } : { score: 35, evidence: ['Pair it to wake it from your phone'] };
  }
  if (!view.canWake) return { score: 35, evidence: ['No network address known for Wake-on-LAN'] };
  return { score: 70, evidence: ['Can be woken; not tried yet'] };
}

function connection(d, view) {
  // A TV that is simply switched off isn't unhealthy: measure it next time.
  if (view && !view.state?.online && !d?.network?.rtt?.ok) return { score: null, evidence: ['Off right now — measured next time it’s on'] };
  const n = d?.network;
  if (!n) return { score: null, evidence: ['Run diagnostics to measure'] };
  const ev = [];
  let s;
  if (/ether|wired/i.test(n.type ?? '')) {
    s = 100;
    ev.push('Wired Ethernet');
  } else if (n.signalDbm != null) {
    const dbm = n.signalDbm;
    s = dbm >= -55 ? 100 : dbm >= -67 ? 80 + ((dbm + 67) / 12) * 20 : dbm >= -75 ? 55 + ((dbm + 75) / 8) * 25 : clamp(55 - (-75 - dbm) * 3, 15);
    ev.push(`Wi-Fi signal ${dbm} dBm${n.snrDb != null ? `, SNR ${n.snrDb} dB` : ''}`);
  } else {
    s = 85;
    ev.push('Wi-Fi (the TV doesn’t report signal strength)');
  }
  const rtt = n.rtt;
  if (rtt?.ok) {
    if (rtt.lossPct) s -= Math.min(30, rtt.lossPct);
    if (rtt.jitter > 60) s -= 15;
    else if (rtt.jitter > 25) s -= 6;
    ev.push(`Round trip ${rtt.avg} ms ±${rtt.jitter} ms, ${rtt.lossPct}% loss`);
  } else if (rtt) {
    s -= 40;
    ev.push('Didn’t answer the network probe');
  }
  return { score: round(clamp(s)), evidence: ev };
}

function software(d, year) {
  const ev = [];
  let s = null;
  const now = new Date().getFullYear();
  if (year?.year) {
    const age = now - year.year;
    s = clamp(100 - age * 7, 30);
    ev.push(`${year.year} model (${age} year${age === 1 ? '' : 's'} old${year.source === 'ai' ? ', AI estimate' : ''})`);
  }
  const upd = d?.software?.updateAvailable;
  if (upd === true) {
    s = Math.min(s ?? 100, 55);
    ev.push('A software update is waiting');
  } else if (upd === false) {
    s = s == null ? 90 : clamp(s + 5);
    ev.push('Software is up to date');
  }
  if (d?.software?.version) ev.push(`${d.software.os ?? 'OS'} ${d.software.version}`);
  return { score: round(s), evidence: ev.length ? ev : ['Unknown model year and update status'] };
}

export function controls(view) {
  const c = view.capabilities ?? {};
  const list = {
    'Arrow keys & OK': c.remote !== false,
    'Turn off': view.brand !== 'androidtv',
    'Turn on': view.brand === 'appletv' ? view.paired : view.canWake && view.brand !== 'androidtv',
    'Exact volume': Boolean(c.volumeLevel),
    'Launch apps': true,
    'Switch inputs': Boolean(c.inputs) || view.brand === 'samsung',
    'Message on screen': Boolean(c.toast),
    'See what’s on': view.brand !== 'samsung',
  };
  return list;
}

function coverage(view) {
  const list = controls(view);
  const have = Object.values(list).filter(Boolean).length;
  const total = Object.keys(list).length;
  return { score: round((have / total) * 100), evidence: [`Hearth can do ${have} of ${total} things on this TV`], list };
}

export const WEIGHTS = { responsiveness: 0.22, reliability: 0.22, connection: 0.14, software: 0.15, wake: 0.12, coverage: 0.15 };
export const LABELS = {
  responsiveness: 'Responsiveness',
  reliability: 'Reliability',
  connection: 'Connection',
  software: 'Software',
  wake: 'Wake from sleep',
  coverage: 'Control coverage',
};

export const grade = (score) => (score == null ? '?' : score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F');

const WAKE_FIX = {
  lg: 'On the TV: Settings → General → Devices → TV Management → Turn on via Wi-Fi (older: Mobile TV On).',
  samsung: 'On the TV: Settings → General → Network → Expert Settings → Power On with Mobile.',
  roku: 'Plug the stick into a wall socket (not the TV’s USB port) so it stays awake when the TV sleeps.',
  androidtv: 'Google TVs only turn on from their own remote or Google Home, not over the local network.',
  appletv: 'Connect it in Hearth (the two codes); a paired Apple TV wakes over the network, and turns the TV on with it over HDMI-CEC.',
};
const PRIVACY_FIX = {
  lg: 'Settings → General → System → Additional Settings → Live Plus: Off; Support → Privacy → User Agreements: untick Viewing Information.',
  samsung: 'Settings → Support → Terms & Privacy → Viewing Information Services: Off; Interest-Based Advertisement: Off.',
  roku: 'Settings → Privacy → Smart TV experience / Advertising: Limit ad tracking.',
  androidtv: 'Settings → Privacy → Ads: Delete advertising ID; Usage & diagnostics: Off.',
  appletv: 'Settings → General → Privacy & Security → Analytics & Improvements: Off; Apple Advertising → Personalized Ads: Off.',
};

// Plain-language findings, worst first. `fix` is something a person can do.
export function findings(view, t, d, year, sub) {
  const out = [];
  const add = (severity, title, detail, fix) => out.push({ severity, title, detail, fix });
  if (!view.paired) add('high', 'Not connected to Hearth yet', 'Hearth can see this TV but can’t control it.', 'Open it in Hearth and follow the one-time connect step.');
  if (view.paired && !view.state?.online) add('info', 'Off right now', 'Being off isn’t a problem. A few checks wait until it’s on.', 'Nothing to do.');
  if (view.brand === 'appletv' ? !view.paired : !view.canWake || view.brand === 'androidtv') add('medium', 'Can’t be turned on from your phone', 'Hearth has no way to wake it from sleep.', WAKE_FIX[view.brand]);
  else if (t?.wake?.attempts >= 2 && t.wake.successPct < 60) add('high', 'Wake-ups often fail', `${t.wake.ok} of ${t.wake.attempts} worked.`, WAKE_FIX[view.brand]);
  if (d?.software?.updateAvailable === true) add('medium', 'A software update is waiting', 'Updates fix bugs and security holes.', 'Install it from the TV’s settings when nobody’s watching.');
  if (t?.commands?.p95 > 700) add('medium', 'Slow to respond', `1 in 20 presses takes over ${t.commands.p95} ms.`, 'Move the router closer, use 5 GHz Wi-Fi or plug in a network cable.');
  if (d?.network?.signalDbm != null && d.network.signalDbm < -72) add('medium', 'Weak Wi-Fi', `Signal is ${d.network.signalDbm} dBm.`, 'Use a cable or add a mesh point near the TV.');
  if (d?.network?.rtt?.lossPct > 0 || d?.network?.rtt?.jitter > 60) add('low', 'Patchy connection', `Round trips vary by ±${d.network.rtt.jitter} ms with ${d.network.rtt.lossPct}% loss.`, 'Check for Wi-Fi interference or a cable.');
  if (t?.connections?.unexpectedDrops24h >= 3) add('medium', 'Keeps dropping off the network', `${t.connections.unexpectedDrops24h} drops in the last day.`, 'Turn off the TV’s Wi-Fi power saving, or give it a DHCP reservation on the router.');
  if (t?.volume?.samples >= 5 && t.volume.highPct >= 30) add('low', 'Volume is often 60 or higher', `${t.volume.highPct}% of the time.`, 'A soundbar or Night/Clear Voice mode can help without cranking it.');
  if (year?.year && new Date().getFullYear() - year.year >= 6) add('low', `This TV is from ${year.year}`, 'Older smart TVs get slow and stop getting app updates.', 'A cheap streaming box makes it fast again; see the tune-up guide.');
  if (view.powerToggles) add('low', 'Power works as a toggle', 'This older Samsung can’t say whether it’s asleep.', 'Tap power once, like its own remote.');
  if (view.capabilities?.remote === false) add('low', 'Arrow keys need Google’s code', 'Without pairing, Hearth controls volume, mute and apps.', 'Use the Google TV remote for menus.');
  if (PRIVACY_FIX[view.brand]) add('tip', 'Stop the TV watching what you watch', 'Most smart TVs track viewing for ads (ACR).', PRIVACY_FIX[view.brand]);
  if (!out.some((f) => f.severity === 'high' || f.severity === 'medium') && sub.overall >= 85) add('good', 'Healthy', 'Fast, reliable and fully under control.', null);
  const rank = { high: 0, medium: 1, low: 2, info: 3, tip: 4, good: 5 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function rate(view, t, d, { aiYear = null, aiAdjust = null } = {}) {
  const year = modelYear(view.brand, d?.identity?.model || view.model) ?? (aiYear ? { year: aiYear, source: 'ai' } : null);
  const sub = {
    responsiveness: responsiveness(t, d),
    reliability: reliability(t),
    connection: connection(d, view),
    software: software(d, year),
    wake: wake(t, view),
    coverage: coverage(view),
  };
  let num = 0;
  let den = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) {
    if (sub[k].score == null) continue;
    num += sub[k].score * w;
    den += w;
  }
  const base = den ? num / den : null;
  const adj = aiAdjust && Number.isFinite(aiAdjust.points) ? clamp(aiAdjust.points, -10, 5) : 0;
  const overall = base == null ? null : round(clamp(base + adj));
  const result = { overall, base: round(base), grade: grade(overall), year, sub, aiAdjustment: adj ? { points: adj, reason: aiAdjust.reason } : null };
  result.findings = findings(view, t, d, year, result);
  result.verdict = verdictLine(view, result);
  return result;
}

function verdictLine(view, r) {
  const worst = r.findings.find((f) => f.severity === 'high' || f.severity === 'medium');
  if (r.overall == null) return 'Not enough information yet. Use it for a bit, then check again.';
  if (!worst) return r.overall >= 85 ? 'In great shape.' : 'Working fine.';
  return worst.title + '.';
}

// What leaves the house when AI insights are on: no names, IPs, MACs,
// serials, SSIDs or BSSIDs, only the model, software, scores and stats.
export function anonymise(view, t, d, rating) {
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  const safeSignals = {};
  for (const [k, v] of Object.entries(d?.signals ?? {})) {
    if (/ssid|mac|serial|ip|name|endpoint|bssid|location/i.test(k)) continue;
    if (v == null || typeof v === 'object') continue;
    safeSignals[k.slice(0, 40)] = typeof v === 'string' ? v.slice(0, 60) : v;
  }
  return {
    v: 1,
    brand: view.brand,
    model: String(d?.identity?.model || view.model || '').slice(0, 60),
    year: rating.year?.source === 'model code' ? rating.year.year : null,
    platform: {
      os: d?.software?.os ?? null,
      version: d?.software?.version ? String(d.software.version).slice(0, 40) : null,
      build: d?.software?.build ? String(d.software.build).slice(0, 40) : null,
      updateAvailable: d?.software?.updateAvailable ?? null,
    },
    network: {
      type: /ether|wired/i.test(d?.network?.type ?? '') ? 'ethernet' : d?.network?.type ? 'wifi' : null,
      signalDbm: d?.network?.signalDbm ?? null,
      snrDb: d?.network?.snrDb ?? null,
      rttMs: r1(d?.network?.rtt?.avg),
      jitterMs: r1(d?.network?.rtt?.jitter),
      lossPct: d?.network?.rtt?.lossPct ?? null,
    },
    controls: controls(view),
    scores: { overall: rating.overall, grade: rating.grade, sub: Object.fromEntries(Object.entries(rating.sub).map(([k, v]) => [k, v.score])) },
    stats: {
      commands: t?.commands?.count ?? 0,
      successPct: t?.commands?.successPct ?? null,
      p50Ms: t?.commands?.p50 ?? null,
      p95Ms: t?.commands?.p95 ?? null,
      unexpectedDrops24h: t?.connections?.unexpectedDrops24h ?? 0,
      online24hPct: t?.availability?.h24 == null ? null : Math.round(t.availability.h24 * 100),
      on24hPct: t?.availability?.onH24 == null ? null : Math.round(t.availability.onH24 * 100),
      wakeAttempts: t?.wake?.attempts ?? 0,
      wakeSuccessPct: t?.wake?.successPct ?? null,
      wakeAvgS: t?.wake?.avgMs == null ? null : r1(t.wake.avgMs / 1000),
      volumeAvg: t?.volume?.avg ?? null,
      volumeHighPct: t?.volume?.highPct ?? null,
      topApps: (t?.screenTime ?? []).slice(0, 5).map((a) => ({ app: String(a.app).slice(0, 40), hours: r1(a.ms / 3_600_000) })),
    },
    signals: safeSignals,
    findings: (rating.findings ?? []).filter((f) => f.severity !== 'tip').map((f) => f.title).slice(0, 8),
  };
}
