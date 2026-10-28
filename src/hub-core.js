import { EventEmitter } from 'node:events';
import { badRequest, HearthError, notFound } from './errors.js';
import { classify } from './activity.js';
import { discover, isIPv4, isMac, macFor, portOpen, probe, tvId } from './discovery.js';
import { isForbiddenTarget } from './guard.js';
import { log } from './log.js';
// ── health: telemetry, diagnostics, rating, AI insights ──
import { diagnose } from './diagnostics.js';
import { anonymise, modelYear, rate } from './health.js';
import { Insights } from './llm.js';
import { instrument, Telemetry } from './telemetry.js';
import { billRequest, Energy } from './energy.js';


// Ports a TV listens on even before it's paired: enough to tell "on" from
// "off" so the app can offer to wake it.
// Apple TV: AirPlay's fixed :7000 (Companion's port moves around).
const REACH_PORTS = { lg: [3001, 3000], samsung: [8001], roku: [8060], androidtv: [8009], appletv: [7000] };

// The hub owns the list of TVs and one live driver per TV. This is the core,
// shared with the phone app (hearth-app): it imports no driver and nothing
// that only runs on a computer. src/hub.js adds every brand and the Apple TV
// bridge for the home server. The HTTP server is
// a thin layer over it; tests drive it directly with fake drivers.
export class Hub extends EventEmitter {
  #drivers = new Map();

  constructor({ store, drivers = {}, onClose = async () => {}, discoverFn = discover, probeFn = probe, telemetry, insights, energy, macForFn = macFor, forbiddenIp = isForbiddenTarget } = {}) {
    super();
    // Loopback, link-local, multicast…: never a TV, and never somewhere the
    // icon proxy or a driver should be pointed (tests with fake TVs on
    // 127.0.0.1 pass () => false).
    this.forbiddenIp = forbiddenIp;
    this.macForFn = macForFn; // ── doctor: self-healing addresses
    // ── health ──
    this.telemetry = telemetry ?? new Telemetry({ dir: store?.dir ?? null });
    this.insights = insights ?? new Insights();
    this.energy = energy ?? new Energy({ dir: store?.dir ?? null });
    this.diag = new Map();
    this.store = store;
    this.driverClasses = drivers;
    this.onClose = onClose;
    this.discoverFn = discoverFn;
    this.probeFn = probeFn;
    this.tvs = [];
  }

  async init() {
    await this.telemetry.load();
    await this.energy.load();
    this.tvs = await this.store.load();
    for (const tv of this.tvs) this.#attach(tv);
    return this;
  }

  async close() {
    clearInterval(this.#discoveryTimer);
    for (const timers of this.#settleTimers.values()) timers.forEach(clearTimeout);
    for (const id of [...this.#watchers.keys()]) this.#unwatch(id);
    this.#stopLookout();
    await Promise.all([...this.#drivers.values()].map((d) => d.stop()));
    await this.telemetry.flush();
    await this.onClose();
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
    driver.setActive?.(this.viewers > 0);
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
    this.store.save(this.tvs).catch((err) => log.error('[hearth] could not save TVs:', err.message));
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
      off: this.telemetry.offPattern(tv.id), // { last: 'off'|'lost'|null, autoOff }
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

  // One scan at a time: the 60 s timer, "Scan" in the app and the doctor all
  // ask; overlapping scans used to heal the same moved TV twice and leave two
  // live drivers for it.
  #scanning = null;
  scan() {
    this.#scanning ??= this.#scan().finally(() => {
      this.#scanning = null;
    });
    return this.#scanning;
  }

  // Changes to one TV (move, edit, pair again, add at an address) run one at
  // a time per key, so two of them can't both stop + reattach a driver.
  #locks = new Map();
  #withLock(key, fn) {
    const prev = this.#locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.#locks.set(key, tail);
    tail.then(() => {
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    });
    return run;
  }

  async #scan() {
    // A look someone asked for (seek()): the UI shows it and its outcome.
    const seeking = this.#seekWanted;
    this.#seekWanted = null;
    const healed = new Set();
    const raw = await this.discoverFn().catch((err) => {
      if (seeking) this.emit('looking', { on: false, tvs: seeking, found: [], missing: seeking });
      throw err;
    });
    // A MAC-less TV seen while every paired TV of its brand is answering is
    // someone else (a second, unpaired set): never mistake it for one of ours.
    for (const f of raw) {
      const ours = this.tvs.filter((t) => t.brand === f.brand && t.credentials);
      if (!f.macs?.length && ours.length && !ours.some((t) => t.ip === f.ip) && ours.every((t) => this.#drivers.get(t.id)?.state?.online)) this.#strangers.add(f.ip);
    }
    for (const f of raw) {
      const h = await this.#heal(f).catch(() => null); // ── doctor
      if (h) healed.add(h.id);
    }
    if (seeking) {
      const found = seeking.filter((id) => healed.has(id));
      const missing = seeking.filter((id) => !healed.has(id) && this.tvs.some((t) => t.id === id) && !this.#drivers.get(id)?.state?.online);
      this.emit('looking', { on: false, tvs: seeking, found, missing });
    }
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

  #strangers = new Set();

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
    // No MAC to go on (the phone can't read ARP, and an LG only says its MAC
    // once paired): a TV of this brand at an address none of ours has, while
    // exactly one paired TV of that brand has gone quiet, is that TV.
    if (!known && !f.macs?.length && !this.#strangers.has(f.ip) && !this.tvs.some((t) => t.ip === f.ip)) {
      const quiet = this.tvs.filter((t) => sameBrand(t) && t.credentials && !this.#drivers.get(t.id)?.state?.online);
      if (quiet.length === 1) known = quiet[0];
    }
    if (!known || known.ip === f.ip) return null;
    // Someone else already lives there: don't steal their address.
    if (this.tvs.some((t) => t !== known && t.ip === f.ip)) return null;
    return this.relocate(known.id, f.ip);
  }

  // A paired TV isn't answering where we left it: it may be off, or the
  // router gave it a new address overnight. Look around for it now rather
  // than at the next scheduled scan (at most every 20 s). The app listens for
  // 'seek' to sweep the Wi-Fi; elsewhere a scan's multicast is enough.
  // 'looking' { on: true, tvs } now, and { on: false, tvs, found, missing }
  // when that look is done (found: followed to a new address).
  #soughtAt = 0;
  #seekWanted = null;
  seek() {
    if (Date.now() - this.#soughtAt < (this.seekGapMs ?? 20_000)) return false;
    const quiet = this.tvs.filter((t) => t.credentials && !this.#drivers.get(t.id)?.state?.online).map((t) => t.id);
    if (!quiet.length) return false;
    this.#soughtAt = Date.now();
    this.#seekWanted = quiet;
    this.emit('looking', { on: true, tvs: quiet });
    if (this.listenerCount('seek')) this.emit('seek');
    // After any scan already running (it started before we asked).
    else
      Promise.resolve(this.#scanning)
        .catch(() => {})
        .then(() => this.scan())
        .catch(() => {});
    return true;
  }

  async relocate(id, ip) {
    return this.#withLock(`tv:${id}`, async () => {
      const tv = this.get(id);
      // Re-checked under the lock: a parallel heal may have moved it already.
      if (!isIPv4(ip) || this.forbiddenIp(ip) || tv.ip === ip) return null;
      if (this.tvs.some((t) => t !== tv && t.ip === ip)) return null;
      const from = tv.ip;
      await this.#reattach(tv, () => {
        tv.ip = ip;
      });
      await this.store.save(this.tvs);
      const healed = { id, name: tv.name, from, to: ip, message: `${tv.name} moved to ${ip} — reconnected` };
      this.emit('change', this.view(tv));
      this.emit('healed', healed);
      return healed;
    });
  }

  // Stop the TV's driver (and any watcher), apply a change, start a fresh one.
  async #reattach(tv, change) {
    const old = this.#drivers.get(tv.id);
    this.#drivers.delete(tv.id);
    this.#unwatch(tv.id);
    await old?.stop();
    change();
    this.#attach(tv);
  }

  // Forget the pairing (not the TV) so it can be paired again.
  async unpair(id) {
    return this.#withLock(`tv:${id}`, async () => {
      const tv = this.get(id);
      await this.#reattach(tv, () => {
        delete tv.credentials;
      });
      await this.store.save(this.tvs);
      this.emit('change', this.view(tv));
      return this.view(tv);
    });
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
    if (this.forbiddenIp(ip)) throw badRequest('That address can’t be a TV (it’s this computer or a special address)');
    // Two taps on "Add" for the same address: the second waits and gets the first's TV.
    return this.#withLock(`ip:${ip}`, () => this.#add(ip, input));
  }

  async #add(ip, input) {
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
    if (patch.ip !== undefined) {
      if (!isIPv4(patch.ip)) throw badRequest('That doesn’t look like an IP address');
      if (this.forbiddenIp(patch.ip)) throw badRequest('That address can’t be a TV (it’s this computer or a special address)');
    }
    return this.#withLock(`tv:${id}`, async () => {
      if (patch.name !== undefined) tv.name = clean(patch.name) || tv.name;
      if (patch.room !== undefined) tv.room = clean(patch.room);
      if (patch.ip !== undefined && patch.ip !== tv.ip) {
        // Drivers bake the address into their connection (and unpaired TVs
        // have a reachability watcher on it); rebuild both.
        await this.#reattach(tv, () => {
          tv.ip = patch.ip;
        });
        this.#apps.delete(id);
      }
      await this.store.save(this.tvs);
      this.emit('change', this.view(tv));
      return this.view(tv);
    });
  }

  async remove(id) {
    const tv = this.get(id);
    return this.#withLock(`tv:${id}`, async () => {
      const driver = this.#drivers.get(id);
      this.#drivers.delete(id);
      this.#unwatch(id);
      // Everything kept per TV goes with it (pending settle re-reads too).
      for (const t of this.#settleTimers.get(id) ?? []) clearTimeout(t);
      this.#settleTimers.delete(id);
      this.#apps.delete(id);
      this.#since.delete(id);
      this.#wasOn.delete(id);
      this.#activitySince.delete(id);
      await driver?.stop();
      this.telemetry.forget(id); // ── health
      this.energy.forget(id);
      this.insights.forget(id);
      this.diag.delete(id);
      this.tvs = this.tvs.filter((t) => t !== tv);
      await this.store.save(this.tvs);
      this.emit('removed', { id });
      return { ok: true };
    });
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

  #offAt = new Map(); // id → when Hearth last switched it off
  async power(id, on) {
    const driver = this.driver(id);
    if (on) this.#offAt.delete(id);
    else this.#offAt.set(id, Date.now());
    await (on ? driver.powerOn() : driver.powerOff());
    this.settle(id);
    return { ok: true };
  }

  // Any button on a sleeping TV wakes it first, then does the press, so
  // nobody has to find the power button. Presses that arrive while it's
  // waking share one wake. → true if it woke the TV.
  #waking = new Map();
  async wakeFor(id) {
    const tv = this.get(id);
    const view = this.view(tv);
    const st = view.state;
    if (!tv.credentials || st?.online && (st.power === 'on' || st.power === 'unknown')) return false;
    // Google TVs need Google's code for power; anything else needs a way in:
    // still on the network (standby), or a MAC for Wake-on-LAN.
    if (tv.brand === 'androidtv' || !(st?.online || view.canWake)) return false;
    // Just switched off from here: a stray press while it powers down (a
    // Samsung takes ~40 s) must not switch it straight back on.
    if (Date.now() - (this.#offAt.get(id) ?? 0) < 45_000) return false;
    if (!this.#waking.has(id)) {
      const awake = () => {
        const s = this.view(this.get(id)).state;
        return Boolean(s?.online && (s.power === 'on' || s.power === 'unknown'));
      };
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const job = (async () => {
        // It may already be on (switched on with its own remote) while the
        // driver sits out its backoff (up to 60 s): connect now and look
        // before sending anything that could toggle it.
        if (!st?.online) {
          this.kick(id, { force: true });
          for (let t = 0; t < (this.lookFirstMs ?? 2500) && !awake(); t += this.pollMs ?? 500) await sleep(this.pollMs ?? 500);
          if (awake()) return;
          // Not where we left it: look for a new address while it wakes
          // (Wake-on-LAN goes by MAC, so it finds the TV either way).
          this.seek();
        }
        await this.power(id, true);
        const deadline = Date.now() + (this.wakeMs ?? 25_000);
        let kicked = Date.now();
        for (;;) {
          if (awake()) break;
          if (Date.now() > deadline) throw new HearthError(503, `${tv.name} didn’t wake up. Turn it on with its own remote.`);
          // A TV coming up gets a fresh connection attempt every few seconds,
          // not the driver's next backoff tick.
          if (Date.now() - kicked > (this.kickEveryMs ?? 5000) && !this.view(this.get(id)).state?.online) {
            kicked = Date.now();
            this.kick(id, { force: true });
          }
          await sleep(this.pollMs ?? 500);
        }
        // Freshly awake sets need a moment before they take keys.
        await new Promise((r) => setTimeout(r, this.wakeSettleMs ?? 1500));
      })().finally(() => this.#waking.delete(id));
      this.#waking.set(id, job);
    }
    await this.#waking.get(id);
    return true;
  }

  // ── Live state that matches the TV ──
  // After any command, re-read the TV shortly afterwards (and once more a
  // bit later, for slow app launches and power transitions), so the app shows
  // what the TV is really doing rather than what we hoped it would do.
  #settleTimers = new Map();
  settle(id, delays = this.settleDelays ?? [700, 2500]) {
    const driver = this.#drivers.get(id);
    if (!driver?.refresh) return;
    for (const t of this.#settleTimers.get(id) ?? []) clearTimeout(t);
    const timers = delays.map((ms) => {
      const t = setTimeout(() => Promise.resolve(driver.refresh()).catch(() => {}), ms);
      t.unref?.();
      return t;
    });
    this.#settleTimers.set(id, timers);
  }

  // Pull to refresh: every TV re-reads what it's doing now (4 s cap each), and
  // a nearby scan starts in the background. → { refreshed: n }
  async refreshAll(timeoutMs = 4000) {
    const jobs = [...this.#drivers.values()].filter((d) => d.refresh).map((d) =>
      Promise.race([Promise.resolve().then(() => d.refresh()), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]).catch(() => {}));
    this.scan().catch(() => {});
    await Promise.all(jobs);
    return { refreshed: jobs.length };
  }

  // Every connection, fresh: for a phone that just woke up, whose sockets
  // may look open but be dead. Then each TV re-reads what it's doing.
  // → { reconnected: n }
  async reconnectAll(timeoutMs = 4000) {
    const drivers = [...this.#drivers.values()];
    await Promise.all(drivers.map((d) =>
      Promise.race([Promise.resolve().then(() => d.reconnect?.()), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]).catch(() => {})));
    return { reconnected: drivers.length };
  }

  // How many app screens are open (SSE clients). Drivers that poll go faster
  // while someone's looking and slow down when nobody is.
  viewers = 0;
  setViewers(n) {
    const was = this.viewers > 0;
    this.viewers = Math.max(0, n);
    const now = this.viewers > 0;
    if (was === now) return;
    for (const d of this.#drivers.values()) d.setActive?.(now);
    if (now) this.#startLookout();
    else this.#stopLookout();
  }

  // A paired TV that's off drops off the network, and its driver retries on a
  // backoff that grows to 60 s. So while someone has Hearth open, knock on
  // each offline TV's control port every few seconds and reconnect the moment
  // it answers: a TV switched on with its own remote is back in seconds.
  #lookout = null;
  #looking = false;
  #kicked = new Map();
  #startLookout(everyMs = this.lookoutMs ?? 4000) {
    if (this.#lookout) return;
    const tick = async () => {
      if (this.#looking) return;
      this.#looking = true;
      try {
        for (const tv of this.tvs) {
          const d = this.#drivers.get(tv.id);
          if (!tv.credentials || !d?.reconnect || d.state?.online) continue;
          let up = false;
          for (const port of REACH_PORTS[tv.brand] ?? []) if (!up) up = await (this.portOpenFn ?? portOpen)(tv.ip, port, 900);
          if (up) this.kick(tv.id);
          // Once per visit: maybe it moved rather than switched off.
          else if (!this.#sought.has(tv.id)) {
            this.#sought.add(tv.id);
            this.seek();
          }
        }
      } finally {
        this.#looking = false;
      }
    };
    this.#lookout = setInterval(() => tick().catch(() => {}), everyMs);
    this.#lookout.unref?.();
  }
  #sought = new Set();
  #stopLookout() {
    this.#sought.clear();
    clearInterval(this.#lookout);
    this.#lookout = null;
  }
  // A fresh connection now (at most every 8 s per TV unless forced).
  kick(id, { force = false } = {}) {
    const t = Date.now();
    if (!force && t - (this.#kicked.get(id) ?? 0) < (this.kickGapMs ?? 8000)) return;
    this.#kicked.set(id, t);
    Promise.resolve()
      .then(() => this.#drivers.get(id)?.reconnect?.())
      .catch(() => {});
  }

  // Installed apps per TV, cached: the launcher resolves "YouTube TV" → this
  // TV's own id from here without asking every TV every time.
  #apps = new Map();
  async apps(id, { fresh = false, maxAge = 10 * 60_000 } = {}) {
    const driver = this.driver(id);
    const hit = this.#apps.get(id);
    if (!fresh && hit && Date.now() - hit.at < maxAge) return hit.list;
    try {
      const list = await driver.apps();
      this.#apps.set(id, { at: Date.now(), list });
      return list;
    } catch (err) {
      if (hit) return hit.list; // stale beats nothing (the TV may be asleep)
      throw err;
    }
  }

  cachedApps(id) {
    return this.#apps.get(id)?.list ?? null;
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

  // ── energy: what each TV costs to run ──
  energyReport() {
    return this.energy.report(this.tvs, this.telemetry, (tv) => modelYear(tv.brand, tv.model)?.year ?? null);
  }

  // The phone sends scrubbed charge lines or a cropped photo; Hearth Cloud's
  // AI reads the numbers; only those are kept.
  async readBill(body, { provider, model, key }) {
    const data = await this.insights.bill(billRequest(body), { provider, model, key });
    await this.energy.setBill(data.bill, { via: data.model ?? null });
    return { ...this.energyReport(), read: { model: data.model, providerLabel: data.providerLabel, billedTo: data.billedTo, ms: data.ms, costUsd: data.costUsd } };
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
