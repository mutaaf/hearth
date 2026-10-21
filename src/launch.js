import { CATALOG, catalogApp, matchTitle, resolveApp } from './catalog.js';
import { badRequest, HearthError } from './errors.js';

// "Open YouTube TV on every TV": wake the ones that are off (if asked), find
// each TV's own id for the app, launch everywhere in parallel, and report back
// per TV with a reason when it couldn't (not installed, can't be launched on
// that kind of TV, didn't wake up…).

// Awake enough to take a launch. 'unknown' = a 2016-17 Samsung that answers
// but can't say whether its panel is on; never toggle those blindly.
const LAUNCH_WAKES = new Set(['roku', 'androidtv']);
const LISTS_ASLEEP = new Set(['roku', 'androidtv', 'appletv']); // can say what's installed from standby
const awake = (state) => Boolean(state?.online && (state.power === 'on' || state.power === 'unknown'));

class LaunchError extends HearthError {
  constructor(status, message, reason) {
    super(status, message);
    this.reason = reason;
  }
}

// Which id to open on this TV. `ref` is the launch vocabulary shared by the
// API, bulk and scenes: { app: 'youtubetv' | 'YouTube TV' } or { title } or { id }.
export async function resolveOnTv(hub, id, ref = {}) {
  const tv = hub.get(id);
  if (ref.id) return { id: String(ref.id), title: ref.title ?? null, via: 'id' };
  const name = String(ref.app ?? ref.title ?? '').trim();
  if (!name) throw badRequest('Which app?');
  const entry = catalogApp(name);
  const title = entry?.title ?? name;
  if (entry && !(entry.ids[tv.brand] ?? []).length && tv.brand === 'androidtv') {
    throw new LaunchError(501, `${title} can’t be opened on a Google TV without its own remote (no Cast app)`, 'unsupported');
  }
  let apps = null;
  try {
    apps = await hub.apps(id);
  } catch {
    // Can't list apps right now (asleep, or the brand can't): try the catalog
    // id blind. The TV itself says "not installed" if it's wrong.
  }
  const hit = entry ? resolveApp(entry, tv.brand, apps) : matchTitle(name, apps, tv.brand);
  if (hit) return hit;
  if (!apps) throw new LaunchError(503, `Couldn’t ask this TV which apps it has`, 'offline');
  throw new LaunchError(404, `${title} isn’t installed on this TV`, 'not-installed');
}

async function waitAwake(hub, id, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (awake(hub.view(hub.get(id)).state)) return true;
    await new Promise((r) => setTimeout(r, hub.pollMs ?? 500));
  }
  return false;
}

// One TV. Never throws: returns { id, name, ok, … } for the ✓ / ✕ chips.
export async function launchOne(hub, id, ref = {}, { wake = false } = {}) {
  const tv = hub.get(id);
  const out = { id, name: tv.name };
  try {
    if (!tv.credentials) throw new LaunchError(409, 'Not connected yet', 'unpaired');
    let woke = false;
    const state = hub.view(tv).state;
    // Rokus and Google TVs wake themselves to open an app from standby.
    const selfWakes = state?.online && LAUNCH_WAKES.has(tv.brand);
    if (!awake(state) && !selfWakes) {
      if (!wake) throw new LaunchError(503, state?.online ? 'It’s asleep (turn on “wake”)' : 'It’s off', 'off');
      await hub.power(id, true);
      woke = true;
      if (!(await waitAwake(hub, id, hub.wakeMs ?? 25_000))) throw new LaunchError(503, 'Didn’t wake up in time', 'offline');
      // Freshly awake sets need a moment before their app launcher answers.
      await new Promise((r) => setTimeout(r, hub.wakeSettleMs ?? 1500));
    }
    const target = await resolveOnTv(hub, id, ref);
    await hub.driver(id).launch(target.id);
    hub.settle(id);
    return { ...out, ok: true, appId: target.id, title: target.title, via: target.via, ...(woke ? { woke } : {}) };
  } catch (err) {
    const reason = err.reason ?? (err.status === 503 ? 'offline' : err.status === 501 ? 'unsupported' : err.status === 404 ? 'not-installed' : 'failed');
    return { ...out, ok: false, reason, error: err.message || 'Failed' };
  }
}

// POST /api/launch { app, tvs: 'all' | [ids], wake }
export async function launchOn(hub, { app, id: appId, title, tvs = 'all', wake = false } = {}) {
  const ref = appId ? { id: String(appId) } : { app: app ?? title };
  if (!ref.id && !String(ref.app ?? '').trim()) throw badRequest('Which app? e.g. { "app": "youtubetv" }');
  if (ref.app && !catalogApp(ref.app) && String(ref.app).length > 60) throw badRequest('App name too long');
  const ids =
    tvs === 'all' || tvs == null
      ? hub.tvs.filter((t) => t.credentials).map((t) => t.id)
      : Array.isArray(tvs)
        ? [...new Set(tvs.map(String))].filter((id) => hub.tvs.some((t) => t.id === id))
        : [];
  if (!ids.length) throw badRequest('Pick at least one TV');
  const entry = ref.app ? catalogApp(ref.app) : null;
  const results = await Promise.all(ids.map((id) => launchOne(hub, id, ref, { wake: Boolean(wake) })));
  return { app: entry?.key ?? null, title: entry?.title ?? ref.app ?? null, ok: results.every((r) => r.ok), results };
}

// Per-TV view of the catalog for the app: which apps each TV has, from the
// cached app lists (fetched for TVs that are awake). Never wakes anything.
export async function catalogStatus(hub, { fresh = false } = {}) {
  const tvs = {};
  await Promise.all(
    hub.tvs.filter((t) => t.credentials).map(async (tv) => {
      const state = hub.view(tv).state;
      let apps = hub.cachedApps(tv.id);
      // Rokus, Google TVs and Apple TVs list apps from standby; LG/Samsung only when awake
      // (opening a Samsung's remote socket can wake some sets).
      const canAsk = LISTS_ASLEEP.has(tv.brand) ? state?.online : awake(state);
      if ((fresh || !apps) && canAsk) apps = await hub.apps(tv.id, { fresh }).catch(() => apps);
      const row = {};
      for (const e of CATALOG) {
        const ids = e.ids[tv.brand] ?? [];
        if (!ids.length && tv.brand === 'androidtv') {
          row[e.key] = { installed: false, reason: 'unsupported' };
          continue;
        }
        if (!apps) {
          row[e.key] = { installed: null };
          continue;
        }
        const hit = resolveApp(e, tv.brand, apps);
        row[e.key] = hit ? { installed: true, appId: hit.id } : { installed: false, reason: 'not-installed' };
      }
      tvs[tv.id] = row;
    }),
  );
  return tvs;
}
