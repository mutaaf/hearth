import { HearthError } from './errors.js';
import { sanitizePayload, validateInsight } from './insight-schema.js';

// AI insights relay. The browser asks the hub; the hub sends the anonymised
// report to the hearth Worker (Gemma 4 on Cloudflare by default, or the
// person's own Anthropic/OpenAI/xAI/Gemini key), passing the key header
// through untouched. Keys live only in the browser that pasted them: the hub
// never stores or logs them.
export const CLOUD = (process.env.HEARTH_CLOUD || 'https://mutaafaziz.com/hearth/api').replace(/\/$/, '');
const CACHE_MS = 6 * 3_600_000;
const PROVIDER_RE = /^(edge|anthropic|openai|xai|gemini|auto)$/;

export class Insights {
  constructor({ cloud = CLOUD, fetchFn = (...a) => fetch(...a), now = () => Date.now() } = {}) {
    this.cloud = cloud;
    this.fetch = fetchFn;
    this.now = now;
    this.cache = new Map();
  }

  #headers(key) {
    const h = { 'content-type': 'application/json' };
    if (key) h['x-hearth-key'] = String(key).slice(0, 400);
    return h;
  }

  async #post(path, body, key, timeout) {
    let res;
    try {
      res = await this.fetch(`${this.cloud}${path}`, {
        method: 'POST',
        headers: this.#headers(key),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw new HearthError(502, 'Couldn’t reach Hearth Cloud. Is the internet up?');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HearthError(res.status === 429 ? 429 : res.status === 401 ? 401 : 502, data.error || `Hearth Cloud said ${res.status}`);
    return data;
  }

  cached(tvId) {
    const hit = this.cache.get(tvId);
    return hit && this.now() - hit.at < CACHE_MS ? hit.result : null;
  }

  async run(tvId, payload, { provider = 'edge', model = null, key = '', refresh = false } = {}) {
    if (!PROVIDER_RE.test(provider)) provider = 'edge';
    const signature = `${provider}|${model ?? ''}`;
    const hit = this.cache.get(tvId);
    if (!refresh && hit && hit.signature === signature && this.now() - hit.at < CACHE_MS) return { ...hit.result, cached: true };
    const data = await this.#post('/insights', { payload: sanitizePayload(payload), provider, ...(model ? { model } : {}) }, provider === 'edge' ? '' : key, 60_000);
    const insight = validateInsight(data.insight);
    if (!insight) throw new HearthError(502, 'The AI answer wasn’t usable. Try again.');
    const result = { ...data, insight, at: this.now() };
    this.cache.set(tvId, { at: this.now(), signature, result });
    return { ...result, cached: false };
  }

  // A power bill → numbers (see src/bill-schema.js). `request` is already
  // scrubbed lines or a cropped photo (src/energy.js billRequest). Not cached.
  async bill(request, { provider = 'edge', model = null, key = '' } = {}) {
    if (!PROVIDER_RE.test(provider) || provider === 'auto') provider = 'edge';
    return this.#post('/bill', { ...request, provider, ...(model ? { model } : {}) }, provider === 'edge' ? '' : key, 70_000);
  }

  models(provider, key) {
    if (!PROVIDER_RE.test(provider)) throw new HearthError(400, 'Unknown provider');
    return this.#post('/models', { provider }, key, 20_000);
  }

  forget(tvId) {
    this.cache.delete(tvId);
  }
}
