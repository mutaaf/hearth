// hearth Worker: mutaafaziz.com/hearth/api/* — AI health insights for the
// home app. Everything else under /hearth is static assets (dist/).
//
//   GET  /hearth/api/health            { ok, edge, ai }
//   GET  /hearth/api/providers         which brains exist
//   POST /hearth/api/models            { provider | 'auto' } + x-hearth-key → { provider, models, suggested }
//   POST /hearth/api/insights          { payload, provider?, model? } (+ x-hearth-key for BYOK)
//                                      → { insight, provider, model, ms, inTokens, outTokens, neurons, costUsd, billedTo }
//   POST /hearth/api/bill              { lines } | { image } (+ provider, model, x-hearth-key)
//                                      → { bill, provider, model, ms, costUsd, billedTo }
//
// The bill: only scrubbed charge lines (src/bill-schema.js chargeLines, run
// again here) or a photo the person cropped to the charges box. Neither is
// stored or logged; only the numbers go back.
//
// The payload is an anonymised TV report (no names, IPs, MACs, serials,
// SSIDs) and is rebuilt server-side by sanitizePayload before any model sees
// it. Keys are used once and never stored or logged. Free (edge) calls are
// capped per IP per hour and per day overall, like COLD GAS.
import { complete, costUsd, describeError, EDGE_MODELS, EDGE_VISION_MODELS, listModels, pickModel, PROVIDERS } from './ai/providers.js';
import { BILL_IMAGE_PROMPT, BILL_SCHEMA, BILL_SYSTEM, billPrompt, chargeLines, checkImage, validateBill } from '../bill-schema.js';
import { detectProvider, extractJson, sanitizePayload, SYSTEM, userPrompt, validateInsight } from '../insight-schema.js';

const EDGE_DAILY_CAP = 150; // free insights per UTC day (~17 neurons each); the 10k free allowance is shared with COLD GAS
const EDGE_HOURLY_PER_IP = 15;
const BYOK_HOURLY_PER_IP = 60;
const MODELS_HOURLY_PER_IP = 30;
const MAX_BODY = 16_384;
const MAX_BILL_BODY = 2_300_000; // a cropped, downscaled photo as a data URL
const BILL_EDGE_HOURLY_PER_IP = 6;
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

async function readBody(req, max = MAX_BODY) {
  if (!/^application\/json\b/i.test(req.headers.get('content-type') || '')) return { error: json({ error: 'Send JSON.' }, 415) };
  if (Number(req.headers.get('content-length') || 0) > max) return { error: json({ error: 'Too large.' }, 413) };
  const text = await req.text();
  if (text.length > max) return { error: json({ error: 'Too large.' }, 413) };
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

// Validate a bill request. Exported for tests.
export function checkBillRequest(body, key) {
  if (!body || typeof body !== 'object') return { error: 'Bad request.' };
  const provider = PROVIDERS[body.provider] ? body.provider : 'edge';
  if (PROVIDERS[provider].needsKey && !KEY_RE.test(key || '')) return { error: 'That doesn’t look like a complete key.' };
  if (body.model != null && !MODEL_RE.test(String(body.model))) return { error: 'Bad model name.' };
  const image = body.image != null ? checkImage(body.image) : null;
  if (body.image != null && !image) return { error: 'That photo is too big or not a JPEG/PNG.' };
  const lines = image ? [] : chargeLines((Array.isArray(body.lines) ? body.lines : []).map(String).join('\n'));
  if (!image && lines.length < 2) return { error: 'No charges found in that bill.' };
  return { provider, model: body.model ? String(body.model) : null, image, lines };
}

async function bill(req, env) {
  const t0 = Date.now();
  const { body, error } = await readBody(req, MAX_BILL_BODY);
  if (error) return error;
  const key = req.headers.get('x-hearth-key') || '';
  const check = checkBillRequest(body, key);
  if (check.error) return json({ error: check.error }, 400);
  const { provider, image, lines } = check;
  const db = env.DB;
  await ensureTables(db);
  const ip = await ipHash(req);
  const allowed =
    provider === 'edge'
      ? (await bump(db, `bill:${ip}:${hour()}`)) <= BILL_EDGE_HOURLY_PER_IP && (await bump(db, `edge-day:${day()}`)) <= EDGE_DAILY_CAP && !!env.AI
      : (await bump(db, `byok:${ip}:${hour()}`)) <= BYOK_HOURLY_PER_IP;
  if (!allowed) return json({ error: provider === 'edge' ? 'The free AI allowance is used up for now. Try later, add your own key, or type your price per kWh.' : 'Too many calls from here this hour.' }, 429);
  const pool = provider === 'edge' ? (image ? EDGE_VISION_MODELS : EDGE_MODELS) : [check.model || PROVIDERS[provider].fallbackModel];
  const first = provider === 'edge' && pool.includes(check.model) ? check.model : pool[0];
  if (!first) return json({ error: 'Pick a model first.' }, 400);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 50_000);
  try {
    let lastErr = null;
    for (const m of [first, ...pool.filter((x) => x !== first)]) {
      try {
        const r = await complete({ provider, env, key, model: m, system: BILL_SYSTEM, user: image ? BILL_IMAGE_PROMPT : billPrompt(lines), image, schema: BILL_SCHEMA, signal: abort.signal });
        const parsed = validateBill(extractJson(r.text));
        if (!parsed) throw Object.assign(new Error('Couldn’t find a price per kWh on that bill. Try the page with the charges, or type the price.'), { userFacing: true });
        const used = r.model || m;
        return json({
          bill: parsed,
          provider,
          providerLabel: PROVIDERS[provider].label,
          model: used,
          ms: Date.now() - t0,
          costUsd: costUsd(used, r.inTokens, r.outTokens),
          billedTo: provider === 'edge' ? 'Hearth (free allowance)' : `your ${PROVIDERS[provider].label} key`,
        });
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
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
  if (path === '/bill' && req.method === 'POST') return bill(req, env);
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
