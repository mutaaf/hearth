// App icons, best first: the app's real icon from the App Store (looked up
// by name at runtime through Hearth's Worker, cached there for every house:
// src/worker/app-icon.js), then the icon a TV in this house hands out for
// that app (Roku and LG list them), then a vector logo (web/brand-icons.js),
// then a letter on the brand colour. Each layer that fails to load removes
// itself, so the next one shows through.
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

// The App Store icon for an app, by name. `strict`: names a TV listed (not
// from the catalog) must match the App Store name exactly.
const ICON_API = 'https://mutaafaziz.com/hearth/api/app-icon';
export function storeIconImg(name, { strict = false } = {}) {
  if (!name) return '';
  return `<img class="tv-icon store-icon" alt="" loading="lazy" decoding="async" data-store-name="${esc(name)}"${strict ? ' data-store-strict="1"' : ''}>`;
}

export function hydrate(root, api) {
  for (const img of root.querySelectorAll('img[data-store-name]:not([src])')) {
    img.addEventListener('error', () => img.remove(), { once: true });
    img.addEventListener('load', () => img.closest('.app-icon, .dock-item i')?.classList.add('has-art'), { once: true });
    img.src = `${ICON_API}?name=${encodeURIComponent(img.dataset.storeName)}${img.dataset.storeStrict ? '&strict=1' : ''}`;
  }
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
