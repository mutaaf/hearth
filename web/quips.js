// What Hearth says when something happens: a few lines per moment, picked at
// random so the fifth "off" doesn't read like the first. Short, warm, a wink
// at most; never at the person's expense. {tv}, {app}, {scene}, {n} fill in.

const LINES = {
  tvOff: ['{tv} is off. Credits roll. 🎬', 'Goodnight, {tv}. 🌙', '{tv}: powered down. Rest easy, big screen.', '{tv} is off. The couch has been notified. 🛋️'],
  waking: ['Waking {tv}… ☕', 'Rise and shine, {tv}. ☀️', 'Nudging {tv} awake…', 'Knock knock, {tv}. 🚪'],
  wakingPress: ['Waking {tv} first. Your press goes through once it’s up. ☕', '{tv} was napping. Waking it, then doing that. ⏳'],
  allOff: ['Lights out. The house sleeps. 🌙', 'Every screen: off. Go touch grass. 🌱', 'Blackout complete. Very dramatic. 🎭', 'All quiet on the living-room front. 🕊️', 'Screens off. Board game, anyone? 🎲'],
  sent: ['Delivered to the big screen. 📺', 'Message beamed. They can’t say they didn’t see it. 👀', 'On the TV now. Loud and clear (well, silent and clear).', 'Sent. Consider them informed. 📣'],
  launch: ['Opening {app}. 🍿', '{app}, coming right up.', 'Rolling {app}… 🎬', 'Cue {app}. ✨'],
  launchAll: ['{app} on all {n} TVs. Synchronised viewing! 📺📺', '{app} everywhere. The house is in sync. ✓'],
  scene: ['{scene}: and… action! 🎬', '{scene} ✓ Scene set.', '{scene}, done. Take a bow. 🎭'],
  oops: ['Hmm, that didn’t land. Try again?', 'The TV is playing hard to get. One more try?', 'That one got lost on the way. Give it another go.'],
};

export function quip(kind, fill = {}) {
  const pool = LINES[kind];
  if (!pool) return '';
  const line = pool[Math.floor(Math.random() * pool.length)];
  return line.replace(/\{(\w+)\}/g, (_, k) => String(fill[k] ?? ''));
}

// A message for the toast: never empty, never "undefined" or "[object …]".
export function plain(message, fallback = quip('oops')) {
  const text = typeof message === 'string' ? message.trim() : message instanceof Error ? message.message.trim() : '';
  return !text || /^(undefined|null|\[object \w+\]|error)$/i.test(text) ? fallback : text;
}
