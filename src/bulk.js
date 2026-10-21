import { badRequest, HearthError, unsupported } from './errors.js';
import { launchOne } from './launch.js';
import { runDoctor } from './doctor.js';

// One action on one TV, in the same vocabulary for bulk select and scenes.
// Returns nothing on success; throws (with a friendly message) on failure.
export const ACTIONS = ['power', 'volume', 'mute', 'launch', 'input', 'say', 'key', 'room', 'forget', 'doctor'];

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAction(hub, id, action, args = {}) {
  const tv = hub.get(id);
  const driver = hub.driver(id);
  const view = hub.view(tv);
  switch (action) {
    case 'power':
      return hub.power(id, args.on !== false);
    case 'volume': {
      if (Number.isFinite(args.level) && view.capabilities?.volumeLevel) return driver.setVolume(args.level);
      // No absolute level on this TV: nudge it instead.
      const delta = Number.isFinite(args.delta)
        ? args.delta
        : Number.isFinite(args.level) && view.state?.volume != null
          ? args.level - view.state.volume
          : 0;
      if (!delta) throw badRequest('This TV only does volume up/down; pick + or −');
      for (let i = 0; i < Math.min(Math.abs(delta), 20); i++) {
        await driver.key(delta > 0 ? 'volup' : 'voldown');
        await pause(120);
      }
      return;
    }
    case 'mute': {
      const want = args.on !== false;
      // Only toggle when the TV says it's in the other state (or can't say).
      if (view.state?.muted === want) return;
      return driver.key('mute');
    }
    case 'launch': {
      // { app: 'youtubetv' } (catalog key or name), { title } or { id }. The
      // catalog resolves each TV's own id; titles never confuse YouTube with
      // YouTube TV (see catalog.js).
      const ref = args.id ? { id: String(args.id) } : { app: args.app ?? args.title };
      if (!ref.id && !ref.app) throw badRequest('Which app?');
      const r = await launchOne(hub, id, ref, { wake: Boolean(args.wake) });
      if (!r.ok) throw new HearthError(r.reason === 'not-installed' ? 400 : 409, r.error);
      return;
    }
    case 'input':
      return driver.setInput(String(args.id ?? ''));
    case 'say':
      if (!view.capabilities?.toast) throw unsupported('On-screen messages');
      return driver.toast(String(args.message ?? '').trim() || 'Hello from Hearth 👋');
    case 'key':
      return driver.key(String(args.key ?? ''), args.hold ? { hold: args.hold } : {});
    case 'room':
      return hub.update(id, { ...(args.name ? { name: args.name } : {}), ...(args.room !== undefined ? { room: args.room } : {}) });
    case 'forget':
      return hub.remove(id);
    case 'doctor': {
      // "Fix connections": run the doctor; a TV that still isn't right fails
      // with the doctor's own one-line reason.
      const report = await runDoctor(hub, id);
      if (!report.ok) throw new Error(report.summary);
      return;
    }
    default:
      throw badRequest(`Unknown action: ${action}`);
  }
}

// The same action on many TVs at once, in parallel. Never throws: every TV
// gets its own result so the app can show ✓ / ✕ chips.
export async function bulk(hub, ids, action, args = {}) {
  if (!Array.isArray(ids) || !ids.length) throw badRequest('Pick at least one TV');
  if (!ACTIONS.includes(action)) throw badRequest(`Unknown action: ${action}`);
  const known = ids.filter((id) => hub.tvs.some((t) => t.id === id));
  const names = new Map(known.map((id) => [id, hub.tvs.find((t) => t.id === id).name])); // before a forget removes them
  const results = await Promise.allSettled(known.map((id) => runAction(hub, id, action, args)));
  // Re-read the TVs shortly after, so the app shows what really happened.
  if (action !== 'forget' && action !== 'room') for (const id of known) hub.settle?.(id);
  return known.map((id, i) => ({
    id,
    name: names.get(id),
    ok: results[i].status === 'fulfilled',
    ...(results[i].status === 'rejected' ? { error: results[i].reason?.message ?? 'Failed' } : {}),
  }));
}
