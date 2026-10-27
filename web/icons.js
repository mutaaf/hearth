// App icons, best first: the real icon a TV in this house hands out for that
// app (Roku and LG list them; full colour, the app's own artwork), then a
// vector logo (web/brand-icons.js), then a letter on the brand colour.
//
// The home server proxies TV icons at api/tvs/:id/icon. The phone app has no
// HTTP server, so there they come through the API as data and are kept for
// the session.
import { BRAND_PATHS } from './brand-icons.js';

const cache = new Map(); // "tvId|url" → data URL (phone app)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The vector logo for a catalog key, or ''.
export function brandSvg(key) {
  const d = BRAND_PATHS[key];
  return d ? `<svg class="brand-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>` : '';
}

// A TV's icon, laid over whatever fallback is already in the tile. hydrate()
// loads it; if it fails, it's removed and the fallback shows.
export function tvIconImg(tvId, url) {
  return `<img class="tv-icon" alt="" data-icon-tv="${esc(tvId)}" data-icon-u="${esc(url)}">`;
}

export function hydrate(root, api) {
  const native = Boolean(window.HearthHost?.native) && !window.HearthDemo;
  for (const img of root.querySelectorAll('img[data-icon-u]:not([src])')) {
    const tv = img.dataset.iconTv;
    const u = img.dataset.iconU;
    img.addEventListener('error', () => img.remove(), { once: true });
    img.addEventListener('load', () => img.closest('.app-icon')?.classList.add('has-art'), { once: true });
    if (!native) {
      img.src = `api/tvs/${encodeURIComponent(tv)}/icon?u=${encodeURIComponent(u)}`;
      continue;
    }
    const key = `${tv}|${u}`;
    const hit = cache.get(key);
    if (hit) {
      img.src = hit;
      continue;
    }
    api('GET', `/tvs/${encodeURIComponent(tv)}/icon-data?u=${encodeURIComponent(u)}`)
      .then((d) => {
        const src = `data:${d.type};base64,${d.data}`;
        cache.set(key, src);
        img.src = src;
      })
      .catch(() => img.remove());
  }
}
