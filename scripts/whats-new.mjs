// Prints the App Store "What's New" text for a version, from the same notes
// the in-app sheet shows (web/whatsnew-notes.js). Read-only: it never talks to
// App Store Connect. hearth-app's release step pastes or uploads this.
//   node scripts/whats-new.mjs            → the current version (package.json)
//   node scripts/whats-new.mjs 0.16.0     → a given version
import { RELEASE_VERSION, notesFor, storeText } from '../web/whatsnew-notes.js';

const version = process.argv[2] ?? RELEASE_VERSION;
if (!notesFor(version)) {
  console.error(`No notes for ${version} in web/whatsnew-notes.js`);
  process.exit(1);
}
process.stdout.write(`${storeText(version)}\n`);
