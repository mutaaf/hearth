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
// - Callouts: 2-4, each { art, title (a few words), line (one short line),
//   go? }. art is one of Hearth's own shapes (web/shapes.js).
// - go (optional): where the card takes you. Tapping the card closes the
//   sheet and opens that place. One of DESTINATIONS in web/whatsnew.js:
//     'scene-say'  New scene, "just say it"
//     'wake'       Turn on from your phone (the coach) for the TV on screen,
//                  else the first TV; setup when there are none
//     'settings'   Settings (Light / Dark / Auto, looks)
//   Leave it out when the feature has no screen (it just happens): the card
//   stays plain. app.js routes each one (`whatsNewGo`).
// - One line per version may nod to something current (a season, what's on
//   this month); keep the source and date in the PR, never in the app.
//
// Seeing it without updating (records nothing, so the real once-per-version
// rule is untouched):
// - Web: add ?whatsnew=preview to the URL (demo: /hearth/demo/?whatsnew=preview).
// - iPhone app, Debug builds only (hearth-app sets HearthHost.whatsNew):
//     xcrun simctl launch <sim> com.mutaaf.hearth -HearthWhatsNew YES
//   or keep it on for every launch:
//     xcrun simctl spawn <sim> defaults write com.mutaaf.hearth HearthWhatsNew -bool YES
//   (and `defaults delete com.mutaaf.hearth HearthWhatsNew` to stop).

export const RELEASE_VERSION = '0.16.0';

export const NOTES = [
  {
    version: '0.16.0',
    date: '2026-11-10',
    kicker: 'Now showing',
    headline: 'The blanket-season premiere',
    dek: 'The holiday movies showed up before the leftover candy ran out. Popcorn on: your remote just got a sequel worth staying in for.',
    callouts: [
      {
        art: 'hearth-remote',
        palette: 'ember',
        title: 'Scenes, just say it',
        line: 'Type one sentence and Hearth builds the scene. Try it live, then save.',
        go: 'scene-say',
      },
      {
        art: 'hearth-tv',
        palette: 'ember',
        title: 'A wake-up call that works',
        line: 'A step-by-step coach finds what turns each TV on, even the box plugged into it.',
        go: 'wake',
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
        go: 'settings',
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
