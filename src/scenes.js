import { EventEmitter } from 'node:events';
import { queue, readJson, writeJson } from './jsonfile.js';
import path from 'node:path';
import { runAction } from './bulk.js';
import { badRequest, notFound } from './errors.js';
import { hearthHome } from './store.js';
import { log } from './log.js';

// Scenes: a named list of steps across TVs ("Movie night": living room on,
// volume 20, open Netflix), runnable with one tap or on a weekly schedule.
const STEP_ACTIONS = ['power', 'volume', 'mute', 'launch', 'input', 'say', 'key', 'wait'];
const MAX_STEPS = 24;
const clean = (s, max = 40) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

export class SceneStore {
  constructor(dir = hearthHome()) {
    this.dir = dir;
    this.file = path.join(dir, 'scenes.json');
  }

  // null on first run (seed templates). A corrupt file falls back to the
  // backup, else to null (re-seeded), with the bad copy kept aside.
  load() {
    return readJson(this.file, (d) => (Array.isArray(d?.scenes) ? d.scenes : undefined), null);
  }

  #enqueue = queue();
  save(scenes) {
    const snapshot = { version: 1, scenes: JSON.parse(JSON.stringify(scenes)) };
    return this.#enqueue(() => writeJson(this.file, snapshot));
  }
}

// Validate a scene coming from the app. Unknown fields are dropped.
export function sanitizeScene(input = {}, base = {}) {
  const scene = { ...base };
  if (input.name !== undefined) scene.name = clean(input.name) || 'Scene';
  if (input.emoji !== undefined) scene.emoji = [...clean(input.emoji, 16)].slice(0, 2).join('') || '✨';
  if (input.steps !== undefined) {
    if (!Array.isArray(input.steps)) throw badRequest('steps must be a list');
    scene.steps = input.steps.slice(0, MAX_STEPS).map((st) => {
      if (!STEP_ACTIONS.includes(st?.action)) throw badRequest(`Unknown step: ${st?.action}`);
      const target = st.target === 'all' ? 'all' : Array.isArray(st.target) ? st.target.map(String).slice(0, 50) : 'all';
      const args = st.args && typeof st.args === 'object' ? JSON.parse(JSON.stringify(st.args)) : {};
      return { target, action: st.action, args };
    });
  }
  if (input.schedule !== undefined) {
    if (input.schedule === null) scene.schedule = null;
    else {
      const days = (Array.isArray(input.schedule.days) ? input.schedule.days : []).map(Number).filter((d) => d >= 0 && d <= 6);
      const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(input.schedule.time ?? '') ? input.schedule.time : '21:00';
      scene.schedule = { days: [...new Set(days)].sort(), time, enabled: Boolean(input.schedule.enabled) };
    }
  }
  return scene;
}

// First-run templates, aimed at the TVs already in the house.
export function seedScenes(tvs = []) {
  const living = tvs.find((t) => t.brand === 'lg') ?? tvs[0];
  const target = living ? [living.id] : 'all';
  return [
    { id: 'everything-off', name: 'Everything off', emoji: '🌙', steps: [{ target: 'all', action: 'power', args: { on: false } }], schedule: null },
    {
      id: 'movie-night',
      name: 'Movie night',
      emoji: '🍿',
      steps: [
        { target, action: 'power', args: { on: true } },
        { target, action: 'volume', args: { level: 20 } },
        { target, action: 'launch', args: { title: 'Netflix' } },
      ],
      schedule: null,
    },
    {
      id: 'school-night',
      name: 'School night',
      emoji: '📚',
      steps: [{ target: 'all', action: 'power', args: { on: false } }],
      schedule: { days: [0, 1, 2, 3, 4], time: '21:00', enabled: false },
    },
  ];
}

const minuteKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// When a schedule next fires, from `now` (local time). null when off.
export function nextRun(scene, now = new Date()) {
  const s = scene.schedule;
  if (!s?.enabled || !s.days?.length) return null;
  const [h, m] = s.time.split(':').map(Number);
  for (let i = 0; i <= 7; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (s.days.includes(d.getDay()) && d > now) return d;
  }
  return null;
}

export class Scenes extends EventEmitter {
  constructor({ hub, store = new SceneStore(), clock = () => new Date(), waitOnlineMs = 25_000, pollMs = 1000 }) {
    super();
    this.hub = hub;
    this.store = store;
    this.clock = clock;
    this.waitOnlineMs = waitOnlineMs;
    this.pollMs = pollMs;
    this.scenes = [];
    this.running = new Set();
  }

  async init() {
    const loaded = await this.store.load();
    if (loaded) this.scenes = loaded;
    else {
      this.scenes = seedScenes(this.hub.tvs);
      await this.store.save(this.scenes);
    }
    return this;
  }

  view(scene) {
    const next = nextRun(scene, this.clock());
    return { ...scene, nextRun: next ? next.toISOString() : null, running: this.running.has(scene.id) };
  }

  list() {
    return this.scenes.map((s) => this.view(s));
  }

  get(id) {
    const scene = this.scenes.find((s) => s.id === id);
    if (!scene) throw notFound('Scene');
    return scene;
  }

  #changed() {
    this.emit('changed', this.list());
    return this.store.save(this.scenes);
  }

  async create(input) {
    const scene = sanitizeScene({ name: 'New scene', emoji: '✨', steps: [], schedule: null, ...input });
    scene.id = `${clean(scene.name, 24).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scene'}-${Date.now().toString(36)}`;
    this.scenes.push(scene);
    await this.#changed();
    return this.view(scene);
  }

  async update(id, patch) {
    const scene = this.get(id);
    Object.assign(scene, sanitizeScene(patch, {}));
    await this.#changed();
    return this.view(scene);
  }

  async remove(id) {
    this.get(id);
    this.scenes = this.scenes.filter((s) => s.id !== id);
    await this.#changed();
    return { ok: true };
  }

  #targets(step) {
    const paired = this.hub.tvs.filter((t) => t.credentials).map((t) => t.id);
    if (step.target === 'all') return paired;
    return step.target.filter((id) => this.hub.tvs.some((t) => t.id === id));
  }

  async #waitOnline(ids) {
    const deadline = Date.now() + this.waitOnlineMs;
    const pending = new Set(ids);
    while (pending.size && Date.now() < deadline) {
      for (const id of [...pending]) {
        const tv = this.hub.tvs.find((t) => t.id === id);
        if (!tv || this.hub.view(tv).state?.online) pending.delete(id);
      }
      if (pending.size) await new Promise((r) => setTimeout(r, this.pollMs));
    }
    return pending; // still offline after waiting
  }

  // Run steps in order; every TV gets its own result per step. Emits
  // 'progress' after each step so the app can animate the scene card.
  async run(id, { trigger = 'manual' } = {}) {
    const scene = this.get(id);
    const out = await this.#play(id, scene, trigger);
    if (out.error) return out;
    scene.lastRun = this.clock().toISOString();
    await this.#changed();
    return out;
  }

  // "Try it": play a draft from the editor without saving it. Progress goes
  // out under the id 'draft'.
  async tryDraft(input) {
    const scene = sanitizeScene({ name: 'Scene', emoji: '✨', steps: [], ...input, schedule: null });
    if (!scene.steps.length) throw badRequest('Add a step first');
    return this.#play('draft', scene, 'try');
  }

  async #play(id, scene, trigger) {
    if (this.running.has(id)) return { ok: false, error: 'Already running' };
    this.running.add(id);
    const steps = [];
    const total = scene.steps.length;
    this.emit('progress', { id, name: scene.name, step: 0, total, done: false, trigger });
    try {
      for (const [i, step] of scene.steps.entries()) {
        let results;
        if (step.action === 'wait') {
          await new Promise((r) => setTimeout(r, Math.min(60, Math.max(0, Number(step.args?.seconds) || 1)) * 1000));
          results = [];
        } else {
          const ids = this.#targets(step);
          const settled = await Promise.allSettled(ids.map((tvIdValue) => runAction(this.hub, tvIdValue, step.action, step.args)));
          results = ids.map((tvIdValue, j) => ({
            id: tvIdValue,
            ok: settled[j].status === 'fulfilled',
            ...(settled[j].status === 'rejected' ? { error: settled[j].reason?.message ?? 'Failed' } : {}),
          }));
          // Turning on takes a while; later steps need the TVs awake.
          if (step.action === 'power' && step.args?.on !== false) {
            const late = await this.#waitOnline(ids.filter((_, j) => results[j].ok));
            for (const r of results) if (late.has(r.id)) Object.assign(r, { ok: false, error: 'Didn’t wake up in time' });
          }
        }
        steps.push({ action: step.action, results });
        this.emit('progress', { id, name: scene.name, step: i + 1, total, done: false, results, trigger });
      }
    } finally {
      this.running.delete(id);
    }
    const ok = steps.every((s) => s.results.every((r) => r.ok));
    this.emit('progress', { id, name: scene.name, step: total, total, done: true, ok, trigger });
    return { ok, steps };
  }

  // Schedules: check the clock every `everyMs`; fire a scene once in its
  // minute. Missed minutes (Hearth was down) are skipped, never replayed.
  #fired = new Map();
  tick() {
    const now = this.clock();
    const key = minuteKey(now);
    const fired = [];
    for (const scene of this.scenes) {
      const s = scene.schedule;
      if (!s?.enabled || !s.days.includes(now.getDay()) || s.time !== hhmm(now)) continue;
      if (this.#fired.get(scene.id) === key) continue;
      this.#fired.set(scene.id, key);
      fired.push(scene.id);
      this.run(scene.id, { trigger: 'schedule' }).catch((err) => log.warn('[hearth] scene failed:', err.message));
    }
    return fired;
  }

  #timer = null;
  start(everyMs = 20_000) {
    this.#timer = setInterval(() => this.tick(), everyMs);
    this.#timer.unref?.();
  }

  stop() {
    clearInterval(this.#timer);
  }
}
