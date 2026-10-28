// Real app icons at runtime: GET /hearth/api/app-icon?name=Peacock[&strict=1]
// asks Apple's public App Store search (no key) for the app, keeps the answer
// in D1 for 30 days (shared by every house), and redirects to Apple's
// artwork CDN. Only the app's name is sent; nothing about the house.
//
// Catalog apps (src/catalog.js) are matched loosely: the first result that
// shares a word with the name (Apple ranks the real app first; "Max" is
// "HBO Max" again). Anything else a TV lists is `strict`: the App Store name,
// before its ": tagline", must be the same name, so an obscure TV app never
// gets a stranger's icon.

const TTL_MS = 30 * 24 * 3600e3;
const MISS_TTL_MS = 7 * 24 * 3600e3;
const SIZE = 256;

export const iconKey = (name, strict) => `${strict ? 's' : 'c'}:${normal(name)}`;
const normal = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}+]+/gu, ' ').trim();
// Words that say nothing about which app it is.
const GENERIC = new Set(['tv', 'app', 'the', 'live', 'stream', 'streaming', 'movies', 'movie', 'shows', 'show', 'video', 'videos', 'music', 'free', 'watch', 'and', 'sports', 'news', 'plus', 'now']);
const words = (s) => normal(s).split(' ').filter((w) => (w.length > 1 || w === '+') && !GENERIC.has(w));
const base = (track) => normal(String(track).split(/\s[-–—:|]\s|:\s/)[0]);

// The App Store result that is this app, or null.
export function pickApp(results = [], name, strict = false) {
  const want = normal(name);
  if (!want) return null;
  if (strict) return results.find((r) => base(r.trackName) === want) ?? null;
  const ws = new Set(words(name));
  return results.find((r) => base(r.trackName) === want) ?? results.find((r) => words(r.trackName).some((w) => ws.has(w))) ?? null;
}

export const artwork = (r, size = SIZE) => {
  const u = r?.artworkUrl512 || r?.artworkUrl100 || r?.artworkUrl60;
  return u ? u.replace(/\/\d+x\d+(bb)?\.(png|jpg|jpeg|webp)$/i, `/${size}x${size}bb.png`) : null;
};

export async function appIcon(url, env, { fetchFn = fetch, now = Date.now } = {}) {
  const name = String(url.searchParams.get('name') ?? '').slice(0, 60).trim();
  const strict = url.searchParams.get('strict') === '1';
  if (normal(name).length < 2) return new Response('which app?', { status: 400 });
  const key = iconKey(name, strict);
  const db = env.DB;
  const hit = db ? await db.prepare('SELECT url, at FROM app_icons WHERE k = ?').bind(key).first() : null;
  let found = hit && now() - hit.at < (hit.url ? TTL_MS : MISS_TTL_MS) ? hit.url : undefined;
  if (found === undefined) {
    // %20, not URLSearchParams' "+": the App Store search rejects "+" for spaces.
    const q = `https://itunes.apple.com/search?entity=software&country=us&limit=8&term=${encodeURIComponent(name)}`;
    // Apple's search sometimes turns Cloudflare away or answers empty: try
    // twice, and only remember "no icon" when it really answered and nothing
    // matched (an empty answer once cached Netflix as icon-less for a week).
    let results = null;
    for (let i = 0; i < 2 && !results?.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 400));
      const res = await fetchFn(q, { headers: { accept: 'application/json', 'user-agent': 'Hearth/1.0 (+https://mutaafaziz.com/hearth)' } }).catch(() => null);
      if (res?.ok) results = (await res.json().catch(() => ({}))).results ?? null;
    }
    if (!results?.length) return new Response('the App Store didn’t answer', { status: 502, headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
    found = artwork(pickApp(results, name, strict)) ?? '';
    await db?.prepare('INSERT INTO app_icons (k, url, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET url = excluded.url, at = excluded.at').bind(key, found, now()).run();
  }
  if (!found) return new Response('no icon', { status: 404, headers: { 'cache-control': 'public, max-age=86400', 'access-control-allow-origin': '*' } });
  return new Response(null, { status: 302, headers: { location: found, 'cache-control': 'public, max-age=2592000', 'access-control-allow-origin': '*' } });
}
