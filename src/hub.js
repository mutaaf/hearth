import { EventEmitter } from 'node:events';
import { badRequest, HearthError, notFound } from './errors.js';
import { discover, isIPv4, isMac, probe, tvId } from './discovery.js';
import { LgDriver } from './drivers/lg.js';
import { SamsungDriver } from './drivers/samsung.js';

export const DRIVERS = { lg: LgDriver, samsung: SamsungDriver };

// The hub owns the list of TVs and one live driver per TV. The HTTP server is
// a thin layer over it; tests drive it directly with fake drivers.
export class Hub extends EventEmitter {
  #drivers = new Map();

  constructor({ store, drivers = DRIVERS, discoverFn = discover, probeFn = probe } = {}) {
    super();
    this.store = store;
    this.driverClasses = drivers;
    this.discoverFn = discoverFn;
    this.probeFn = probeFn;
    this.tvs = [];
  }

  async init() {
    this.tvs = await this.store.load();
    for (const tv of this.tvs) this.#attach(tv);
    return this;
  }

  async close() {
    await Promise.all([...this.#drivers.values()].map((d) => d.stop()));
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
    driver.on('state', () => this.emit('change', this.view(tv)));
    driver.on('connection-error', () => {});
    this.#drivers.set(tv.id, driver);
    if (tv.credentials) driver.start();
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
      capabilities: driver?.capabilities ?? {},
      state: driver?.state ?? { online: false, power: 'unknown' },
    };
  }

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
    const found = await this.discoverFn();
    return found.map((tv) => ({ ...tv, added: this.tvs.some((t) => t.id === tv.id || t.ip === tv.ip) }));
  }

  async add(input = {}) {
    const ip = String(input.ip ?? '').trim();
    if (!isIPv4(ip)) throw badRequest('That doesn’t look like an IP address (e.g. 192.168.1.40)');
    const existing = this.tvs.find((t) => t.ip === ip);
    if (existing) return this.view(existing);

    let found;
    if (input.brand) {
      if (!this.driverClasses[input.brand]) throw badRequest(`Unsupported brand: ${input.brand}`);
      const macs = (Array.isArray(input.macs) ? input.macs : []).filter(isMac).map((m) => m.toLowerCase());
      found = { brand: input.brand, name: input.name, model: input.model, ip, macs };
    } else {
      found = await this.probeFn(ip);
      if (!found) throw new HearthError(404, 'No LG or Samsung TV answered at that address. Is it switched on?');
    }

    const tv = {
      id: tvId(found.brand, found.macs, ip),
      brand: found.brand,
      name: clean(found.name) || (found.brand === 'lg' ? 'LG TV' : 'Samsung TV'),
      model: clean(found.model),
      room: clean(input.room),
      ip,
      macs: found.macs ?? [],
      addedAt: new Date().toISOString(),
    };
    if (this.tvs.some((t) => t.id === tv.id)) tv.id += `-${Date.now().toString(36)}`;
    this.tvs.push(tv);
    await this.store.save(this.tvs);
    this.#attach(tv);
    this.emit('change', this.view(tv));
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
    this.tvs = this.tvs.filter((t) => t !== tv);
    await this.store.save(this.tvs);
    this.emit('removed', { id });
    return { ok: true };
  }

  async pair(id) {
    const tv = this.get(id);
    await this.driver(id).pair();
    // Make sure the new pairing key is on disk before we report success.
    await this.store.save(this.tvs);
    return this.view(tv);
  }

  async power(id, on) {
    const driver = this.driver(id);
    await (on ? driver.powerOn() : driver.powerOff());
    return { ok: true };
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

const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
