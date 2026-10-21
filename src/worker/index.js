// hearth Worker: mutaafaziz.com/hearth/api/* — AI health insights for the
// home app. Everything else under /hearth is static assets (dist/).
//
//   GET  /hearth/api/health            { ok, edge, ai }
//   GET  /hearth/api/providers         which brains exist
//   POST /hearth/api/models            { provider | 'auto' } + x-hearth-key → { provider, models, suggested }
//   POST /hearth/api/insights          { payload, provider?, model? } (+ x-hearth-key for BYOK)
//                                      → { insight, provider, model, ms, inTokens, outTokens, neurons, costUsd, billedTo }
//
// The payload is an anonymised TV report (no names, IPs, MACs, serials,
// SSIDs) and is rebuilt server-side by sanitizePayload before any model sees
// it. Keys are used once and never stored or logged. Free (edge) calls are
// capped per IP per hour and per day overall, like COLD GAS.
import { complete, costUsd, describeError, EDGE_MODELS, listModels, pickModel, PROVIDERS } from './ai/providers.js';
import { detectProvider, extractJson, sanitizePayload, SYSTEM, userPrompt, validateInsight } from '../insight-schema.js';

const EDGE_DAILY_CAP = 200; // free-allowance insights per UTC day (~40 neurons each, 10k free)
const EDGE_HOURLY_PER_IP = 15;
const BYOK_HOURLY_PER_IP = 60;
const MODELS_HOURLY_PER_IP = 30;
const MAX_BODY = 16_384;
const KEY_RE = /^[\w\-.:+/=]{8,400}$/;
const MODEL_RE = /^[\w\-.:/@]{1,120}$/;

export const LIMITS = { EDGE_DAILY_CAP, EDGE_HOURLY_PER_IP, BYOK_HOURLY_PER_IP, MAX_BODY };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const day = () => new Date().toISOString().slice(0, 10);
const hour = () => new Date().toISOString().slice(0, 13);

let tablesReady = false;
async function ensureTables(db) {
  if (tablesReady || !db) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS ai_usage (bucket TEXT PRIMARY KEY, n INTEGER NOT NULL)').run();
  tablesReady = true;
}

async function bump(db, bucket) {
  if (!db) return 1;
  const row = await db
    .prepare('INSERT INTO ai_usage (bucket, n) VALUES (?, 1) ON CONFLICT(bucket) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(bucket)
    .first();
  return row?.n ?? 1;
}

async function ipHash(req) {
  const ip = req.headers.get('cf-connecting-ip') || '0';
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}|${day()}|hearth`));
  return [...new Uint8Array(h)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readBody(req) {
  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) return { error: json({ error: 'Send JSON.' }, 415) };
  const text = await req.text();
  if (text.length > MAX_BODY) return { error: json({ error: 'Too large.' }, 413) };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: json({ error: 'Bad JSON.' }, 400) };
  }
}

// Validate an insight request. Exported for tests.
export function checkInsightRequest(body, key) {
  if (!body || typeof body !== 'object') return { error: 'Bad request.' };
  const provider = PROVIDERS[body.provider] ? body.provider : 'edge';
  if (PROVIDERS[provider].needsKey && !KEY_RE.test(key || '')) return { error: 'That doesn’t look like a complete key.' };
  if (body.model != null && !MODEL_RE.test(String(body.model))) return { error: 'Bad model name.' };
  if (!body.payload || typeof body.payload !== 'object' || body.payload.v !== 1) return { error: 'Missing TV report.' };
  const payload = sanitizePayload(body.payload);
  return { provider, model: body.model ? String(body.model) : null, payload };
}

async function insights(req, env) {
  const t0 = Date.now();
  const { body, error } = await readBody(req);
  if (error) return error;
  const key = req.headers.get('x-hearth-key') || '';
  const check = checkInsightRequest(body, key);
  if (check.error) return json({ error: check.error }, 400);
  const { provider, payload } = check;

  const db = env.DB;
  await ensureTables(db);
  const ip = await ipHash(req);
  const allowed =
    provider === 'edge'
      ? (await bump(db, `edge:${ip}:${hour()}`)) <= EDGE_HOURLY_PER_IP && (await bump(db, `edge-day:${day()}`)) <= EDGE_DAILY_CAP && !!env.AI
      : (await bump(db, `byok:${ip}:${hour()}`)) <= BYOK_HOURLY_PER_IP;
  if (!allowed) {
    return json({ error: provider === 'edge' ? 'The free AI allowance is used up for now. Try later, or add your own key.' : 'Too many calls from here this hour.' }, 429);
  }

  const model = provider === 'edge' ? (EDGE_MODELS.includes(check.model) ? check.model : EDGE_MODELS[0]) : check.model || PROVIDERS[provider].fallbackModel;
  if (!model) return json({ error: 'Pick a model first.' }, 400);
  const user = userPrompt(payload);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 45_000);
  try {
    const tryModels = provider === 'edge' ? [model, ...EDGE_MODELS.filter((m) => m !== model)] : [model];
    let result = null;
    let used = model;
    let lastErr = null;
    for (const m of tryModels) {
      try {
        const r = await complete({ provider, env, key, model: m, system: SYSTEM, user, signal: abort.signal });
        const insight = validateInsight(extractJson(r.text));
        if (!insight) throw Object.assign(new Error('The model’s answer wasn’t usable JSON.'), { userFacing: true });
        result = { ...r, insight };
        used = r.model || m;
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    return json({
      insight: result.insight,
      provider,
      providerLabel: PROVIDERS[provider].label,
      vendor: PROVIDERS[provider].vendor,
      model: used,
      colo: req.cf?.colo || null,
      ms: Date.now() - t0,
      inTokens: result.inTokens,
      outTokens: result.outTokens,
      neurons: result.neurons ? Math.round(result.neurons * 100) / 100 : null,
      costUsd: costUsd(used, result.inTokens, result.outTokens),
      billedTo: provider === 'edge' ? 'Hearth (free allowance)' : `your ${PROVIDERS[provider].label} key`,
    });
  } catch (err) {
    return json({ error: describeError(provider, err) }, err?.status === 401 || err?.status === 403 ? 401 : 502);
  } finally {
    clearTimeout(timer);
  }
}

async function models(req, env) {
  const { body, error } = await readBody(req);
  if (error) return error;
  const key = req.headers.get('x-hearth-key') || '';
  const detected = body?.provider === 'auto' ? detectProvider(key) : null;
  if (detected && !detected.provider) return json({ error: detected.reason || 'Unrecognised key.' }, 400);
  const provider = detected ? detected.provider : body?.provider;
  if (!PROVIDERS[provider]?.needsKey || !KEY_RE.test(key)) return json({ error: 'That doesn’t look like a complete key.' }, 400);
  if (env.DB) {
    await ensureTables(env.DB);
    if ((await bump(env.DB, `models:${await ipHash(req)}:${hour()}`)) > MODELS_HOURLY_PER_IP) return json({ error: 'slow down' }, 429);
  }
  try {
    const ids = (await listModels(provider, key)).sort();
    return json({ provider, label: PROVIDERS[provider].label, models: ids, suggested: pickModel(provider, ids) || PROVIDERS[provider].fallbackModel || null });
  } catch (err) {
    return json({ error: describeError(provider, err) }, err?.status === 401 || err?.status === 403 ? 401 : 502);
  }
}

export async function handle(req, env) {
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/hearth/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : json({ error: 'not found' }, 404);
  const path = url.pathname.slice('/hearth/api'.length);
  if (path === '/health' && req.method === 'GET') return json({ ok: true, edge: EDGE_MODELS[0], ai: !!env.AI });
  if (path === '/providers' && req.method === 'GET') {
    return json({
      default: { provider: 'edge', model: EDGE_MODELS[0] },
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, vendor: p.vendor, needsKey: p.needsKey })),
    });
  }
  if (path === '/insights' && req.method === 'POST') return insights(req, env);
  if (path === '/models' && req.method === 'POST') return models(req, env);
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    try {
      return await handle(req, env);
    } catch (err) {
      console.error('worker error', err?.name, err?.status);
      return json({ error: 'server' }, 500);
    }
  },
};
