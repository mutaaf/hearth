// Insight providers, the same family as COLD GAS's judges, answering in one
// JSON object instead of a stream.
//
// - edge:      Cloudflare Workers AI (Gemma 4 on Cloudflare; free daily allowance)
// - anthropic: Claude, via the official Anthropic SDK
// - openai, xai, gemini: their OpenAI-compatible endpoints, via the OpenAI SDK
//
// Bring-your-own keys arrive per request (x-hearth-key) and are used for that
// one call only: never stored, never logged. Base URLs are fixed here.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { INSIGHT_SCHEMA } from '../../insight-schema.js';

export const EDGE_MODELS = ['@cf/google/gemma-4-26b-a4b-it', '@cf/meta/llama-3.1-8b-instruct-fp8'];

// USD per million tokens, where we know it. null = billed at the provider's own rates.
const PRICES = {
  '@cf/google/gemma-4-26b-a4b-it': [0.1, 0.3],
  '@cf/meta/llama-3.1-8b-instruct-fp8': [0.152, 0.287],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};
export function costUsd(model, inTok, outTok) {
  const p = PRICES[model];
  return p ? (inTok * p[0] + outTok * p[1]) / 1e6 : null;
}

// How to pick a sensible current chat model from a provider's live list.
// Anthropic: the current Opus (run at low effort to keep it lean).
const PREFER = {
  anthropic: [/^claude-opus-\d/, /^claude-sonnet-\d/],
  openai: [/^gpt-\d+(\.\d+)?-nano$/, /^gpt-\d+(\.\d+)?-mini$/, /^gpt-\d+(\.\d+)?-nano/, /^gpt-\d+(\.\d+)?-mini/, /^gpt-\d/],
  xai: [/^grok-[\d.]+-fast(?!.*(image|vision))/, /fast/, /mini/, /^grok-[\d.]+$/, /^grok/],
  gemini: [/^gemini-[\d.]+-flash-lite$/, /^gemini-[\d.]+-flash-lite/, /^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash/, /^gemini/],
};
const NOT_CHAT = /(embed|tts|audio|realtime|transcri|whisper|dall|image|vision-preview|moderation|search|sora|video|veo|imagen|aqa|davinci|babbage|instruct$|codex|computer|live|native-audio|robotics|learnlm)/i;

const version = (id) => (id.match(/\d+(\.\d+)?/g) || ['0']).map(Number);
const newer = (a, b) => {
  const va = version(a);
  const vb = version(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (va[i] || 0) - (vb[i] || 0);
    if (d) return d > 0;
  }
  return a.length < b.length;
};

export function pickModel(provider, ids) {
  const chat = ids.filter((id) => !NOT_CHAT.test(id));
  for (const re of PREFER[provider] || []) {
    const hits = chat.filter((id) => re.test(id) && !/preview|exp|latest|\d{4}-\d{2}-\d{2}|\d{8}/.test(id));
    const pool = hits.length ? hits : chat.filter((id) => re.test(id));
    if (pool.length) return pool.reduce((best, id) => (newer(id, best) ? id : best));
  }
  return chat[0] || null;
}

export const PROVIDERS = {
  edge: { label: 'Hearth Cloud', vendor: 'Gemma 4 on Cloudflare', needsKey: false },
  anthropic: { label: 'Anthropic', vendor: 'Claude', needsKey: true, fallbackModel: 'claude-opus-5-5' },
  openai: { label: 'OpenAI', vendor: 'GPT', needsKey: true, baseURL: 'https://api.openai.com/v1' },
  xai: { label: 'xAI', vendor: 'Grok', needsKey: true, baseURL: 'https://api.x.ai/v1' },
  gemini: { label: 'Google', vendor: 'Gemini', needsKey: true, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
};

export async function listModels(provider, key) {
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 10_000 });
    const ids = [];
    for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
    return ids;
  }
  const p = PROVIDERS[provider];
  const client = new OpenAI({ apiKey: key, baseURL: p.baseURL, maxRetries: 0, timeout: 10_000 });
  const ids = [];
  for await (const m of client.models.list()) ids.push(String(m.id).replace(/^models\//, ''));
  return ids;
}

// Models on Workers AI that can read a photo (the bill's charges box).
export const EDGE_VISION_MODELS = ['@cf/google/gemma-4-26b-a4b-it', '@cf/mistralai/mistral-small-3.1-24b-instruct'];

// A user turn with an optional image, in the OpenAI-style parts most APIs take.
const userParts = (user, image) => (image ? [{ type: 'text', text: user }, { type: 'image_url', image_url: { url: image.dataUrl } }] : user);

// ── One JSON answer per provider ─────────────
async function completeEdge({ env, model, system, user, image, signal, maxTokens = 1100 }) {
  const body = { messages: [{ role: 'system', content: system }, { role: 'user', content: userParts(user, image) }], max_tokens: maxTokens };
  if (/gemma-4|qwen3|glm/.test(model)) body.chat_template_kwargs = { enable_thinking: false };
  const res = await env.AI.run(model, body, { signal });
  const text = typeof res === 'string' ? res : res?.response ?? res?.choices?.[0]?.message?.content ?? '';
  const u = res?.usage ?? {};
  return { text: typeof text === 'string' ? text : JSON.stringify(text), inTokens: u.prompt_tokens || 0, outTokens: u.completion_tokens || 0, neurons: u.neurons || 0 };
}

async function completeAnthropic({ key, model, system, user, image, schema = INSIGHT_SCHEMA }) {
  const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 45_000 });
  const params = {
    model,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: image ? [{ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } }, { type: 'text', text: user }] : user }],
    // Low effort keeps it quick and cheap; the schema guarantees parseable JSON.
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
  };
  // Opus/Sonnet 5.5 and Fable get the server-side refusal fallback by default.
  const fallback = /^claude-(opus-5|sonnet-5-5|fable)/.test(model);
  const msg = fallback
    ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await client.messages.create(params);
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('The model declined this request.'), { userFacing: true });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, inTokens: msg.usage?.input_tokens || 0, outTokens: msg.usage?.output_tokens || 0, neurons: 0, model: msg.model || model };
}

async function completeCompatible({ provider, key, model, system, user, image }) {
  const p = PROVIDERS[provider];
  const client = new OpenAI({ apiKey: key, baseURL: p.baseURL, maxRetries: 1, timeout: 45_000 });
  const reasoning = (provider === 'openai' && /^(gpt-5|o\d)/.test(model)) || (provider === 'gemini' && /^gemini-(2\.5|[3-9])/.test(model));
  const messages = [{ role: 'system', content: system }, { role: 'user', content: userParts(user, image) }];
  const base = { model, messages, response_format: { type: 'json_object' } };
  let res;
  try {
    res = await client.chat.completions.create(reasoning ? { ...base, reasoning_effort: 'low' } : base);
  } catch (err) {
    // Some models reject optional parameters; retry once with the bare request.
    if (!(err instanceof OpenAI.BadRequestError)) throw err;
    res = await client.chat.completions.create({ model, messages });
  }
  return {
    text: res.choices?.[0]?.message?.content ?? '',
    inTokens: res.usage?.prompt_tokens || 0,
    outTokens: res.usage?.completion_tokens || 0,
    neurons: 0,
  };
}

// `image` ({ mime, base64, dataUrl }) and `schema` are optional (the bill reader).
export function complete({ provider, env, key, model, system, user, image = null, schema, signal, maxTokens }) {
  if (provider === 'edge') return completeEdge({ env, model, system, user, image, signal, maxTokens });
  if (provider === 'anthropic') return completeAnthropic({ key, model, system, user, image, schema });
  return completeCompatible({ provider, key, model, system, user, image });
}

// A short, key-free message when a provider call fails.
export function describeError(provider, err) {
  if (err?.userFacing) return err.message;
  const label = PROVIDERS[provider]?.label || provider;
  const status = err?.status;
  if (status === 401 || status === 403) return `${label} rejected the key.`;
  if (status === 404) return `${label} doesn't offer that model to this key.`;
  if (status === 429) return `${label} is rate-limiting this key right now.`;
  if (status === 402) return `${label} says the account is out of credit.`;
  if (err?.name === 'AbortError' || /timed? ?out/i.test(String(err?.message))) return `${label} took too long to answer.`;
  return `${label} couldn't be reached.`;
}
