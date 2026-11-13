import { badRequest } from './errors.js';

// "Tell everyone": one message to every TV in the house ("Dinner's ready").
// Only LG (webOS toasts) can put words over the picture; every other brand
// gets a plain reason, and optionally a pause so the people watching it
// still notice.
//
//   GET  /api/announce → { tvs: [{ id, name, room, brand, can, why?, pause }] }
//   POST /api/announce { message, pause? } → { results: [{ id, name, ok, how?, why? }] }
//     how: 'shown' (on screen) | 'paused' (couldn't show it, paused instead)
//     ok:false + why: skipped (off, can't show it) or failed (the TV's error)

export const MAX_MESSAGE = 120;

// Why a brand can't show a message: true for every TV of that brand, so it's
// said the same way everywhere (the sheet, the results, the Say tab).
export const NO_MESSAGES = {
  samsung: "Samsung TVs don't take on-screen messages from phones",
  roku: "Roku doesn't let apps put messages over the picture",
  appletv: "Apple TV doesn't let other apps put words on the screen",
  androidtv: "Google TV can't show a message without stopping what's on",
};

// Whether this TV would show a message right now, and if not, why.
export function sayWhy(view) {
  if (!view.paired) return 'Not connected to Hearth yet';
  if (!view.capabilities?.toast) return NO_MESSAGES[view.brand] ?? "This TV can't show messages";
  if (!view.state?.online || view.state?.power !== 'on') return "It's off: messages show only on a TV that's on";
  return null;
}

// Can we pause what's playing, without risking the opposite? Roku's and
// Apple TV's pause is a toggle, so only when the TV says it's playing;
// Samsung has a real Pause key, so any on Samsung that's in an app.
export function canPause(view) {
  const s = view.state ?? {};
  if (!view.paired || !s.online || s.power !== 'on') return false;
  if (view.brand === 'roku') return s.media?.state === 'playing';
  if (view.brand === 'appletv') return s.playing === 'playing';
  if (view.brand === 'samsung') return Boolean(s.app);
  return false;
}

export function announcePlan(hub) {
  return {
    tvs: hub.list().map((v) => {
      const why = sayWhy(v);
      return { id: v.id, name: v.name, room: v.room ?? '', brand: v.brand, can: !why, ...(why ? { why } : {}), pause: Boolean(why) && canPause(v) };
    }),
  };
}

export async function announce(hub, { message, pause = false } = {}) {
  const text = String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE);
  if (!text) throw badRequest('Type a message first');
  const views = hub.list();
  if (!views.length) throw badRequest('Add a TV first');
  const results = await Promise.all(
    views.map(async (v) => {
      const base = { id: v.id, name: v.name };
      const why = sayWhy(v);
      try {
        if (!why) {
          await hub.driver(v.id).toast(text);
          return { ...base, ok: true, how: 'shown' };
        }
        if (pause && canPause(v)) {
          await hub.driver(v.id).key('pause');
          return { ...base, ok: true, how: 'paused', why };
        }
        return { ...base, ok: false, why };
      } catch (err) {
        return { ...base, ok: false, why: String(err?.message ?? err).slice(0, 160) || 'It didn’t answer' };
      }
    }),
  );
  for (const r of results) if (r.how === 'paused') hub.settle?.(r.id);
  return { message: text, results };
}
