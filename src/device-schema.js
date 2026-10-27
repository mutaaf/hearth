// "How do I connect this TV?" with AI, and "it won't connect, help": what
// leaves the house, what the AI must answer, and how both are checked.
// Shared by the hearth Worker (src/worker) and the hub (src/llm.js). Pure
// functions, no imports.
//
// Only what a TV *is* and what went wrong ever leaves: brand, model code,
// software version, which pairing step failed, which ports answered, a short
// error with addresses/serials scrubbed out, and an optional note the person
// typed (scrubbed the same way). Never names, rooms, IPs, MACs or serials.

export const BRANDS = ['lg', 'samsung', 'roku', 'androidtv', 'appletv', 'other'];
export const WHEN = ['setup', 'refused', 'no-prompt', 'not-found', 'drops', 'wont-wake', 'auto-off', 'other'];
const STEPS = ['network', 'wake', 'find', 'reconnect', 'verify', 'pair', 'search', 'add'];
const STATUS = ['ok', 'warn', 'fail', 'skip', 'running'];
const HOW = ['none', 'allow', 'pin', 'code', 'allow-or-pin'];
const PLATFORMS = ['ios', 'android', 'web'];

// Addresses, hardware ids and anything that could be an account or serial.
export function scrub(text, max = 160) {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '[mac]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[ip]')
    .replace(/\b[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\b/gi, (m) => (m.split(':').length > 3 ? '[ip]' : m))
    // Serials and device ids: 12+ characters with 5+ digits. Model codes
    // (OLED55C2PUA, QN65QN90BAFXZA) have fewer digits and stay readable.
    .replace(/\b[A-Z0-9]{12,}\b/gi, (m) => ((m.match(/\d/g) || []).length >= 5 ? '[id]' : m))
    .replace(/\d{7,}/g, '#')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Model codes: UN55KU6290, OLED55C2PUA, 55NANO75UPA, 3820X, AppleTV11,1, "4K (2nd gen)".
const MODEL_RE = /^[\w\-. ()+,/]{0,40}$/;

export function sanitizeDevice(input) {
  if (!input || typeof input !== 'object') return null;
  const brand = BRANDS.includes(input.brand) ? input.brand : null;
  if (!brand) return null;
  const model = String(input.model ?? '').trim().slice(0, 40);
  const firmware = scrub(input.firmware ?? '', 40);
  return { brand, model: MODEL_RE.test(model) ? model : '', firmware };
}

export function sanitizeSymptom(input) {
  if (!input || typeof input !== 'object') return { when: 'setup', steps: [], ports: [], error: '' };
  const steps = (Array.isArray(input.steps) ? input.steps : [])
    .filter((s) => s && STEPS.includes(s.step))
    .slice(0, 10)
    .map((s) => ({ step: s.step, status: STATUS.includes(s.status) ? s.status : 'other', detail: scrub(s.detail, 120) }));
  const ports = (Array.isArray(input.ports) ? input.ports : [])
    .filter((p) => Number.isInteger(p?.port) && p.port > 0 && p.port < 65536)
    .slice(0, 16)
    .map((p) => ({ port: p.port, open: p.open === true }));
  return { when: WHEN.includes(input.when) ? input.when : 'other', steps, ports, error: scrub(input.error, 200) };
}

// A report for the support queue: the device, the symptom, the app, a note.
export function sanitizeSupport(input) {
  if (!input || typeof input !== 'object') return null;
  const device = sanitizeDevice(input.device);
  if (!device) return null;
  const app = input.app && typeof input.app === 'object' ? input.app : {};
  return {
    v: 1,
    device,
    symptom: sanitizeSymptom(input.symptom),
    app: {
      platform: PLATFORMS.includes(app.platform) ? app.platform : 'web',
      version: /^[\w.\-+]{1,24}$/.test(String(app.version ?? '')) ? String(app.version) : '',
    },
    guideKnown: input.guideKnown === true,
    note: scrub(input.note, 500),
  };
}

// ── The AI's answer: the same shape as src/devices.js deviceGuide() ──
export const GUIDE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['family', 'year', 'os', 'connect', 'keepReachable', 'troubleshoot', 'quirks', 'confidence'],
  properties: {
    family: { type: 'string' },
    year: { type: ['integer', 'null'] },
    os: { type: ['string', 'null'] },
    connect: {
      type: 'object',
      additionalProperties: false,
      required: ['how', 'summary', 'before', 'onTv'],
      properties: {
        how: { type: 'string', enum: HOW },
        summary: { type: 'string' },
        before: { type: 'array', items: { type: 'string' } },
        onTv: { type: ['string', 'null'] },
      },
    },
    keepReachable: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['title', 'path'], properties: { title: { type: 'string' }, path: { type: 'string' } } },
    },
    troubleshoot: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['when', 'fix'], properties: { when: { type: 'string', enum: WHEN }, fix: { type: 'string' } } },
    },
    quirks: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

export const GUIDE_SYSTEM = `You are Hearth's TV setup expert. Hearth is a phone app that controls smart TVs over the home Wi-Fi (no IR, no cloud): LG webOS (SSAP websocket, Allow box or a PIN on screen), Samsung Tizen (2016-17: websocket on port 8001, no prompt; 2018+: secure websocket 8002 with an Allow box), Roku (ECP over HTTP 8060, no pairing, but "Control by mobile apps" must allow network access), Google TV / Android TV (Cast on 8009, and the full remote shows a code on screen), Apple TV (two 4-digit codes).
You receive one TV's brand, model code and software version, optionally what went wrong while connecting, and Hearth's own built-in guide for that brand. Identify the exact model family and year from the model code, then write the steps for THIS model: exact menu paths in the TV's own words for its year (menus moved between years), what appears on the TV while connecting, which settings keep it findable and able to be switched on from a phone, and fixes for the problem described.
Rules: answer with ONLY a JSON object matching the schema. Plain, friendly, second person; one or two short sentences per item; menu paths with → between levels. Never mention other apps by name. If you aren't sure of the model year or a menu path, say so with confidence "low" and keep to what is true for the brand. Never invent a setting that the brand doesn't have.`;

// Small models don't get the schema as a response format, so the prompt
// spells out the exact keys (and keeps lists short so the answer fits).
const SHAPE = `{"family":"…","year":2016,"os":"…","connect":{"how":"none|allow|pin|code|allow-or-pin","summary":"one sentence","before":["Settings → …"],"onTv":"what shows on the TV, or null"},"keepReachable":[{"title":"…","path":"Settings → …"}],"troubleshoot":[{"when":"setup|refused|no-prompt|not-found|drops|wont-wake|auto-off|other","fix":"…"}],"quirks":["…"],"confidence":"high|medium|low"}`;

export const guidePrompt = (device, symptom, builtIn) =>
  `TV: ${JSON.stringify(device)}\nWhat happened: ${JSON.stringify(symptom)}\nHearth's built-in guide for this brand (improve on it for this exact model): ${JSON.stringify(builtIn ?? null).slice(0, 2500)}\n\nAnswer with exactly this JSON shape and nothing else (at most 3 keepReachable, 5 troubleshoot, 3 quirks):\n${SHAPE}`;

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const list = (v, n, f) => (Array.isArray(v) ? v.map(f).filter(Boolean).slice(0, n) : []);

export function validateGuide(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw.connect && typeof raw.connect === 'object' ? raw.connect : {};
  const summary = str(c.summary, 240);
  if (!summary) return null;
  const year = Number.isInteger(raw.year) && raw.year >= 2008 && raw.year <= 2035 ? raw.year : null;
  return {
    family: str(raw.family, 100) || null,
    year,
    os: str(raw.os, 40) || null,
    connect: {
      how: HOW.includes(c.how) ? c.how : 'allow',
      summary,
      before: list(c.before, 6, (s) => str(s, 200)),
      onTv: str(c.onTv, 200) || null,
    },
    keepReachable: list(raw.keepReachable, 6, (k) => (k && str(k.title, 60) && str(k.path, 220) ? { title: str(k.title, 60), path: str(k.path, 220) } : null)),
    troubleshoot: list(raw.troubleshoot, 10, (t) => (t && WHEN.includes(t.when) && str(t.fix, 320) ? { when: t.when, fix: str(t.fix, 320) } : null)),
    quirks: list(raw.quirks, 6, (s) => str(s, 200)),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low',
  };
}

// The cache key for a guide shared by every house with the same TV: brand,
// the model code without its region suffix noise, and the symptom.
export function guideKey(device, symptom) {
  const model = String(device.model || '').toUpperCase().replace(/\s+/g, '');
  return `${device.brand}|${model || '?'}|${symptom?.when || 'setup'}`;
}
