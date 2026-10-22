import path from 'node:path';
import { chargeLines, checkImage, validateBill } from './bill-schema.js';
import { badRequest, HearthError } from './errors.js';
import { queue, readJson, writeJson } from './jsonfile.js';

// What each TV costs to run. Three numbers per TV:
//   watts on / in standby  an estimate from the model code (screen size, year,
//                          panel), or the household's own figure off the sticker
//   hours on               measured: Hearth's telemetry power history
//   price per kWh          from the last power bill (AI reads it, see
//                          src/bill-schema.js), typed by hand, or a default
// Only the numbers are kept, in ~/.hearth/energy.json (0600): never the bill.
const DAY = 86_400_000;
export const DEFAULT_PRICE = { pricePerKwh: 0.17, currency: 'USD', source: 'default' }; // ≈ US average, 2026

// Screen size from a model code: UN55KU6290 → 55, 55UP7000PUA → 55,
// OLED65C3PUA → 65, TCL 65A300W → 65, QN85Q80C → 85.
export function screenSize(model) {
  const m = String(model ?? '').toUpperCase().replace(/\s+/g, '');
  const hit = m.match(/^(?:TCL|HISENSE|SONY|KD-?|XR-?|UN|UE|QN|QE|GQ|KQ|OLED|NANO)?(\d{2})(?=[A-Z])/) ?? m.match(/(?:^|[A-Z-])(\d{2})(?=[A-Z]{1,3}\d)/);
  const n = hit ? Number(hit[1]) : null;
  return n >= 24 && n <= 100 ? n : null;
}

// Watts, roughly: an LED-lit panel's typical draw grows with its area. Older
// sets and OLEDs draw a bit more; Energy Star labels for 55″ sets sit around
// 60–100 W. Streaming sticks and boxes are small. Standby: 2016-17 Samsungs
// leave the network (~0.5 W); Google TVs keep Cast awake (~1.5 W).
export function estimatePower({ brand, model, year = null }) {
  const name = String(model ?? '');
  if (brand === 'roku' && !/TV|^\d{2}/i.test(name)) return { onW: 3, standbyW: 1.5, sizeIn: null, basis: 'streaming stick' };
  if (brand === 'appletv') return { onW: 3, standbyW: 0.3, sizeIn: null, basis: 'Apple TV box' };
  const sizeIn = screenSize(name);
  const oled = /OLED|^(QN|QE)\d{2}S9/i.test(name);
  const age = year ? (year <= 2017 ? 1.2 : year <= 2020 ? 1 : 0.9) : 1;
  const onW = sizeIn ? Math.round(0.026 * sizeIn * sizeIn * age * (oled ? 1.15 : 1)) : 70;
  const standbyW = brand === 'androidtv' ? 1.5 : brand === 'samsung' && year && year <= 2017 ? 0.5 : 0.5;
  const basis = [sizeIn ? `${sizeIn}″` : 'unknown size', oled ? 'OLED' : 'LED', year ? String(year) : null].filter(Boolean).join(' · ');
  return { onW, standbyW, sizeIn, basis };
}

const clampW = (v, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 10) / 10 : null;
};

export class Energy {
  #enqueue = queue();
  constructor({ dir = null, now = () => Date.now() } = {}) {
    this.file = dir ? path.join(dir, 'energy.json') : null;
    this.now = now;
    this.price = { ...DEFAULT_PRICE };
    this.bill = null;
    this.watts = {};
  }

  async load() {
    if (!this.file) return this;
    const d = await readJson(this.file, (x) => (x && typeof x === 'object' ? x : undefined), {});
    if (d.price?.pricePerKwh > 0) this.price = d.price;
    this.bill = d.bill ?? null;
    this.watts = d.watts && typeof d.watts === 'object' ? d.watts : {};
    return this;
  }

  save() {
    if (!this.file) return Promise.resolve();
    const snapshot = { version: 1, price: this.price, bill: this.bill, watts: this.watts };
    return this.#enqueue(() => writeJson(this.file, snapshot, { backup: true }));
  }

  // The AI read a bill (validated again here: the hub never trusts the wire).
  async setBill(b, meta = {}) {
    const bill = b && validateBill({ currency: b.currency, total: b.total, kwh: b.kwh, days: b.days, period_start: b.start, period_end: b.end, energy_rate: b.energyRate, fixed_charges: b.fixed, price_per_kwh: b.pricePerKwh, confidence: b.confidence, note: b.note });
    if (bill && b.priceSource && bill.priceSource === 'bill') bill.priceSource = String(b.priceSource).slice(0, 20);
    if (!bill) throw new HearthError(502, 'Couldn’t find a price per kWh on that bill. Type it instead.');
    this.bill = { ...bill, at: this.now(), via: meta.via ?? null };
    this.price = { pricePerKwh: bill.pricePerKwh, currency: bill.currency, source: 'bill' };
    await this.save();
  }

  async setPrice({ pricePerKwh, currency }) {
    let p = Number(pricePerKwh);
    if (p > 3 && p < 300) p /= 100; // typed in cents
    if (!(p >= 0.01 && p <= 2)) throw badRequest('Price per kWh should be between 0.01 and 2 (e.g. 0.17 for 17¢)');
    const cur = /^[A-Z]{3}$/.test(String(currency ?? '').toUpperCase()) ? String(currency).toUpperCase() : this.price.currency;
    this.price = { pricePerKwh: Math.round(p * 10000) / 10000, currency: cur, source: 'manual' };
    await this.save();
  }

  async clear() {
    this.price = { ...DEFAULT_PRICE };
    this.bill = null;
    await this.save();
  }

  async setWatts(id, { onW, standbyW } = {}) {
    if (onW === null && standbyW === null) delete this.watts[id];
    else {
      const on = clampW(onW, 1500);
      const sb = clampW(standbyW, 60);
      if (on == null && onW != null) throw badRequest('Watts when on should be 0–1500');
      if (sb == null && standbyW != null) throw badRequest('Standby watts should be 0–60');
      this.watts[id] = { ...(this.watts[id] ?? {}), ...(on != null ? { onW: on } : {}), ...(sb != null ? { standbyW: sb } : {}) };
    }
    await this.save();
  }

  forget(id) {
    if (!this.watts[id]) return;
    delete this.watts[id];
    this.save().catch(() => {});
  }

  power(tv, year) {
    const est = estimatePower({ brand: tv.brand, model: tv.model, year });
    const mine = this.watts[tv.id] ?? {};
    return { ...est, onW: mine.onW ?? est.onW, standbyW: mine.standbyW ?? est.standbyW, yours: mine.onW != null || mine.standbyW != null, estimate: est };
  }

  // The report the app draws: per TV and for the house.
  report(tvs, telemetry, yearOf = () => null) {
    const now = this.now();
    const { pricePerKwh, currency } = this.price;
    const cost = (kwh) => Math.round(kwh * pricePerKwh * 100) / 100;
    const rows = tvs.map((tv) => {
      const p = this.power(tv, yearOf(tv));
      const days = telemetry.onByDay(tv.id, 14); // [{ day, from, to, onMs, spanMs }]
      const tracked = days.reduce((a, d) => a + d.spanMs, 0);
      const onMs = days.reduce((a, d) => a + d.onMs, 0);
      const kwhOf = (on, span) => (on * p.onW + (span - on) * p.standbyW) / 3_600_000 / 1000;
      const daily = days.map((d) => ({ day: d.day, onH: Math.round((d.onMs / 3_600_000) * 10) / 10, kwh: Math.round(kwhOf(d.onMs, d.spanMs) * 1000) / 1000, cost: cost(kwhOf(d.onMs, d.spanMs)) }));
      // Average day from what Hearth has seen (needs a few hours to mean much).
      const perDayOnH = tracked ? (onMs / tracked) * 24 : 0;
      const perDayKwh = tracked ? (kwhOf(onMs, tracked) / tracked) * DAY : 0;
      const standbyKwhYear = tracked ? (((tracked - onMs) * p.standbyW) / 3_600_000 / 1000 / tracked) * DAY * 365 : 0;
      return {
        id: tv.id,
        name: tv.name,
        brand: tv.brand,
        model: tv.model ?? '',
        watts: { on: p.onW, standby: p.standbyW, sizeIn: p.sizeIn, basis: p.basis, yours: p.yours, estimate: { on: p.estimate.onW, standby: p.estimate.standbyW } },
        trackedH: Math.round((tracked / 3_600_000) * 10) / 10,
        onHPerDay: Math.round(perDayOnH * 10) / 10,
        kwhPerDay: Math.round(perDayKwh * 1000) / 1000,
        perMonth: cost(perDayKwh * 30.44),
        perYear: cost(perDayKwh * 365),
        standbyPerYear: cost(standbyKwhYear),
        daily,
      };
    });
    const sum = (k) => Math.round(rows.reduce((a, r) => a + r[k], 0) * 100) / 100;
    const kwhMonth = rows.reduce((a, r) => a + r.kwhPerDay * 30.44, 0);
    const billKwhMonth = this.bill?.kwh && this.bill?.days ? (this.bill.kwh / this.bill.days) * 30.44 : null;
    return {
      price: { pricePerKwh, currency, source: this.price.source },
      bill: this.bill,
      tvs: rows,
      house: {
        perMonth: sum('perMonth'),
        perYear: sum('perYear'),
        standbyPerYear: sum('standbyPerYear'),
        kwhPerMonth: Math.round(kwhMonth * 10) / 10,
        shareOfBill: billKwhMonth ? Math.round((kwhMonth / billKwhMonth) * 1000) / 10 : null,
        trackedH: Math.max(0, ...rows.map((r) => r.trackedH)),
      },
      at: now,
    };
  }
}

// What the phone may send for a bill: scrubbed lines (re-scrubbed here), or a
// cropped photo. Returns the body for the cloud reader.
export function billRequest(body) {
  if (body.image != null) {
    const image = checkImage(body.image);
    if (!image) throw badRequest('That photo is too big or not a JPEG/PNG');
    return { image: image.dataUrl };
  }
  const lines = chargeLines((Array.isArray(body.lines) ? body.lines : []).map(String).join('\n'));
  if (lines.length < 2) throw badRequest('No charges found in that bill. Try the page with the charges, or a photo of them.');
  return { lines };
}
