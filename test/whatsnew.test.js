import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { compareVersions, createWhatsNew, decide, DESTINATIONS, goFor, hadHistory, launchDecision, SEEN_KEY, skipReason } from '../web/whatsnew.js';
import { NOTES, RELEASE_VERSION, notesFor, storeText } from '../web/whatsnew-notes.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// A Storage-shaped stand-in for localStorage.
function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    map: m,
  };
}
const plainEnv = { demo: false, embed: false, framed: false, webdriver: false, preview: false };

test('versions compare numerically', () => {
  assert.equal(compareVersions('0.16.0', '0.15.0'), 1);
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
});

test('fresh install: nothing shows, the version is recorded as seen', () => {
  assert.deepEqual(decide({ seen: null, current: '0.16.0', hasHistory: false }), { show: false, record: '0.16.0' });
  const ls = fakeStorage();
  const d = launchDecision({ env: plainEnv, ls, current: '0.16.0', hasHistory: hadHistory(ls) });
  assert.equal(d.show, false);
  const wn = createWhatsNew({ ls });
  assert.equal(wn.maybeShow({ decision: d }), false);
  assert.equal(ls.getItem(SEEN_KEY), '0.16.0');
  // …and the next launch of the same version stays quiet.
  assert.equal(launchDecision({ env: plainEnv, ls, current: '0.16.0', hasHistory: true }).show, false);
});

test('upgrade: shows once, then never again for that version', () => {
  assert.deepEqual(decide({ seen: '0.15.0', current: '0.16.0' }), { show: true, record: '0.16.0' });
  // An older Hearth (before this feature) left its own storage but no record.
  const old = fakeStorage({ 'hearth.prefs': '{}', 'hearth.tour.seen': '{"house":1}' });
  assert.equal(hadHistory(old), true);
  assert.equal(launchDecision({ env: plainEnv, ls: old, current: '0.16.0', hasHistory: hadHistory(old) }).show, true);
  // After it's shown the record is the new version, so a second launch is quiet.
  old.setItem(SEEN_KEY, '0.16.0');
  assert.equal(launchDecision({ env: plainEnv, ls: old, current: '0.16.0', hasHistory: true }).show, false);
  // The next update shows again.
  assert.equal(launchDecision({ env: plainEnv, ls: old, current: '0.17.0', hasHistory: true, }).show, false, 'no notes for 0.17.0 yet → quiet');
  assert.deepEqual(decide({ seen: '0.16.0', current: '0.17.0', hasNotes: true }), { show: true, record: '0.17.0' });
});

test('same version, downgrade and missing notes stay quiet', () => {
  assert.deepEqual(decide({ seen: '0.16.0', current: '0.16.0' }), { show: false, record: null });
  assert.deepEqual(decide({ seen: '0.17.0', current: '0.16.0' }), { show: false, record: '0.16.0' });
  assert.deepEqual(decide({ seen: '0.15.0', current: '0.16.0', hasNotes: false }), { show: false, record: '0.16.0' });
  assert.equal(hadHistory(fakeStorage({ [SEEN_KEY]: '0.16.0', 'other.app': '1' })), false, 'only hearth.* keys count');
});

test('a blocked launch records nothing, so it tries again next time', () => {
  const ls = fakeStorage({ [SEEN_KEY]: '0.15.0' });
  const wn = createWhatsNew({ ls });
  const d = launchDecision({ env: plainEnv, ls, current: RELEASE_VERSION, hasHistory: true });
  assert.equal(d.show, true);
  assert.equal(wn.maybeShow({ decision: d, blocked: () => true }), false);
  assert.equal(ls.getItem(SEEN_KEY), '0.15.0');
});

test('skipped under the demo, store capture, the landing frame and automation; nothing recorded', () => {
  assert.equal(skipReason({ demo: true }), 'demo'); // public demo, in-app demo.html, store screenshots
  assert.equal(skipReason({ embed: true }), 'embed');
  assert.equal(skipReason({ framed: true }), 'frame');
  assert.equal(skipReason({ webdriver: true }), 'automation');
  assert.equal(skipReason({}), null);
  for (const flag of ['demo', 'embed', 'framed', 'webdriver']) {
    const ls = fakeStorage({ [SEEN_KEY]: '0.15.0', 'hearth.prefs': '{}' });
    const d = launchDecision({ env: { ...plainEnv, [flag]: true }, ls, current: '0.16.0', hasHistory: true });
    assert.equal(d.show, false, flag);
    assert.equal(createWhatsNew({ ls }).maybeShow({ decision: d }), false);
    assert.equal(ls.getItem(SEEN_KEY), '0.15.0', `${flag} leaves the record alone`);
  }
  // ?whatsnew=preview shows it anyway and records nothing.
  const ls = fakeStorage();
  assert.deepEqual(launchDecision({ env: { ...plainEnv, demo: true, preview: true }, ls }), { show: true, record: null, why: 'preview' });
});

test('the phone app can force it (Debug only): shows, records nothing, even if seen', () => {
  const ls = fakeStorage({ [SEEN_KEY]: RELEASE_VERSION, 'hearth.prefs': '{}' });
  const prev = globalThis.window;
  globalThis.window = { location: { search: '' }, HearthHost: { native: true, whatsNew: 'preview' } };
  globalThis.window.top = globalThis.window.self = globalThis.window;
  try {
    const d = launchDecision({ ls, current: RELEASE_VERSION, hasHistory: true });
    assert.deepEqual(d, { show: true, record: null, why: 'preview' });
    globalThis.window.HearthHost.whatsNew = undefined;
    assert.equal(launchDecision({ ls, current: RELEASE_VERSION, hasHistory: true }).show, false, 'without the flag: already seen');
  } finally {
    globalThis.window = prev;
  }
  assert.equal(ls.getItem(SEEN_KEY), RELEASE_VERSION);
});

test('callouts go to their feature: known places only, the rest stay plain', () => {
  assert.equal(goFor({ go: 'scene-say' }), 'scene-say');
  assert.equal(goFor({ go: 'nowhere' }), null, 'unknown → plain card');
  assert.equal(goFor({}), null);
  for (const n of NOTES) for (const c of n.callouts) if ('go' in c) assert.ok(DESTINATIONS.includes(c.go), `${n.version}: "${c.title}" goes to a known place (${c.go})`);
  // 0.16.0: the three cards with a screen go there; "it moved" just happens.
  const by = Object.fromEntries(notesFor('0.16.0').callouts.map((c) => [c.title, goFor(c)]));
  assert.deepEqual(by, { 'Scenes, just say it': 'scene-say', 'A wake-up call that works': 'wake', 'Plot twist: it moved': null, 'Daylight mode': 'settings' });
  // app.js opens every destination.
  const app = read('web/app.js');
  const router = app.slice(app.indexOf('const whatsNewGo = {'), app.indexOf('const whatsNew = createWhatsNew'));
  for (const to of DESTINATIONS) assert.match(router, new RegExp(`['"]?${to}['"]?: \\(\\) =>`), `app.js routes ${to}`);
  assert.match(app, /onGo: \(to\) => whatsNewGo\[to\]/);
});

test('a card tap closes the sheet, then opens the place; the tour stays away', () => {
  // A tiny dialog stand-in: enough for open() → go() → close → onClose/onGo.
  const events = [];
  const fakeDialog = () => ({
    open: false, dataset: {}, listeners: {}, scrollTop: 0, innerHTML: '',
    setAttribute() {}, querySelector: () => null,
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
    showModal() { this.open = true; },
    close() { this.open = false; for (const f of this.listeners.close ?? []) f(); },
  });
  let dlg;
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => (dlg = fakeDialog()), body: { append() {} } };
  try {
    const wn = createWhatsNew({ track: (e, p) => events.push(['track', p.step, p.to]), onClose: ({ went }) => events.push(['close', went]), onGo: (to) => events.push(['go', to]), ls: fakeStorage() });
    wn.open('0.16.0', 'test');
    assert.match(dlg.innerHTML, /data-wn-go="scene-say"/);
    assert.match(dlg.innerHTML, /data-wn-go="wake"/);
    assert.match(dlg.innerHTML, /data-wn-go="settings"/);
    assert.equal((dlg.innerHTML.match(/data-wn-go=/g) ?? []).length, 3, '"it moved" has nowhere to go: plain');
    events.length = 0;
    assert.equal(wn.go('nowhere'), false, 'unknown place: nothing happens');
    assert.equal(dlg.open, true);
    assert.equal(wn.go('wake'), true);
    assert.equal(dlg.open, false);
    assert.deepEqual(events, [['track', 'go', 'wake'], ['track', 'close', 'wake'], ['close', 'wake'], ['go', 'wake']]);
    // Without onGo the cards are plain and go() does nothing.
    const plain = createWhatsNew({ ls: fakeStorage() });
    plain.open('0.16.0', 'test');
    assert.doesNotMatch(dlg.innerHTML, /data-wn-go=/);
    assert.equal(plain.go('wake'), false);
    // Closing with the button: no destination, so the tour may come.
    events.length = 0;
    const wn2 = createWhatsNew({ track: (e, p) => events.push(['track', p.step, p.to]), onClose: ({ went }) => events.push(['close', went]), onGo: (to) => events.push(['go', to]), ls: fakeStorage() });
    wn2.open('0.16.0', 'test');
    dlg.close();
    assert.deepEqual(events.slice(-2), [['track', 'close', ''], ['close', null]]);
  } finally {
    globalThis.document = prevDoc;
  }
});

test('notes exist for the current version, which is package.json’s', () => {
  assert.equal(RELEASE_VERSION, pkg.version);
  const n = notesFor(pkg.version);
  assert.ok(n, `web/whatsnew-notes.js has no entry for ${pkg.version}`);
  assert.equal(NOTES[0].version, pkg.version, 'newest first');
  assert.ok(n.headline && n.dek && n.kicker);
  assert.ok(n.callouts.length >= 2 && n.callouts.length <= 4, '2-4 callouts');
  const shapes = [...read('web/shapes.js').matchAll(/'(hearth-[a-z]+)':/g)].map((m) => m[1]);
  for (const c of n.callouts) {
    assert.ok(shapes.includes(c.art), `${c.art} is one of Hearth's shapes`);
    assert.ok(c.title.split(/\s+/).length <= 5, `"${c.title}" is a few words`);
    assert.ok(c.line.length <= 90, `"${c.line}" is one short line`);
  }
  assert.ok(n.notes.length >= n.callouts.length);
  const text = storeText(pkg.version);
  assert.ok(text.length > 0 && text.length <= 4000, 'fits App Store "What\'s New"');
  assert.match(text, new RegExp(n.headline));
});

test('the copy stays original: no franchises, awards, leagues or streaming brands', () => {
  const banned = /\b(oscars?|emmys?|grammys?|golden globes?|super bowl|nfl|nba|mlb|world series|marvel|disney|star wars|pixar|netflix|hulu|hbo|prime video|peacock|espn|youtube|harry potter|jedi|avengers|batman|superman|friends|seinfeld|stranger things|the office)\b/i;
  for (const n of NOTES) {
    const all = [n.kicker, n.headline, n.dek, ...n.callouts.flatMap((c) => [c.title, c.line]), ...n.notes].join('\n');
    assert.doesNotMatch(all, banned, `notes for ${n.version}`);
    assert.doesNotMatch(all, /[™®©]/);
  }
});

test('wired into the app: imported first, styled, and reachable from Settings', () => {
  const app = read('web/app.js');
  assert.match(app.split('\n').find((l) => l.startsWith('import ')), /whatsnew\.js/, 'imported before anything can write storage');
  assert.match(read('web/index.html'), /href="whatsnew\.css"/);
  assert.match(read('web/index.html'), /data-action="whatsnew"/);
  assert.match(app, /case 'whatsnew'/);
});
