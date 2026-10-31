// "Just say it": a scene from a sentence ("kids' bedtime on school nights:
// basement TV quiet, say goodnight, then off"). Shared by the hub (builds the
// request, restores the answer) and the Worker (sanitises again, asks the AI,
// validates).
//
// Privacy: the AI never sees a TV's or room's name. The hub swaps every name
// for a token (TV1, TV2…) in the text and the TV list, and swaps the tokens
// back in the answer. Long digit runs and email-looking words are dropped.

export const SCENE_ACTIONS = ['power', 'volume', 'mute', 'launch', 'say', 'wait'];
export const SCENE_EMOJI = ['🌙', '🍿', '📚', '☀️', '🎮', '🏈', '🧸', '🎉', '🛋️', '🍽️', '🎬', '✨'];
const BRANDS = ['lg', 'samsung', 'roku', 'androidtv', 'appletv'];
const MAX_TEXT = 240;
const MAX_STEPS = 12;
const REF = /^TV([1-9]|1\d|20)$/;

const flat = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const scrub = (s) =>
  flat(s, MAX_TEXT * 2)
    .replace(/\S+@\S+/g, '')
    .replace(/\d[\d\s-]{6,}\d/g, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// tvs: hub.list() views. → { request, refs: { TV1: id, … } }
export function sceneRequest(text, tvs = []) {
  const refs = {};
  const list = [];
  let said = String(text ?? '');
  const named = [];
  tvs.slice(0, 20).forEach((t, i) => {
    const ref = `TV${i + 1}`;
    refs[ref] = t.id;
    const room = flat(t.room, 40);
    list.push({ ref, brand: BRANDS.includes(t.brand) ? t.brand : 'tv', box: t.brand === 'roku' || t.brand === 'appletv', on: t.state?.power === 'on', says: Boolean(t.capabilities?.toast) });
    for (const n of [flat(t.name, 40), room]) if (n.length >= 2) named.push([n, ref]);
  });
  // Longest names first, so "Basement TV" goes before "Basement".
  named.sort((a, b) => b[0].length - a[0].length);
  for (const [n, ref] of named) said = said.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}(?=$|[^\\p{L}\\p{N}])`, 'giu'), `$1${ref}`);
  return { request: sanitizeSceneRequest({ text: said, tvs: list }), refs };
}

// The Worker runs this again on whatever arrives.
export function sanitizeSceneRequest(req) {
  const text = scrub(req?.text);
  if (text.length < 3) return null;
  const tvs = (Array.isArray(req?.tvs) ? req.tvs : [])
    .slice(0, 20)
    .filter((t) => REF.test(String(t?.ref)))
    .map((t) => ({ ref: String(t.ref), brand: BRANDS.includes(t.brand) ? t.brand : 'tv', box: Boolean(t.box), on: Boolean(t.on), says: Boolean(t.says) }));
  return { text, tvs };
}

export const SCENE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'emoji', 'summary', 'steps', 'schedule'],
  properties: {
    name: { type: 'string' },
    emoji: { type: 'string', enum: SCENE_EMOJI },
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'target'],
        properties: {
          action: { type: 'string', enum: SCENE_ACTIONS },
          target: { anyOf: [{ type: 'string', enum: ['all'] }, { type: 'array', items: { type: 'string' } }] },
          on: { type: 'boolean' },
          level: { type: 'integer' },
          app: { type: 'string' },
          message: { type: 'string' },
          seconds: { type: 'integer' },
        },
      },
    },
    schedule: {
      anyOf: [
        { type: 'null' },
        { type: 'object', additionalProperties: false, required: ['days', 'time'], properties: { days: { type: 'array', items: { type: 'integer' } }, time: { type: 'string' } } },
      ],
    },
  },
};

export const SCENE_SYSTEM = `You turn what someone says into a Hearth scene: a short list of steps that Hearth runs across the TVs in their home, by tapping it or on a weekly schedule.
Steps (one action each): power {on:true|false}; volume {level:0-60: comfortable 15-25, "quiet"/"low" 8, "loud" 30; never 0, use mute for silence}; mute {on:true|false}; launch {app:"Netflix"} (an app by its usual name); say {message:"…"} (a short note shown on the TV screen, max 60 characters, may end with one emoji; only TVs marked "shows messages" can, so leave say out for the others and mention that in the summary); wait {seconds:1-60}.
Each step has target "all" or a list of TV refs (TV1, TV2…) from the list you are given. TVs are referred to only by these refs. A "box" is a Roku or Apple TV plugged into a TV: turning a box on also turns its TV on.
Rules: answer with ONLY a JSON object. Use only the refs given; if the person names a TV you can't match, use "all". Only turn TVs on when they want something to start (watch, open an app, "turn on"); then it comes first, with wait 5 before any launch. A scene that winds down or ends (bedtime, quiet, off) never turns anything on. Keep it to what they asked, at most 8 steps. A schedule only if they said when: days: Sunday 0, Monday 1, Tuesday 2, Wednesday 3, Thursday 4, Friday 5, Saturday 6 ("school nights" = 0,1,2,3,4; "weekdays" = 1,2,3,4,5; "weekends" = 0,6; "every day" = all), time "HH:MM" 24-hour. name: 1-3 words, Title Case. emoji: one from ${SCENE_EMOJI.join(' ')}. summary: one plain sentence saying what it will do, using the refs.`;

const SHAPE = `{"name":"Bedtime","emoji":"🌙","summary":"…","steps":[{"action":"volume","target":["TV1"],"level":12},{"action":"say","target":["TV1"],"message":"Bedtime in 5 🌙"},{"action":"wait","target":"all","seconds":60},{"action":"power","target":["TV1"],"on":false}],"schedule":{"days":[0,1,2,3,4],"time":"20:30"}}`;

export const scenePrompt = (req) =>
  `TVs in this home:\n${req.tvs.map((t) => `- ${t.ref}: ${t.brand}${t.box ? ' (box)' : ''}${t.says ? ', shows messages' : ''}${t.on ? ', on now' : ''}`).join('\n') || '- none yet'}\n\nWhat they said: "${req.text}"\n\nAnswer with JSON exactly like: ${SHAPE}`;

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// The AI's answer → a draft that only uses known refs, or null.
export function validateSceneDraft(d, refs = []) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.steps)) return null;
  const known = new Set(refs);
  const steps = [];
  for (const s of d.steps.slice(0, MAX_STEPS)) {
    if (!SCENE_ACTIONS.includes(s?.action)) continue;
    let target = 'all';
    if (Array.isArray(s.target)) {
      const t = [...new Set(s.target.map(String).filter((r) => known.has(r)))];
      if (t.length) target = t;
    }
    let args;
    if (s.action === 'power' || s.action === 'mute') args = { on: s.on !== false };
    else if (s.action === 'volume') args = { level: clampInt(s.level, 0, 60, 15) };
    else if (s.action === 'launch') {
      const app = flat(s.app ?? s.title, 40);
      if (!app) continue;
      args = { title: app };
    } else if (s.action === 'say') {
      const message = flat(s.message, 80);
      if (!message) continue;
      args = { message };
    } else args = { seconds: clampInt(s.seconds, 1, 60, 5) };
    steps.push({ action: s.action, target: s.action === 'wait' ? 'all' : target, args });
  }
  if (!steps.length) return null;
  let schedule = null;
  if (d.schedule && typeof d.schedule === 'object') {
    const days = [...new Set((Array.isArray(d.schedule.days) ? d.schedule.days : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
    const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(d.schedule.time)) ? d.schedule.time : null;
    if (days.length && time) schedule = { days, time };
  }
  return {
    name: flat(d.name, 30) || 'My scene',
    emoji: SCENE_EMOJI.includes(d.emoji) ? d.emoji : '✨',
    summary: flat(d.summary, 160),
    steps,
    schedule,
  };
}

// The days someone named, read from their own words (small models mix up
// "Saturday" and 0). null when they named none.
const DAY_WORDS = [/\bsun(days?)?\b/, /\bmon(days?)?\b/, /\btues?(days?)?\b/, /\bwed(nesdays?)?\b/, /\bthu(rs?|rsdays?)?\b/, /\bfri(days?)?\b/, /\bsat(urdays?)?\b/];
export function daysFromText(text) {
  const t = String(text ?? '').toLowerCase();
  if (/school ?nights?/.test(t)) return [0, 1, 2, 3, 4];
  if (/week ?days?\b/.test(t)) return [1, 2, 3, 4, 5];
  if (/week ?ends?\b/.test(t)) return [0, 6];
  if (/every ?day|daily|every night|nightly|each day/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
  const days = DAY_WORDS.map((re, d) => (re.test(t) ? d : -1)).filter((d) => d >= 0);
  return days.length ? days : null;
}

// Tokens back to this house's TVs: ids in targets, names in the words.
export function restoreScene(draft, refs, tvs = []) {
  const name = (ref) => tvs.find((t) => t.id === refs[ref])?.name ?? ref;
  const words = (s) => String(s ?? '').replace(/\bTV([1-9]|1\d|20)\b/g, (m) => (refs[m] ? name(m) : m));
  return {
    name: words(draft.name).slice(0, 40),
    emoji: draft.emoji,
    summary: words(draft.summary),
    steps: draft.steps.map((s) => ({
      ...s,
      target: s.target === 'all' ? 'all' : s.target.map((r) => refs[r]).filter(Boolean),
      args: s.action === 'say' ? { message: words(s.args.message) } : s.args,
    })).filter((s) => s.target === 'all' || s.target.length),
    schedule: draft.schedule ? { ...draft.schedule, enabled: true } : null,
  };
}
