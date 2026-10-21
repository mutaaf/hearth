// The cross-brand app catalog: the streaming apps people actually open, with
// each platform's own id for them. "Open YouTube TV on every TV" resolves the
// right id per TV from here (see resolveApp), so nobody has to know that it's
// PvWgqxV3Xa.YouTubeTV on a Samsung and 195316 on a Roku.
//
// ids are arrays, most current first: the same app ships under different ids
// by model year and region. Resolution takes the first id that is installed
// on the TV, then falls back to an exact title match, then a careful fuzzy one.
//
// Platforms:
//   samsung   Tizen app id (ed.apps.launch / REST :8001/api/v2/applications/<id>)
//   lg        webOS app id (ssap://system.launcher/launch { id })
//   roku      Roku channel id (ECP POST /launch/<id>)
//   androidtv Google Cast receiver app id (Cast LAUNCH). Only apps that ship a
//             Cast receiver can be opened this way; [] means "not over Cast".
//   appletv   tvOS bundle id (Companion protocol launch)
//
// Sources (short tags used per id below):
//   seen     read off this house's TVs, 2026-10: Samsung UN55KU6290 (2016) via
//            ed.installedApp.get + REST /api/v2/applications/<id>; LG 55UP7000 (2021)
//            listLaunchPoints; Roku Streaming Stick 3840R /query/apps; Cast
//            GET_APP_AVAILABILITY on a TCL 65A300W.
//   us.csv   SamadiPour/Samsung-TV-Regional-Apps output/apps/US.csv (US Tizen store scrape)
//   xchw     xchwarze/samsung-tv-ws-api APPLICATIONS.md
//   fhem     fhem/LGTV_WebOS; lgtvip = WesSouza/lgtv-ip-control TV.ts;
//            nxe = lewisdoesstuff/webos-nxe; tvunlock = shipstuff/tvunlock recipes
//   rcmd     dukedook/rokucommand "Roku Apps.txt" (query/apps off a real Roku)
//   reg      Google's Cast app registry (clients3.google.com/cast/chromecast/device/app?a=<id>)
//   itunes   itunes.apple.com/lookup?bundleId=<id> (tvOS app)
//   ?        single source / unverified: resolution falls back to title matching
//            when it's wrong, so a bad guess costs nothing but a miss.
//
// androidtv: Cast can only open apps with a registered Cast receiver. Max,
// Hulu, Apple TV, Peacock, ESPN, Tubi, Pluto TV, Sling, Fubo and Crunchyroll
// publish none, so they can't be opened on a Google TV without Google's
// pairing code (the Android TV remote protocol) — `note` says so in the app.
// Roku has no Twitch channel (removed 2019) and no separate YouTube Kids.
const NO_CAST = 'No Cast receiver: open it on Google TV with its own remote';
export const CATALOG = [
  {
    key: 'youtube', title: 'YouTube', mark: '▶', color: '#e62117',
    ids: {
      samsung: ['111299001912'], // seen, us.csv
      lg: ['youtube.leanback.v4'], // seen, fhem
      roku: ['837'], // seen, rcmd
      androidtv: ['233637DE'], // reg, seen (pychromecast APP_YOUTUBE)
      appletv: ['com.google.ios.youtube'], // itunes
    },
  },
  {
    key: 'youtubetv', title: 'YouTube TV', mark: 'TV', color: '#cc0000',
    ids: {
      samsung: ['3201707014489', 'PvWgqxV3Xa.YouTubeTV'], // seen (store id + Tizen package id both answer REST), us.csv
      lg: ['youtube.leanback.ytv.v1'], // seen, tvunlock
      roku: ['195316'], // seen, rcmd
      androidtv: ['32EAB1DF'], // reg "YouTube TV", seen available
      appletv: ['com.google.ios.youtubeunplugged'], // itunes
    },
  },
  {
    key: 'netflix', title: 'Netflix', mark: 'N', color: '#e50914',
    ids: {
      samsung: ['3201907018807', '11101200001'], // us.csv; seen (2016-18 id)
      lg: ['netflix'], // seen, fhem, lgtvip
      roku: ['12'], // seen, rcmd
      androidtv: ['CA5E8412'], // reg (Google TV reports APP_UNAVAILABLE: Netflix uses its own protocol there)
      appletv: ['com.netflix.Netflix'], // itunes
    },
  },
  {
    key: 'primevideo', title: 'Prime Video', aliases: ['Amazon Prime Video', 'Amazon Video'], mark: 'prime', color: '#00a8e1',
    ids: {
      samsung: ['3201910019365', '3201512006785'], // us.csv; seen (legacy org.tizen.ignition)
      lg: ['amazon'], // seen, fhem, lgtvip
      roku: ['13'], // seen, rcmd
      androidtv: ['17608BC8'], // reg "Prime Video", seen available
      appletv: ['com.amazon.aiv.AIVApp'], // itunes
    },
  },
  {
    key: 'disneyplus', title: 'Disney+', aliases: ['Disney Plus'], mark: 'D+', color: '#113ccf',
    ids: {
      samsung: ['3201901017640', '3202009021709', '3202204027038'], // us.csv, seen; xchw (other regions)
      lg: ['com.disney.disneyplus-prod'], // seen, fhem, lgtvip
      roku: ['291097'], // seen, rcmd
      androidtv: ['C3DE6BC2'], // reg, seen available
      appletv: ['com.disney.disneyplus'], // itunes
    },
  },
  {
    key: 'max', title: 'Max', aliases: ['HBO Max', 'HBO GO', 'HBO Now'], mark: 'max', color: '#002be7',
    ids: {
      samsung: ['3202301029760', '3201601007230'], // us.csv; seen (legacy HBO Max)
      lg: ['com.wbd.stream', 'com.hbo.hbomax'], // seen (both, on a 2021 set: Max + legacy HBO Max)
      roku: ['61322'], // seen, rcmd
      androidtv: [],
      appletv: ['com.wbd.stream'], // itunes (com.hbo.hbonow is retired)
    },
    note: NO_CAST,
  },
  {
    key: 'hulu', title: 'Hulu', mark: 'hulu', color: '#1ce783',
    ids: {
      samsung: ['3201601007625'], // us.csv, seen
      lg: ['hulu'], // seen, lgtvip
      roku: ['2285'], // seen, rcmd
      androidtv: [],
      appletv: ['com.hulu.plus'], // itunes
    },
    note: NO_CAST,
  },
  {
    key: 'appletv', title: 'Apple TV', aliases: ['Apple TV+', 'Apple TV Plus'], mark: 'tv', color: '#1d1d1f',
    ids: {
      samsung: ['3201807016597'], // us.csv
      lg: ['com.apple.appletv'], // seen, fhem, nxe
      roku: ['551012'], // seen, rcmd
      androidtv: [],
      appletv: ['com.apple.TVWatchList'], // built-in TV app (pyatv app lists)
    },
    note: NO_CAST,
  },
  {
    key: 'peacock', title: 'Peacock', mark: 'P', color: '#000000',
    ids: {
      samsung: ['3202006020991'], // us.csv
      lg: ['com.peacock.tv', 'com.peacocktv.peacockwebos'], // seen; ? open-tv-remote
      roku: ['593099'], // rcmd
      androidtv: [],
      appletv: ['com.peacocktv.peacock'], // itunes
    },
    note: NO_CAST,
  },
  {
    key: 'paramountplus', title: 'Paramount+', aliases: ['Paramount Plus', 'CBS All Access'], mark: 'P+', color: '#0064ff',
    ids: {
      samsung: ['3201710014981', '3202110025305'], // us.csv + seen (was CBS All Access); international
      lg: ['com.cbs-all-access.webapp.prod', 'com.cbs-ott.2'], // seen; ? open-tv-remote
      roku: ['31440'], // seen, rcmd
      androidtv: ['0BBDC217'], // reg "Paramount+", seen available
      appletv: ['com.cbsvideo.app'], // itunes
    },
  },
  {
    key: 'espn', title: 'ESPN', aliases: ['ESPN+', 'WatchESPN'], mark: 'E', color: '#d00',
    ids: {
      samsung: ['3201708014618'], // us.csv
      lg: ['com.espn.espnplus-prod'], // seen, launcher catalogs
      roku: ['34376'], // seen, rcmd
      androidtv: [],
      appletv: ['com.espn.ScoreCenter'], // itunes
    },
    note: NO_CAST,
  },
  {
    key: 'spotify', title: 'Spotify', mark: 'S', color: '#1db954',
    ids: {
      samsung: ['3201606009684'], // us.csv, seen ("Spotify - Music and Podcasts")
      lg: ['spotify-beehive'], // fhem
      roku: ['22297'], // rcmd
      androidtv: ['CC32E753'], // reg, seen available
      appletv: ['com.spotify.client'], // itunes
    },
  },
  {
    key: 'plex', title: 'Plex', mark: 'plex', color: '#e5a00d',
    ids: {
      samsung: ['3201512006963'], // us.csv
      lg: ['cdp-30'], // fhem, lgtvip
      roku: ['13535'], // rcmd
      androidtv: ['9AC194DC'], // reg, seen available
      appletv: ['com.plexapp.plex'], // itunes
    },
  },
  {
    key: 'tubi', title: 'Tubi', mark: 'T', color: '#7408ff',
    ids: {
      samsung: ['3201504001965'], // us.csv
      lg: ['com.tubitv.ott.tubi'], // seen, launcher catalogs
      roku: ['41468'], // rcmd
      androidtv: [],
      appletv: ['com.adrise.tubitv'], // itunes
    },
    note: NO_CAST,
  },
  {
    key: 'plutotv', title: 'Pluto TV', mark: 'P', color: '#fff200',
    ids: {
      samsung: ['3201808016802', '3201504001846'], // us.csv; seen (older id)
      lg: ['com.plutotv.app'], // seen, tvunlock
      roku: ['74519'], // rcmd
      androidtv: [],
      appletv: ['tv.pluto.ios'], // itunes
    },
    note: NO_CAST,
  },
  {
    key: 'sling', title: 'Sling TV', aliases: ['Sling'], mark: 'S', color: '#2c8fff',
    ids: {
      samsung: ['3201707014448'], // us.csv
      lg: ['com.movenetworks.app.sling-tv-sling-production'], // seen, lgtvip
      roku: ['46041'], // rcmd
      androidtv: [],
      appletv: ['com.dishdigital.sling'], // itunes
    },
    note: NO_CAST,
  },
  {
    key: 'fubo', title: 'Fubo', aliases: ['fuboTV'], mark: 'f', color: '#fa4616',
    ids: {
      samsung: ['3201903017953'], // us.csv
      lg: ['com.fubotv.app'], // ? tvunlock
      roku: ['43465'], // ? widely cited
      androidtv: [],
      appletv: ['tv.fubo.mobile'], // itunes (universal app)
    },
    note: NO_CAST,
  },
  {
    key: 'twitch', title: 'Twitch', mark: 'tw', color: '#9146ff',
    ids: {
      samsung: ['3202203026841'], // us.csv
      lg: ['tv.twitch.tv.starshot.lg'], // nxe, tvunlock
      roku: [], // no Roku channel since 2019
      androidtv: ['B3DCF968'], // reg "Twitch Chromecast Player", seen available
      appletv: ['tv.twitch'], // itunes
    },
  },
  {
    key: 'crunchyroll', title: 'Crunchyroll', mark: 'cr', color: '#f47521',
    ids: {
      samsung: ['3202302030097'], // us.csv
      lg: ['com.crunchyroll.webapp'], // ? tvunlock
      roku: ['2595'], // rcmd
      androidtv: [],
      appletv: ['com.crunchyroll.iphone'], // itunes
    },
    note: NO_CAST,
  },
  {
    key: 'youtubekids', title: 'YouTube Kids', mark: 'K', color: '#ff4e45',
    ids: {
      samsung: ['3201611010983'], // xchw (may be delisted in the US store)
      lg: ['youtube.leanback.kids.v4'], // fhem
      roku: [], // none: kids profiles live inside YouTube
      androidtv: ['0354A290'], // reg "YouTube Kids", seen available
      appletv: ['com.google.ios.youtubekids'], // itunes
    },
  },
];

// ── Matching ─────────────────────────────────────────────
// "Disney+" ≡ "Disney Plus", "Spotify - Music and Podcasts" → spotify music and podcasts.
export function normTitle(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/&|＆/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const words = (s) => (s ? s.split(' ') : []);
const names = (entry) => [entry.title, ...(entry.aliases ?? [])].map(normTitle);

// Find a catalog entry by key ("youtubetv") or by name ("YouTube TV", "hbo max").
export function catalogApp(ref) {
  if (!ref) return null;
  const s = String(ref);
  const byKey = CATALOG.find((e) => e.key === s.toLowerCase());
  if (byKey) return byKey;
  const n = normTitle(s);
  return CATALOG.find((e) => names(e).includes(n)) ?? null;
}

// Which catalog entry does an installed app belong to? By id first, then by
// name: an exact name, else the entry whose name is the longest word-prefix of
// the app's title. "YouTube TV" belongs to youtubetv (two words beat one), so
// a fuzzy search for YouTube can never pick it, and vice versa.
export function ownerOf(app, brand) {
  if (app?.id != null) {
    const byId = CATALOG.find((e) => (e.ids[brand] ?? []).includes(String(app.id)));
    if (byId) return byId;
  }
  const t = words(normTitle(app?.title));
  if (!t.length) return null;
  let best = null;
  let bestLen = 0;
  for (const e of CATALOG) {
    for (const n of names(e)) {
      const w = words(n);
      if (w.length === t.length && w.every((x, i) => x === t[i])) return e; // exact
      if (w.length < t.length && w.length > bestLen && w.every((x, i) => x === t[i])) {
        best = e;
        bestLen = w.length;
      }
    }
  }
  return best;
}

// Pick the id to launch on one TV. `apps` is what the TV says is installed
// ({ id, title }[]); null means "the TV can't list apps" (then the first
// catalog id is tried blind). Returns { id, title, via } or null.
export function resolveApp(entry, brand, apps) {
  if (!entry) return null;
  const ids = (entry.ids?.[brand] ?? []).map(String);
  if (apps == null) return ids.length ? { id: ids[0], title: entry.title, via: 'catalog' } : null;
  const byId = new Map(apps.map((a) => [String(a.id), a]));
  for (const id of ids) if (byId.has(id)) return { id, title: byId.get(id).title || entry.title, via: 'id' };
  // Exact name (any alias), but never an app whose id belongs to another entry.
  const mine = (a) => {
    const owner = ownerOf(a, brand);
    return !owner || owner === entry || owner.key === entry.key;
  };
  const wanted = names(entry);
  const exact = apps.find((a) => wanted.includes(normTitle(a.title)) && mine(a));
  if (exact) return { id: String(exact.id), title: exact.title, via: 'title' };
  // Fuzzy: the app's best catalog owner must be this entry ("Spotify - Music
  // and Podcasts" → spotify; "YouTube TV" never → youtube).
  const fuzzy = apps.find((a) => {
    const owner = ownerOf(a, brand);
    return owner && (owner === entry || owner.key === entry.key);
  });
  if (fuzzy) return { id: String(fuzzy.id), title: fuzzy.title, via: 'fuzzy' };
  return null;
}

// Resolve a free-typed title against a TV's apps when it isn't in the catalog
// (scenes can say "Open Pandora"). Exact first, then a whole-word prefix, and
// never an app that belongs to a different catalog entry.
export function matchTitle(title, apps, brand) {
  const entry = catalogApp(title);
  if (entry) return resolveApp(entry, brand, apps);
  const n = normTitle(title);
  if (!n || !apps) return null;
  const exact = apps.find((a) => normTitle(a.title) === n);
  if (exact) return { id: String(exact.id), title: exact.title, via: 'title' };
  const w = words(n);
  const prefix = apps.find((a) => {
    const t = words(normTitle(a.title));
    return w.length < t.length && w.every((x, i) => x === t[i]) && !ownerOf(a, brand);
  });
  return prefix ? { id: String(prefix.id), title: prefix.title, via: 'fuzzy' } : null;
}

// What the app shows: no ids (they're per brand), just what can be launched where.
export function catalogView() {
  return CATALOG.map((e) => ({
    key: e.key,
    title: e.title,
    mark: e.mark,
    color: e.color,
    brands: Object.keys(e.ids).filter((b) => e.ids[b].length),
    ...(e.note ? { note: e.note } : {}),
  }));
}
