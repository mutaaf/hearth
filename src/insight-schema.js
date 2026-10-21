// The AI health insight: what we ask every model for, how we validate what
// comes back, and how we sanitise what we send. Shared by the hearth Worker
// (src/worker) and the home hub (src/llm.js). Pure functions, no imports.

export const INSIGHT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'verdict_for_everyone', 'top_actions', 'nerd_notes', 'model_profile', 'ai_grade_adjustment'],
  properties: {
    headline: { type: 'string' },
    verdict_for_everyone: { type: 'string' },
    top_actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'why'],
        properties: { action: { type: 'string' }, why: { type: 'string' } },
      },
    },
    nerd_notes: { type: 'array', items: { type: 'string' } },
    model_profile: {
      type: 'object',
      additionalProperties: false,
      required: ['year', 'platform', 'panel_or_device_notes', 'known_issues', 'privacy_settings_to_change', 'firmware_advice'],
      properties: {
        year: { type: 'integer' },
        platform: { type: 'string' },
        panel_or_device_notes: { type: 'string' },
        known_issues: { type: 'array', items: { type: 'string' } },
        privacy_settings_to_change: { type: 'array', items: { type: 'string' } },
        firmware_advice: { type: 'string' },
      },
    },
    ai_grade_adjustment: {
      type: 'object',
      additionalProperties: false,
      required: ['points', 'reason'],
      properties: { points: { type: 'integer' }, reason: { type: 'string' } },
    },
  },
};

export const SYSTEM = `You are Hearth's TV technician. Hearth is a home app that controls the TVs in a house over the local network. You receive one TV's anonymised health report: brand, model, software, network quality, what Hearth can control, measured scores (0-100) and usage stats. The scores are computed by Hearth and are authoritative; never invent measurements that are not in the report.

Write for two audiences:
- "verdict_for_everyone" and "top_actions": plain, friendly, no jargon, for a non-technical family member. At most 3 actions, each a concrete thing to do on the TV, router or in Hearth, with a short "why".
- "nerd_notes": 3-6 terse technical observations a power user would enjoy (protocol, latency percentiles, jitter, firmware, platform quirks).
- "model_profile": what you know about this model from general knowledge: launch year (integer; 0 if unsure), platform/OS family, panel or device notes, known issues, privacy settings worth changing (ACR, ad tracking), firmware advice. If unsure, say so briefly rather than guessing specifics.
- "ai_grade_adjustment": integer from -10 to 5 with a one-sentence reason, only for things the scores cannot see (for example a model known for slow menus or end of software support). Use 0 if nothing applies.
- "headline": at most 8 words.

Reply with one JSON object only, matching this shape exactly, no markdown:
{"headline":"","verdict_for_everyone":"","top_actions":[{"action":"","why":""}],"nerd_notes":[""],"model_profile":{"year":0,"platform":"","panel_or_device_notes":"","known_issues":[""],"privacy_settings_to_change":[""],"firmware_advice":""},"ai_grade_adjustment":{"points":0,"reason":""}}`;

export const userPrompt = (payload) => `TV health report (JSON):\n${JSON.stringify(payload)}`;

// Models wrap JSON in fences, add prose, or leave trailing commas. Find the
// outermost object and parse it; null if there's nothing usable.
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).replace(/```(?:json)?/gi, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  s = s.slice(start, end + 1);
  for (const candidate of [s, s.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

const str = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const list = (v, max, len) => (Array.isArray(v) ? v.map((x) => str(x, len)).filter(Boolean).slice(0, max) : []);

// Coerce whatever came back into the exact shape the app renders.
export function validateInsight(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mp = raw.model_profile && typeof raw.model_profile === 'object' ? raw.model_profile : {};
  const adj = raw.ai_grade_adjustment && typeof raw.ai_grade_adjustment === 'object' ? raw.ai_grade_adjustment : {};
  const year = Number.isInteger(Number(mp.year)) && Number(mp.year) >= 1995 && Number(mp.year) <= 2035 ? Number(mp.year) : null;
  const points = Number.isFinite(Number(adj.points)) ? Math.max(-10, Math.min(5, Math.round(Number(adj.points)))) : 0;
  const out = {
    headline: str(raw.headline, 80),
    verdict_for_everyone: str(raw.verdict_for_everyone, 320),
    top_actions: (Array.isArray(raw.top_actions) ? raw.top_actions : [])
      .map((a) => (typeof a === 'string' ? { action: str(a, 160), why: '' } : { action: str(a?.action, 160), why: str(a?.why, 200) }))
      .filter((a) => a.action)
      .slice(0, 3),
    nerd_notes: list(raw.nerd_notes, 6, 220),
    model_profile: {
      year,
      platform: str(mp.platform, 80),
      panel_or_device_notes: str(mp.panel_or_device_notes, 240),
      known_issues: list(mp.known_issues, 5, 200),
      privacy_settings_to_change: list(mp.privacy_settings_to_change, 5, 200),
      firmware_advice: str(mp.firmware_advice, 240),
    },
    ai_grade_adjustment: { points, reason: points ? str(adj.reason, 200) : '' },
  };
  if (!out.headline && !out.verdict_for_everyone) return null;
  return out;
}

// Whatever the client sends is rebuilt from scratch: bounded depth, bounded
// strings and lists, safe keys, and anything identifying is dropped.
const BANNED_KEY = /ssid|bssid|mac|serial|ip(addr)?$|^ip|name$|duid|udn|uuid|location|public_key|token|key$/i;
export function sanitizePayload(input, depth = 0) {
  if (depth > 4) return null;
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) / 100 : null;
  if (typeof input === 'string') {
    const s = input.replace(/[\u0000-\u001f]/g, ' ').slice(0, 120);
    // Strip anything that looks like an address even inside values.
    return s.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '[ip]').replace(/\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '[mac]');
  }
  if (Array.isArray(input)) return input.slice(0, 12).map((x) => sanitizePayload(x, depth + 1));
  if (typeof input === 'object') {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(input)) {
      if (n++ >= 40) break;
      const key = String(k).slice(0, 40);
      if (!/^[\w ()&’'.+-]+$/.test(key) || BANNED_KEY.test(key.replace(/\s+/g, ''))) continue;
      out[key] = sanitizePayload(v, depth + 1);
    }
    return out;
  }
  return null;
}

// Which provider a pasted key belongs to, from its shape alone (same rules
// as COLD GAS). The browser uses it to connect without asking; the Worker
// uses it when told "auto".
const LOOKALIKES = [
  [/^gsk_/, 'That’s a Groq key (Groq with a q). Hearth works with xAI’s Grok: those keys start with xai-.'],
  [/^sk-or-/, 'That’s an OpenRouter key. Paste a key from Anthropic, OpenAI, xAI or Google instead.'],
  [/^r8_/, 'That’s a Replicate key. Paste a key from Anthropic, OpenAI, xAI or Google instead.'],
  [/^hf_/, 'That’s a Hugging Face token. Paste a key from Anthropic, OpenAI, xAI or Google instead.'],
  [/^pplx-/, 'That’s a Perplexity key. Paste a key from Anthropic, OpenAI, xAI or Google instead.'],
  [/^ghp_|^github_pat_/, 'That’s a GitHub token, not an AI key. Don’t share it; paste an AI provider key instead.'],
];

export function cleanKey(raw) {
  return String(raw || '').trim().replace(/^["'`]|["'`]$/g, '').replace(/^Bearer\s+/i, '').replace(/^\w+_API_KEY\s*=\s*/, '').trim();
}

export function detectProvider(raw) {
  const key = cleanKey(raw);
  if (!key) return { provider: null, key, reason: '' };
  for (const [re, reason] of LOOKALIKES) if (re.test(key)) return { provider: null, key, reason };
  if (/^sk-ant-/.test(key)) return { provider: 'anthropic', key };
  if (/^xai-/.test(key)) return { provider: 'xai', key };
  if (/^AIza[\w-]{30,}$/.test(key)) return { provider: 'gemini', key };
  if (/^sk-(proj-|svcacct-|admin-)?[\w-]{20,}$/.test(key)) return { provider: 'openai', key };
  if (key.length < 20) return { provider: null, key, reason: 'That looks too short to be a key. Copy the whole thing.' };
  return { provider: null, key, reason: 'We couldn’t tell whose key that is. Keys from Anthropic start sk-ant-, OpenAI sk-, xAI xai-, Google AIza.' };
}
