// "What's new": the one source of truth for each version's update notes.
// The in-app modal (web/whatsnew.js) reads it, and so does the App Store
// "What's New" text (`node scripts/whats-new.mjs`). Newest first.
//
// RELEASE_VERSION must equal package.json "version" (test/whatsnew.test.js).
// Bumping the version means adding an entry here, written from the real
// changes since the last entry (git log).
//
// Copy rules (enforced in part by the test, the rest by review):
// - Every feature claim must be true for this version.
// - Playful nods to movie night, TV, seasons, game-day weekends and award
//   season are welcome, but original only: no real show or film titles,
//   characters, franchises, brands, logos, quotes or real people. Brand
//   names appear only where a feature needs them (which TVs or boxes).
// - No politics, no tragedy, family-friendly.
// - Callouts: 2-4, each { art, title (a few words), line (one short line) }.
//   art is one of Hearth's own shapes (web/shapes.js).

export const RELEASE_VERSION = '0.16.0';

export const NOTES = [
  {
    version: '0.16.0',
    date: '2026-11-10',
    kicker: 'Now showing',
    headline: 'The blanket-season premiere',
    dek: 'Popcorn on, game-day weekends ahead, and your remote just got a sequel worth staying in for.',
    callouts: [
      {
        art: 'hearth-remote',
        palette: 'ember',
        title: 'Scenes, just say it',
        line: 'Type one sentence and Hearth builds the scene. Try it live, then save.',
      },
      {
        art: 'hearth-tv',
        palette: 'ember',
        title: 'A wake-up call that works',
        line: 'A step-by-step coach finds what turns each TV on, even the box plugged into it.',
      },
      {
        art: 'hearth-signal',
        palette: 'ice',
        title: 'Plot twist: it moved',
        line: 'When the router gives a TV a new address overnight, Hearth finds it again.',
      },
      {
        art: 'hearth-flame',
        palette: 'ember',
        title: 'Daylight mode',
        line: 'A bright new look by default. Light, Dark or Auto lives in Settings.',
      },
    ],
    notes: [
      'Scenes from one sentence: describe it ("movie night downstairs, weekends at 8") and the AI builds it, with the days you named. Try it now before you save.',
      'Turn on from your phone: a coach for each TV picks the way that works, walks you through it, tests it for real, and asks the AI for fixes if the test fails.',
      'Wake a TV through the Roku or Apple TV plugged into it. When Hearth notices them coming on together, it offers to set that up for you.',
      'Press any button on a sleeping TV and Hearth wakes it first, whenever that TV can be woken.',
      'TVs that got a new address from the router overnight are found again by themselves, and a small capsule at the top says when Hearth is looking.',
      'Know your TV: setup tips for your exact model, an Ask the AI button, and "Send it to us" when you are still stuck.',
      'Setup starts looking the moment it opens and keeps looking, with fixes right where you need them.',
      'Real app logos in the launcher.',
      'A guided tour: tap "?" any time for a spotlight on every button and gesture.',
      'Light mode by default, with Light, Dark and Auto in Settings. Hearth switches on like an old TV each time you open it (not with Reduce Motion).',
      'In the iPhone app, Apple TV pairs with one code and no computer.',
      'Messages get out of your way: tap or flick one to dismiss it.',
      'Eight hidden surprises to find. No hints.',
      'Laid out for fold-style iPhones, outer screen included.',
      'LG: a press right after the TV switches on no longer says it is offline.',
    ],
  },
];

export function notesFor(version) {
  return NOTES.find((n) => n.version === version) ?? null;
}

// Plain text for App Store Connect's "What's New" (4000 characters max).
export function storeText(version = RELEASE_VERSION) {
  const n = notesFor(version);
  if (!n) return '';
  const text = [`${n.headline}.`, n.dek, '', ...n.notes.map((line) => `• ${line}`)].join('\n');
  return text.length > 4000 ? `${text.slice(0, 3999)}…` : text;
}
