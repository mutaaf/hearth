// Is the TV playing something, or is someone looking for something to play?
// Pure and shared: drivers use the parsers, the remote uses phaseOf() to pick
// between the Stream Center (playback) and the D-pad (browsing).
//
// state.media = { state: 'playing'|'paused'|'buffering'|'stopped', position,
// duration (ms, may be null), live, at (ms epoch when position was read),
// source: 'roku'|'lg'|'appletv' }. null when the TV can't tell.

// Roku ECP /query/media-player.
//   <player error="false" state="play"><position>51400 ms</position>
//   <duration>2700000 ms</duration><is_live>false</is_live>…</player>
export function parseRokuPlayer(xml, now = Date.now()) {
  const m = String(xml ?? '').match(/<player\b[^>]*\bstate="([^"]+)"/);
  if (!m) return null;
  const state = { play: 'playing', pause: 'paused', buffer: 'buffering', startup: 'buffering', stop: 'stopped', close: 'stopped', finished: 'stopped', none: 'stopped' }[m[1]];
  if (!state) return null;
  const ms = (tag) => {
    const v = String(xml).match(new RegExp(`<${tag}>\\s*(\\d+)\\s*ms`));
    return v ? Number(v[1]) : null;
  };
  const live = /<is_live[^>]*>\s*true/i.test(xml);
  return { state, position: ms('position'), duration: live ? null : ms('duration'), live, at: now, source: 'roku' };
}

// webOS ssap://com.webos.media/getForegroundAppInfo →
//   { foregroundAppInfo: [{ appId, playState: 'playing'|'paused'|'loaded'|'unloaded'|… }] }
export function parseLgMedia(res, now = Date.now()) {
  const info = res?.foregroundAppInfo;
  if (!Array.isArray(info)) return null;
  if (!info.length) return { state: 'stopped', position: null, duration: null, live: false, at: now, source: 'lg' };
  const s = String(info[0]?.playState ?? '');
  const state = { playing: 'playing', paused: 'paused', starting: 'buffering', loaded: 'buffering', buffering: 'buffering', unloaded: 'stopped', stopped: 'stopped' }[s];
  return state ? { state, position: null, duration: null, live: false, at: now, source: 'lg' } : null;
}

// Apple TV (pyatv via the bridge): playing/paused/loading + seconds.
export function fromAppleTv(s, now = Date.now()) {
  const state = { playing: 'playing', paused: 'paused', loading: 'buffering' }[s?.playing];
  if (!state) return null;
  const sec = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v * 1000) : null);
  return { state, position: sec(s.position), duration: sec(s.duration) || null, live: false, at: now, source: 'appletv' };
}

// Where playback is right now, ticking forward between reads while playing.
export function livePosition(media, now = Date.now()) {
  if (!media || media.position == null) return null;
  const run = media.state === 'playing' ? Math.max(0, now - (media.at ?? now)) : 0;
  const pos = media.position + run;
  return media.duration ? Math.min(pos, media.duration) : pos;
}

export function clock(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–:––';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const WATCHABLE = new Set(['streaming', 'live-tv', 'music', 'unknown']);
const NAV_KEYS = new Set(['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu']);
const PLAY_KEYS = new Set(['play', 'pause', 'rewind', 'forward', 'replay', 'stop']);

// Remembers what this phone last pressed, per TV: a hint when the TV can't say.
export function keyMemory() {
  const last = new Map(); // tvId → { nav, play }
  return {
    note(tvId, key, now = Date.now()) {
      const m = last.get(tvId) ?? { nav: 0, play: 0 };
      if (NAV_KEYS.has(key)) m.nav = now;
      if (PLAY_KEYS.has(key)) m.play = now;
      last.set(tvId, m);
    },
    get: (tvId) => last.get(tvId) ?? { nav: 0, play: 0 },
  };
}

// → { phase: 'playback'|'browse'|'other', confidence, why }
//   playback: show the Stream Center. browse: show the D-pad.
export function phaseOf(tv, activity, keys = { nav: 0, play: 0 }, now = Date.now()) {
  const kind = activity?.kind ?? 'unknown';
  if (!WATCHABLE.has(kind)) return { phase: kind === 'home' || kind === 'idle' ? 'browse' : 'other', confidence: 0.9, why: kind };
  const media = tv?.state?.media;
  // The TV says so: trust it.
  if (media?.state === 'playing' || media?.state === 'paused' || media?.state === 'buffering') return { phase: 'playback', confidence: 0.95, why: `${media.source}:${media.state}` };
  if (media?.state === 'stopped' && media.source !== 'lg') return { phase: 'browse', confidence: 0.85, why: `${media.source}:stopped` };
  // Live TV is always "playing".
  if (kind === 'live-tv') return { phase: 'playback', confidence: 0.8, why: 'live-tv' };
  // No signal: read the person. Just pressed play/skip → watching. Moving
  // around in the last 30 s → browsing. An app open a while, untouched → watching.
  if (keys.play && keys.play >= keys.nav && now - keys.play < 10 * 60_000) return { phase: 'playback', confidence: 0.7, why: 'pressed-play' };
  if (keys.nav && now - keys.nav < 30_000) return { phase: 'browse', confidence: 0.7, why: 'navigating' };
  const since = activity?.since ?? tv?.since ?? null;
  if (kind !== 'unknown' && since && now - since > 90_000) return { phase: 'playback', confidence: 0.55, why: 'settled' };
  return { phase: 'browse', confidence: 0.5, why: 'just-opened' };
}
