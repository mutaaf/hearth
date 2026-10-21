import { EventEmitter } from 'node:events';
import { badRequest, HearthError, notFound } from './errors.js';
import { classify } from './activity.js';
import { discover, isIPv4, isMac, macFor, portOpen, probe, tvId } from './discovery.js';
import { closeBridge } from './atv-bridge.js';
import { AppleTvDriver } from './drivers/appletv.js';
import { LgDriver } from './drivers/lg.js';
import { GoogleTvDriver } from './drivers/googletv.js';
import { RokuDriver } from './drivers/roku.js';
import { SamsungDriver } from './drivers/samsung.js';
// ── health: telemetry, diagnostics, rating, AI insights ──
import { diagnose } from './diagnostics.js';
import { anonymise, rate } from './health.js';
import { Insights } from './llm.js';
import { instrument, Telemetry } from './telemetry.js';

export const DRIVERS = { lg: LgDriver, samsung: SamsungDriver, roku: RokuDriver, androidtv: GoogleTvDriver, appletv: AppleTvDriver };

// Ports a TV listens on even before it's paired: enough to tell "on" from
// "off" so the app can offer to wake it.
// Apple TV: AirPlay's fixed :7000 (Companion's port moves around).
const REACH_PORTS = { lg: [3001, 3000], samsung: [8001], roku: [8060], androidtv: [8009], appletv: [7000] };

// The hub owns the list of TVs and one live driver per TV. The HTTP server is
// a thin layer over it; tests drive it directly with fake drivers.
export class Hub extends EventEmitter {
  #drivers = new Map();

  constructor({ store, drivers = DRIVERS, discoverFn = discover, probeFn = probe, telemetry, insights, macForFn = macFor } = {}) {
    super();
    this.macForFn = macForFn; // ── doctor: self-healing addresses
    // ── health ──
    this.telemetry = telemetry ?? new Telemetry({ dir: store?.dir ?? null });
    this.insights = insights ?? new Insights();
    this.diag = new Map();
    this.store = store;
    this.driverClasses = drivers;
    this.discoverFn = discoverFn;
    this.probeFn = probeFn;
    this.tvs = [];
  }

  async init() {
    await this.telemetry.load();
    this.tvs = await this.store.load();
    for (const tv of this.tvs) this.#attach(tv);
    return this;
  }

  async close() {
    clearInterval(this.#discoveryTimer);
    for (const id of [...this.#watchers.keys()]) this.#unwatch(id);
    await Promise.all([...this.#drivers.values()].map((d) => d.stop()));
    await this.telemetry.flush();
    await closeBridge();
  }

  #attach(tv) {
    const Driver = this.driverClasses[tv.brand];
    if (!Driver) return;
    const driver = new Driver(tv, {
      onCredentials: (creds) => {
        tv.credentials = { ...tv.credentials, ...creds };
        this.#persist();
        this.emit('change', this.view(tv));
      },
      onInfo: (info) => {
        Object.assign(tv, info);
        this.#persist();
        this.emit('change', this.view(tv));
      },
    });
    instrument(driver, tv.id, this.telemetry); // ── health: time every command
    driver.on('state', (state) => {
      this.telemetry.state(tv.id, state); // ── health
      // Remember when the TV last turned on/off ("On for 1h 12m" in the app).
      const on = state.online && state.power === 'on';
      if (on !== this.#wasOn.get(tv.id)) {
        this.#wasOn.set(tv.id, on);
        this.#since.set(tv.id, Date.now());
      }
      this.emit('change', this.view(tv));
    });
    driver.on('connection-error', () => {});
    this.#drivers.set(tv.id, driver);
    if (tv.credentials) driver.start();
    else this.#watch(tv, driver);
  }

  // Unpaired TVs have no live connection, so peek at their control port now
  // and then. Stops on its own once the TV is paired.
  #watchers = new Map();
  #since = new Map();
  #wasOn = new Map();
  #watch(tv, driver, everyMs = this.watchMs ?? 10_000) {
    const ports = REACH_PORTS[tv.brand] ?? [];
    if (!ports.length) return;
    const check = async () => {
      if (tv.credentials || !this.#drivers.has(tv.id)) return this.#unwatch(tv.id);
      let up = false;
      for (const port of ports) if (!up) up = await portOpen(tv.ip, port, 1200);
      driver.setState({ online: up, power: up ? 'on' : 'off' });
    };
    check();
    const timer = setInterval(check, everyMs);
    timer.unref?.();
    this.#watchers.set(tv.id, timer);
  }

  #unwatch(id) {
    clearInterval(this.#watchers.get(id));
    this.#watchers.delete(id);
  }

  #persist() {
    this.store.save(this.tvs).catch((err) => console.error('[hearth] could not save TVs:', err.message));
  }

  // What the outside world sees. Never includes pairing keys.
  view(tv) {
    const driver = this.#drivers.get(tv.id);
    return {
      id: tv.id,
      brand: tv.brand,
      name: tv.name,
      room: tv.room ?? '',
      model: tv.model ?? '',
      ip: tv.ip,
      paired: Boolean(tv.credentials),
      canWake: Boolean(tv.macs?.length),
      powerToggles: Boolean(driver?.powerToggles),
      capabilities: driver?.capabilities ?? {},
      state: driver?.state ?? { online: false, power: 'unknown' },
      since: this.#since.get(tv.id) ?? null,
      activity: this.#activity(tv, driver),
    };
  }

  // ── Activity (what's on: game, browser, streaming…) + how long ──
  #activitySince = new Map(); // tv.id → { key, since }
  #activity(tv, driver) {
    const a = classify({ brand: tv.brand, paired: Boolean(tv.credentials), state: driver?.state ?? {} });
    const key = `${a.kind}|${a.label}`;
    const prev = this.#activitySince.get(tv.id);
    if (prev?.key !== key) this.#activitySince.set(tv.id, { key, since: Date.now() });
    return { ...a, since: this.#activitySince.get(tv.id).since };
  }
  // ── end activity ──

  list() {
    return this.tvs.map((tv) => this.view(tv));
  }

  get(id) {
    const tv = this.tvs.find((t) => t.id === id);
    if (!tv) throw notFound('TV');
    return tv;
  }

  driver(id) {
    this.get(id);
    return this.#drivers.get(id);
  }

  async scan() {
    const raw = await this.discoverFn();
    for (const f of raw) await this.#heal(f).catch(() => null); // ── doctor
    const found = raw.map((tv) => ({
      ...tv,
      added: this.tvs.some((t) => t.id === tv.id || t.ip === tv.ip),
    }));
    this.#setNearby(found.filter((tv) => !tv.added));
    // ── health: which discovery channel saw each known TV
    for (const f of found) {
      const known = this.tvs.find((t) => t.id === f.id || t.ip === f.ip);
      if (known) this.telemetry.sighting(known.id, f.brand === 'androidtv' ? 'mdns' : 'ssdp');
    }
    return found;
  }

  // ── doctor: self-healing addresses ──
  // A known TV (same id, or any shared MAC) answering at a new IP has simply
  // been given a new address by the router: follow it.
  async #heal(f) {
    if (!f?.ip) return null;
    const sameBrand = (t) => t.brand === f.brand;
    let known = this.tvs.find((t) => t.id === f.id && sameBrand(t)) ?? this.tvs.find((t) => sameBrand(t) && t.macs?.some((m) => f.macs?.includes(m)));
    if (!known && !f.macs?.length) {
      const mac = await this.macForFn(f.ip);
      if (mac) known = this.tvs.find((t) => sameBrand(t) && t.macs?.includes(mac));
    }
    if (!known || known.ip === f.ip) return null;
    // Someone else already lives there: don't steal their address.
    if (this.tvs.some((t) => t !== known && t.ip === f.ip)) return null;
    return this.relocate(known.id, f.ip);
  }

  async relocate(id, ip) {
    const tv = this.get(id);
    if (!isIPv4(ip) || tv.ip === ip) return null;
    const from = tv.ip;
    await this.#drivers.get(id)?.stop();
    this.#unwatch(id);
    tv.ip = ip;
    this.#attach(tv);
    await this.store.save(this.tvs);
    const healed = { id, name: tv.name, from, to: ip, message: `${tv.name} moved to ${ip} — reconnected` };
    this.emit('change', this.view(tv));
    this.emit('healed', healed);
    return healed;
  }

  // Forget the pairing (not the TV) so it can be paired again.
  async unpair(id) {
    const tv = this.get(id);
    await this.#drivers.get(id)?.stop();
    this.#drivers.delete(id);
    delete tv.credentials;
    this.#attach(tv);
    await this.store.save(this.tvs);
    this.emit('change', this.view(tv));
    return this.view(tv);
  }
  // ── end doctor ──

  // TVs on the network that haven't been added yet. The app shows them as a
  // "New TV nearby — add it?" banner, so nobody has to go looking.
  nearby = [];

  #setNearby(list) {
    const key = (l) => l.map((t) => t.id).sort().join();
    if (key(list) === key(this.nearby)) return;
    this.nearby = list;
    this.emit('nearby', list);
  }

  startAutoDiscovery(everyMs = 60_000) {
    const run = () => this.scan().catch(() => {});
    run();
    this.#discoveryTimer = setInterval(run, everyMs);
    this.#discoveryTimer.unref?.();
  }

  #discoveryTimer = null;

  async add(input = {}) {
    const ip = String(input.ip ?? '').trim();
    if (!isIPv4(ip)) throw badRequest('That doesn’t look like an IP address (e.g. 192.168.1.40)');
    const existing = this.tvs.find((t) => t.ip === ip);
    if (existing) return this.view(existing);

    let found;
    if (input.brand) {
      if (!this.driverClasses[input.brand]) throw badRequest(`Unsupported brand: ${input.brand}`);
      const macs = (Array.isArray(input.macs) ? input.macs : []).filter(isMac).map((m) => m.toLowerCase());
      found = { brand: input.brand, name: input.name, model: input.model, ip, macs, atvId: input.atvId };
    } else {
      found = await this.probeFn(ip);
      if (!found) throw new HearthError(404, 'No TV answered at that address. Is it switched on?');
    }

    // No MAC from discovery (Google TVs)? Ask the OS; it's needed to wake it.
    if (!found.macs?.length) {
      const mac = await macFor(ip);
      if (mac) found.macs = [mac];
    }
    const tv = {
      id: tvId(found.brand, found.macs, ip),
      brand: found.brand,
      name: clean(found.name) || BRAND_NAMES[found.brand] || 'TV',
      model: clean(found.model),
      room: clean(input.room),
      ip,
      macs: found.macs ?? [],
      // Apple TV: pyatv's device identifier (AirPlay deviceid), to find it
      // again if its IP changes.
      ...(typeof found.atvId === 'string' && /^[0-9A-F:-]{6,64}$/i.test(found.atvId) ? { atvId: found.atvId } : {}),
      addedAt: new Date().toISOString(),
    };
    if (this.tvs.some((t) => t.id === tv.id)) tv.id += `-${Date.now().toString(36)}`;
    this.tvs.push(tv);
    await this.store.save(this.tvs);
    this.#attach(tv);
    this.emit('change', this.view(tv));
    this.#setNearby(this.nearby.filter((n) => n.ip !== ip));
    return this.view(tv);
  }

  async update(id, patch = {}) {
    const tv = this.get(id);
    if (patch.name !== undefined) tv.name = clean(patch.name) || tv.name;
    if (patch.room !== undefined) tv.room = clean(patch.room);
    if (patch.ip !== undefined) {
      if (!isIPv4(patch.ip)) throw badRequest('That doesn’t look like an IP address');
      if (patch.ip !== tv.ip) {
        // Drivers bake the address into their connection; rebuild it.
        await this.#drivers.get(id)?.stop();
        tv.ip = patch.ip;
        this.#attach(tv);
      }
    }
    await this.store.save(this.tvs);
    this.emit('change', this.view(tv));
    return this.view(tv);
  }

  async remove(id) {
    const tv = this.get(id);
    await this.#drivers.get(id)?.stop();
    this.#drivers.delete(id);
    this.#unwatch(id);
    this.telemetry.forget(id); // ── health
    this.insights.forget(id);
    this.diag.delete(id);
    this.tvs = this.tvs.filter((t) => t !== tv);
    await this.store.save(this.tvs);
    this.emit('removed', { id });
    return { ok: true };
  }

  async pair(id, opts = {}) {
    const tv = this.get(id);
    const result = await this.driver(id).pair(opts);
    // Some TVs (LG in PIN mode, Apple TV) show a number first and finish on a
    // 2nd call. Apple TV asks twice (remote, then what's playing): step/steps.
    if (result?.needsPin) {
      const { step, steps, label } = result;
      return { ...this.view(tv), needsPin: true, ...(steps ? { step, steps, label } : {}) };
    }
    if (result?.needsCode) return { ...this.view(tv), needsCode: true }; // Google TV full remote
    this.#unwatch(id);
    // Make sure the new pairing key is on disk before we report success.
    await this.store.save(this.tvs);
    return this.view(tv);
  }

  async power(id, on) {
    const driver = this.driver(id);
    await (on ? driver.powerOn() : driver.powerOff());
    return { ok: true };
  }

  // ── health: report card, deep diagnostics, AI insights ──
  health(id) {
    const tv = this.get(id);
    const view = this.view(tv);
    const t = this.telemetry.summary(id);
    const d = this.diag.get(id)?.data ?? null;
    const ai = this.insights.cached(id);
    const rating = rate(view, t, d, ai ? { aiYear: ai.insight.model_profile.year, aiAdjust: ai.insight.ai_grade_adjustment } : {});
    return { tv: view, rating, telemetry: t, diagnostics: d, ai, aiPayload: anonymise(view, t, d, rate(view, t, d)) };
  }

  async diagnostics(id) {
    const tv = this.get(id);
    const data = await diagnose(tv, this.view(tv), this.#drivers.get(id));
    this.diag.set(id, { at: Date.now(), data });
    return this.health(id);
  }

  report() {
    return this.tvs.map((tv) => {
      const h = this.health(tv.id);
      return {
        id: tv.id,
        name: tv.name,
        brand: tv.brand,
        model: tv.model ?? '',
        score: h.rating.overall,
        grade: h.rating.grade,
        verdict: h.ai?.insight.verdict_for_everyone || h.rating.verdict,
        worst: h.rating.findings.find((f) => f.severity === 'high' || f.severity === 'medium')?.title ?? null,
        online: Boolean(h.tv.state?.online),
        diagnosedAt: this.diag.get(tv.id)?.at ?? null,
      };
    });
  }

  async aiInsights(id, { provider, model, key, refresh } = {}) {
    // Fresh diagnostics make a better report; reuse them if under 10 minutes old.
    if (!this.diag.get(id) || Date.now() - this.diag.get(id).at > 600_000) await this.diagnostics(id).catch(() => {});
    const { aiPayload } = this.health(id);
    await this.insights.run(id, aiPayload, { provider, model, key, refresh });
    return this.health(id);
  }

  async powerAll(on) {
    const paired = this.tvs.filter((t) => t.credentials);
    const results = await Promise.allSettled(paired.map((t) => this.power(t.id, on)));
    return {
      ok: results.every((r) => r.status === 'fulfilled'),
      results: paired.map((t, i) => ({
        id: t.id,
        name: t.name,
        ok: results[i].status === 'fulfilled',
        error: results[i].reason?.message,
      })),
    };
  }
}

const BRAND_NAMES = { lg: 'LG TV', samsung: 'Samsung TV', roku: 'Roku', androidtv: 'Google TV', appletv: 'Apple TV' };
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
