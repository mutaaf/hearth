import path from 'node:path';
import { queue, readJson, writeJson } from './jsonfile.js';

// Every signal Hearth sees, per TV: each command and how long it took,
// connections coming and going, power and online history, wake attempts,
// what's on screen and for how long, volume. Ring buffers keep it small; a
// compact copy lands in telemetry.json so a restart doesn't wipe history.
const CAP = { cmds: 500, conn: 300, online: 600, power: 600, wakes: 60, volume: 300 };
const WAKE_WINDOW = 90_000;
const DAY = 86_400_000;

const push = (arr, item, cap) => {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
};

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

// Share of [from, to] spent "true", given a timeline of { t, v } flips.
// `initial` is the value before the first flip in the window.
export function fractionTrue(timeline, from, to, initial = false) {
  if (to <= from) return null;
  let value = initial;
  let at = from;
  let on = 0;
  for (const { t, v } of timeline) {
    if (t <= from) {
      value = v;
      continue;
    }
    if (t >= to) break;
    if (value) on += t - at;
    value = v;
    at = t;
  }
  if (value) on += to - at;
  return on / (to - from);
}

const blank = (now) => ({
  first: now,
  cmds: [],
  conn: [],
  online: [],
  power: [],
  wakes: [],
  volume: [],
  apps: {},
  cur: null,
  last: {},
  sightings: { count: 0, last: null, via: {} },
});

export class Telemetry {
  constructor({ dir = null, now = () => Date.now(), saveMs = 4000 } = {}) {
    this.file = dir ? path.join(dir, 'telemetry.json') : null;
    this.now = now;
    this.saveMs = saveMs;
    this.tvs = new Map();
    this.pendingWake = new Map();
    this.timer = null;
  }

  async load() {
    if (!this.file) return this;
    // A corrupt file is kept aside (telemetry.json.corrupt-<time>), not overwritten blind.
    const tvs = await readJson(this.file, (d) => (d?.tvs && typeof d.tvs === 'object' ? d.tvs : undefined), {});
    for (const [id, rec] of Object.entries(tvs)) {
      if (rec && typeof rec === 'object') this.tvs.set(id, { ...blank(this.now()), ...rec, cur: null });
    }
    return this;
  }

  rec(id) {
    let r = this.tvs.get(id);
    if (!r) {
      r = blank(this.now());
      this.tvs.set(id, r);
    }
    return r;
  }

  forget(id) {
    this.tvs.delete(id);
    this.dirty();
  }

  // ── Recording ───────────────────────────────
  command(id, action, ok, ms, error) {
    const r = this.rec(id);
    push(r.cmds, { t: this.now(), a: action, ok, ms: Math.round(ms), ...(error ? { e: String(error).slice(0, 120) } : {}) }, CAP.cmds);
    this.dirty();
  }

  wakeStart(id) {
    if (this.rec(id).last.on) return; // already on: not a wake
    this.pendingWake.set(id, this.now());
  }

  state(id, s) {
    const r = this.rec(id);
    const t = this.now();
    const online = Boolean(s.online);
    const on = online && s.power === 'on';
    if (online !== r.last.online) {
      push(r.online, { t, v: online }, CAP.online);
      if (r.last.online !== undefined) push(r.conn, { t, type: online ? 'up' : 'down' }, CAP.conn);
    }
    if (on !== r.last.on) push(r.power, { t, v: on }, CAP.power);
    // Wake attempts resolve when the TV shows up (or time out).
    const started = this.pendingWake.get(id);
    if (started !== undefined) {
      if (on || (online && s.power !== 'off')) {
        // Turned on by hand long after the wake gave up isn't a working wake.
        const ok = t - started <= WAKE_WINDOW;
        push(r.wakes, ok ? { t: started, ok, ms: t - started } : { t: started, ok }, CAP.wakes);
        this.pendingWake.delete(id);
      } else if (t - started > WAKE_WINDOW) {
        push(r.wakes, { t: started, ok: false }, CAP.wakes);
        this.pendingWake.delete(id);
      }
    }
    // Screen time: close out the previous app when the foreground changes.
    const app = on ? s.appTitle || s.app || null : null;
    if (app !== r.cur?.app) {
      if (r.cur?.app) r.apps[r.cur.app] = (r.apps[r.cur.app] ?? 0) + (t - r.cur.since);
      r.cur = app ? { app, since: t } : null;
    }
    if (s.volume != null && (s.volume !== r.last.volume || s.muted !== r.last.muted)) {
      push(r.volume, { t, v: s.volume, m: Boolean(s.muted) }, CAP.volume);
    }
    r.last = { online, on, volume: s.volume ?? r.last.volume, muted: s.muted ?? r.last.muted, power: s.power };
    this.dirty();
  }

  sighting(id, via) {
    const s = this.rec(id).sightings;
    s.count++;
    s.last = this.now();
    s.via[via] = (s.via[via] ?? 0) + 1;
    this.dirty();
  }

  // Unresolved wakes count as failures once the window passes, even if no
  // state update ever arrives.
  #settleWakes(id) {
    const started = this.pendingWake.get(id);
    if (started !== undefined && this.now() - started > WAKE_WINDOW) {
      push(this.rec(id).wakes, { t: started, ok: false }, CAP.wakes);
      this.pendingWake.delete(id);
    }
  }

  // ── Reading ─────────────────────────────────
  // Time on per local calendar day, the last `n` days (oldest first), only
  // over the part of each day Hearth was watching. For the energy report.
  onByDay(id, n = 14) {
    const r = this.tvs.get(id);
    if (!r) return [];
    const now = this.now();
    const out = [];
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    for (let i = n - 1; i >= 0; i--) {
      const start = new Date(midnight);
      start.setDate(start.getDate() - i);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      const from = Math.max(start.getTime(), r.first);
      const to = Math.min(end.getTime(), now);
      if (to <= from) continue;
      let initial = false;
      for (const x of r.power) if (x.t <= from) initial = x.v;
      const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
      out.push({ day, from, to, spanMs: to - from, onMs: Math.round(fractionTrue(r.power, from, to, initial) * (to - from)) });
    }
    return out;
  }

  // How this TV goes off. `last`: 'off' when it powered down first and left
  // the network after (a normal switch-off, or it was asked to), 'lost' when
  // it vanished while on (unplugged, Wi-Fi). `autoOff`: it keeps switching
  // itself off after the same time on, with nobody pressing power on any TV
  // (a Roku's power-off reaches its TV over HDMI-CEC) → a sleep timer.
  offPattern(id) {
    const r = this.tvs.get(id);
    if (!r?.power.length) return { last: null, autoOff: null };
    const now = this.now();
    const asks = [];
    for (const rec of this.tvs.values()) for (const c of rec.cmds) if (/^power(Off|All)/.test(c.a)) asks.push(c.t);
    const asked = (t) => asks.some((a) => a <= t + 2000 && t - a < 30_000);
    const offline = r.online.filter((x) => !x.v).map((x) => x.t);
    const lostAt = (t) => offline.some((o) => Math.abs(o - t) < 2000); // power and network gone at once
    const sessions = [];
    let start = null;
    for (const p of r.power) {
      if (p.v) start = p.t;
      else if (start != null) {
        sessions.push({ start, end: p.t });
        start = null;
      }
    }
    const lastDrop = r.power.findLast((p) => !p.v);
    const last = r.last.online || !lastDrop ? null : lostAt(lastDrop.t) && !asked(lastDrop.t) ? 'lost' : 'off';
    const itself = sessions.filter((x) => x.end > now - 14 * DAY && x.end - x.start >= 3 * 60_000 && !asked(x.end) && !lostAt(x.end));
    let best = [];
    for (const x of itself) {
      const near = itself.filter((y) => Math.abs(y.end - y.start - (x.end - x.start)) <= 2 * 60_000);
      if (near.length > best.length) best = near;
    }
    if (best.length < 2 || best.length * 2 < itself.length) return { last, autoOff: null };
    const lens = best.map((x) => x.end - x.start).sort((a, b) => a - b);
    return { last, autoOff: { minutes: Math.round(lens[Math.floor(lens.length / 2)] / 60_000), count: best.length, lastAt: Math.max(...best.map((x) => x.end)) } };
  }

  summary(id) {
    this.#settleWakes(id);
    const r = this.rec(id);
    const now = this.now();
    // "unsupported" (501) is a capability answer, not a failure of the TV.
    const real = r.cmds.filter((c) => !/isn't supported|not supported/i.test(c.e ?? ''));
    const ms = real.filter((c) => c.ok).map((c) => c.ms).sort((a, b) => a - b);
    const byAction = {};
    for (const c of r.cmds) {
      const a = (byAction[c.a] ??= { count: 0, ok: 0, ms: [] });
      a.count++;
      if (c.ok) {
        a.ok++;
        a.ms.push(c.ms);
      }
    }
    for (const a of Object.values(byAction)) {
      a.ms.sort((x, y) => x - y);
      a.p50 = percentile(a.ms, 50);
      delete a.ms;
    }
    const errors = {};
    for (const c of r.cmds) if (!c.ok && c.e) errors[c.e] = (errors[c.e] ?? 0) + 1;

    const since = (span) => Math.max(r.first, now - span);
    const initialOnline = (from) => {
      let v = false;
      for (const x of r.online) if (x.t <= from) v = x.v;
      return v;
    };
    const avail = (span) => {
      const from = since(span);
      return now - from < 60_000 ? null : fractionTrue(r.online, from, now, initialOnline(from));
    };
    const powerOn = (span) => {
      const from = since(span);
      let v = false;
      for (const x of r.power) if (x.t <= from) v = x.v;
      return now - from < 60_000 ? null : fractionTrue(r.power, from, now, v);
    };
    // Drops while the TV was on and nobody asked it to turn off.
    const downs24 = r.conn.filter((e) => e.type === 'down' && e.t > now - DAY);
    const offCmds = r.cmds.filter((c) => /^power(Off|All)/.test(c.a));
    const unexpected = downs24.filter((d) => !offCmds.some((c) => c.t <= d.t && d.t - c.t < 30_000)).length;
    // Session lengths from up→down pairs.
    const sessions = [];
    let up = null;
    for (const e of r.conn) {
      if (e.type === 'up') up = e.t;
      else if (up) {
        sessions.push(e.t - up);
        up = null;
      }
    }
    // Older files logged a hand switch-on 20 min later as a "working" wake.
    const wakes = r.wakes.map((w) => (w.ok && w.ms > WAKE_WINDOW ? { t: w.t, ok: false } : w));
    const wakeOk = wakes.filter((w) => w.ok);
    const vols = r.volume.map((v) => v.v);
    const apps = { ...r.apps };
    if (r.cur?.app) apps[r.cur.app] = (apps[r.cur.app] ?? 0) + (now - r.cur.since);

    return {
      since: r.first,
      commands: {
        count: r.cmds.length,
        ok: r.cmds.filter((c) => c.ok).length,
        successPct: real.length ? Math.round((real.filter((c) => c.ok).length / real.length) * 1000) / 10 : null,
        p50: percentile(ms, 50),
        p95: percentile(ms, 95),
        p99: percentile(ms, 99),
        max: ms.length ? ms[ms.length - 1] : null,
        samples: ms.length,
        byAction,
        errors: Object.entries(errors).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([message, count]) => ({ message, count })),
        recent: r.cmds.slice(-40).reverse(),
        latencies: r.cmds.filter((c) => c.ok).slice(-120).map((c) => c.ms),
      },
      availability: { h24: avail(DAY), d7: avail(7 * DAY), onH24: powerOn(DAY) },
      connections: {
        downs24h: downs24.length,
        unexpectedDrops24h: unexpected,
        sessions: sessions.length,
        avgSessionMs: sessions.length ? Math.round(sessions.reduce((a, b) => a + b, 0) / sessions.length) : null,
        timeline: r.conn.slice(-40),
      },
      onlineTimeline: r.online.filter((x) => x.t > now - DAY),
      wake: {
        attempts: wakes.length,
        ok: wakeOk.length,
        successPct: wakes.length ? Math.round((wakeOk.length / wakes.length) * 100) : null,
        avgMs: wakeOk.length ? Math.round(wakeOk.reduce((a, w) => a + w.ms, 0) / wakeOk.length) : null,
        recent: wakes.slice(-10).reverse(),
        pending: this.pendingWake.has(id),
      },
      screenTime: Object.entries(apps).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([app, ms]) => ({ app, ms })),
      volume: {
        samples: vols.length,
        avg: vols.length ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : null,
        max: vols.length ? Math.max(...vols) : null,
        highPct: vols.length ? Math.round((vols.filter((v) => v >= 60).length / vols.length) * 100) : null,
        mutedPct: r.volume.length ? Math.round((r.volume.filter((v) => v.m).length / r.volume.length) * 100) : null,
      },
      sightings: r.sightings,
      autoOff: this.offPattern(id).autoOff,
    };
  }

  // ── Persistence ─────────────────────────────
  dirty() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save().catch(() => {});
    }, this.saveMs);
    this.timer.unref?.();
  }

  // Queued, each with its own temp file: the timer's save and flush() on
  // shutdown can no longer race on one temp name.
  #enqueue = queue();
  save() {
    if (!this.file) return Promise.resolve();
    const tvs = {};
    for (const [id, r] of this.tvs) {
      // Close the running app's time into the totals for the snapshot only.
      tvs[id] = { ...r, cur: null, cmds: r.cmds.slice(-200) };
    }
    const snapshot = JSON.parse(JSON.stringify({ version: 1, tvs }));
    return this.#enqueue(() => writeJson(this.file, snapshot, { pretty: false, backup: false }));
  }

  async flush() {
    clearTimeout(this.timer);
    this.timer = null;
    await this.save().catch(() => {});
  }
}

// Wrap a driver's public commands so every call is timed and recorded.
// Brands that don't implement a method keep the base "unsupported" error.
const METHODS = ['key', 'powerOn', 'powerOff', 'setVolume', 'launch', 'setInput', 'toast', 'apps', 'inputs', 'pair'];
export function instrument(driver, id, telemetry) {
  for (const name of METHODS) {
    const original = driver[name];
    if (typeof original !== 'function') continue;
    driver[name] = async function (...args) {
      const label = name === 'key' ? `key:${args[0]}` : name;
      if (name === 'powerOn') telemetry.wakeStart(id);
      const t0 = performance.now();
      try {
        const result = await original.apply(driver, args);
        telemetry.command(id, label, true, performance.now() - t0);
        return result;
      } catch (err) {
        telemetry.command(id, label, false, performance.now() - t0, err?.message);
        throw err;
      }
    };
  }
  return driver;
}
