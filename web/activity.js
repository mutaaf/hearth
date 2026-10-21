// What is this TV doing right now? Pure and shared: the hub uses it for
// view.activity, the browser uses it as a fallback (and in the demo).
//
// Input: a TV view-ish object { brand, paired, state: { online, power, app,
// appTitle, inputLabel } }. Output: { kind, label, source, confidence }.

export const KINDS = {
  game: { emoji: '🎮', verb: 'Playing', word: 'game' },
  console: { emoji: '🎮', verb: 'Playing', word: 'game' },
  browser: { emoji: '🌐', verb: 'Browsing', word: 'browser' },
  streaming: { emoji: '🍿', verb: 'Watching', word: 'streaming' },
  'live-tv': { emoji: '📺', verb: 'Live TV', word: 'live TV' },
  music: { emoji: '🎵', verb: 'Listening', word: 'music' },
  home: { emoji: '🏠', verb: 'Home screen', word: 'home screen' },
  idle: { emoji: '💤', verb: 'Idle', word: 'idle' },
  off: { emoji: '⏻', verb: 'Off', word: 'off' },
  unknown: { emoji: '✨', verb: 'On', word: 'on' },
};

// Exact app ids first (most confident), then title keywords.
const BROWSER_IDS = new Set([
  'com.webos.app.browser',
  'org.tizen.browser',
  'com.android.chrome',
  'org.mozilla.tv.firefox',
  'org.mozilla.firefox',
  'com.opera.browser',
  'com.amazon.cloud9',
  'com.microsoft.emmx',
]);
const HOME_IDS = new Set(['com.apple.HeadBoard', 'com.apple.PineBoard', 'com.webos.app.home', 'com.webos.app.homeconnect', 'com.webos.app.launcher', 'com.google.android.tvlauncher', 'com.google.android.apps.tv.launcherx']);
const IDLE_IDS = new Set(['com.webos.app.screensaver', 'com.webos.app.igallery']);
const LIVE_IDS = new Set(['com.webos.app.livetv', 'com.webos.app.livemenu', 'tvinput.dtv', 'org.tizen.tv-viewer']);
const GAME_IDS = new Set(['com.webos.app.gamedashboard', 'com.webos.app.gameoptimizer', 'com.nvidia.geforcenow', 'com.microsoft.xcloud', 'com.amazon.luna', 'com.valvesoftware.steamlink', 'com.netflix.ninja.games', 'com.apple.Arcade']);

const GAME_RE = /geforce|xbox|x ?cloud|\bluna\b|steam ?link|boosteroid|stadia|shadow pc|parsec|netflix games|\bgames?\b|arcade|minecraft|fortnite|roblox|pac-?man|tetris|solitaire|trivia|jackbox|sonic|mario|asphalt|crossy|angry birds|\bplay(ing)? ?station\b|\bps[45]\b|nintendo|switch|steam deck|retro|emulat/i;
const BROWSER_RE = /\b(browser|chrome|firefox|opera|silk|edge|vewd|puffin)\b|internet|web ?browser/i;
const MUSIC_RE = /spotify|pandora|amazon music|apple music|tidal|siriusxm|sirius|youtube music|soundcloud|iheart|deezer|tunein|music/i;
const STREAM_RE = /com\.apple\.tv(watchlist|movies|shows)|netflix|youtube|prime ?video|amazon(video)?|disney|hulu|\bmax\b|hbo|apple ?tv|paramount|peacock|plex|jellyfin|emby|tubi|pluto|crunchyroll|vudu|fandango|sling|fubo|twitch|kodi|starz|showtime|discovery|espn|nfl|nba|mlb|dazn|britbox|acorn|mubi|kanopy|hoopla|freevee|roku channel|philo|frndly/i;
const LIVE_RE = /live ?tv|antenna|\btuner\b|over.the.air|\bota\b|cable|directv|xfinity|spectrum|tivo|dish|\bu-?verse\b/i;
const CONSOLE_INPUT_RE = /play ?station|\bps ?[2-5]\b|xbox|nintendo|switch|steam ?deck|\bgaming|game|retro|wii|sega|atari|\bpc\b|computer/i;
const STREAMER_INPUT_RE = /apple ?tv|roku|chromecast|google tv|fire ?tv|fire ?stick|shield|android tv|streamer|kodi|plex/i;
const LIVE_INPUT_RE = /cable|set.?top|\bstb\b|directv|xfinity|spectrum|tivo|dish|antenna|satellite|\bbox\b/i;

const hdmiNumber = (app) => (app ?? '').match(/hdmi[_-]?(\d)/i)?.[1];

export function classify(tv) {
  const s = tv?.state ?? {};
  if (!s.online || s.power === 'off') return result('off', 'Off', 'power', 1);
  if (/standby|screen_off/.test(s.power ?? '')) return result('idle', 'Standby', 'power', 0.95);
  if (s.power === 'screen_saver') return result('idle', 'Screensaver', 'power', 0.95);

  const id = String(s.app ?? '');
  const title = String(s.appTitle ?? '');
  const both = `${id} ${title}`;

  // An HDMI input: the device plugged in tells us (via its CEC name).
  const hdmi = hdmiNumber(id) ?? (/^tvinput\.hdmi/i.test(id) ? hdmiNumber(id) : null);
  if (hdmi || /^tvinput\.hdmi/i.test(id)) {
    const label = s.inputLabel || (title && !/^hdmi/i.test(title) ? title : `HDMI ${hdmi ?? ''}`.trim());
    if (CONSOLE_INPUT_RE.test(label)) return result('console', label, 'hdmi-input', s.inputLabel ? 0.9 : 0.8);
    if (STREAMER_INPUT_RE.test(label)) return result('streaming', label, 'hdmi-input', 0.75);
    if (LIVE_INPUT_RE.test(label)) return result('live-tv', label, 'hdmi-input', 0.75);
    return result('unknown', label, 'hdmi-input', 0.5);
  }

  if (!id && !title) return result('home', 'Home screen', 'no-app', 0.6);
  if (HOME_IDS.has(id) || /dynamic menu|^roku$|home ?screen|launcher/i.test(title)) return result('home', 'Home screen', 'app-id', 0.9);
  if (IDLE_IDS.has(id) || /screensaver|ambient|art mode/i.test(both)) return result('idle', title || 'Screensaver', 'app-id', 0.85);
  if (LIVE_IDS.has(id)) return result('live-tv', title || 'Live TV', 'app-id', 0.95);
  if (BROWSER_IDS.has(id)) return result('browser', title || 'Web browser', 'app-id', 0.95);
  if (GAME_IDS.has(id)) return result('game', title || 'Game', 'app-id', 0.95);

  const name = title || prettyId(id);
  if (BROWSER_RE.test(both)) return result('browser', name, 'title', 0.75);
  if (GAME_RE.test(both)) return result('game', name, 'title', 0.7);
  if (MUSIC_RE.test(both) && !/youtube(?! music)/i.test(both)) return result('music', name, 'title', 0.75);
  if (STREAM_RE.test(both)) return result('streaming', name, 'title', 0.8);
  if (LIVE_RE.test(both)) return result('live-tv', name, 'title', 0.7);
  return result('unknown', name, 'fallback', 0.3);
}

function result(kind, label, source, confidence) {
  return { kind, label, source, confidence };
}

function prettyId(id) {
  const last = id.split('.').pop() || id;
  return last.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

// "2 games, 1 browser, 1 streaming" — only for screens doing something.
export function summarize(activities) {
  const order = ['game', 'browser', 'streaming', 'live-tv', 'music'];
  const counts = new Map();
  for (const a of activities) {
    const kind = a?.kind === 'console' ? 'game' : a?.kind;
    if (order.includes(kind)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const plural = (kind, n) => {
    const word = KINDS[kind].word;
    if (n === 1 || word === 'streaming' || word === 'music' || word === 'live TV') return `${n} ${word}`;
    return `${n} ${word}s`;
  };
  return order.filter((k) => counts.has(k)).map((k) => plural(k, counts.get(k))).join(', ');
}

// Which remote suits what's on screen.
export function suggestedMode(activity) {
  if (activity?.kind === 'browser') return 'trackpad';
  if (activity?.kind === 'game' || activity?.kind === 'console') return 'gamepad';
  return 'remote';
}
