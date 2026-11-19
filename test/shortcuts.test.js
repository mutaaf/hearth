import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { guideHtml, shortcutsAvailable } from '../web/shortcuts.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the Shortcuts guide only shows in the iPhone app that offers it', () => {
  assert.equal(shortcutsAvailable({}), false); // home server
  assert.equal(shortcutsAvailable({ HearthHost: { native: true } }), false); // an app without the intents
  assert.equal(shortcutsAvailable({ HearthHost: { native: true, shortcuts: true }, HearthDemo: {} }), false); // demo
  assert.equal(shortcutsAvailable({ HearthHost: { shortcuts: true } }), false);
  assert.equal(shortcutsAvailable({ HearthHost: { native: true, shortcuts: true } }), true);
});

test('the guide names the scene, escaped, in three steps', () => {
  const html = guideHtml({ name: 'Movie <night>', saved: true });
  assert.match(html, /Run “Movie &lt;night&gt;” by itself/);
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
  assert.match(html, /Run Hearth scene/); // the action's title in hearth-app (HearthShortcuts.swift)
  assert.match(html, /data-sc="go"/);
  assert.doesNotMatch(html, /Save this scene first/);
  assert.match(guideHtml({ name: '', saved: false }), /Save this scene first/);
  assert.match(guideHtml({ name: 'x', scheduled: true }), /Turn off “Run on a schedule”/);
});

test('the scene editor offers it only through shortcutsAvailable()', () => {
  const src = read('web/scenes.js');
  assert.match(src, /shortcutsAvailable\(\) \?/);
  assert.match(read('web/index.html'), /id="shortcutsSheet"/);
  // Never anything the public site loads by itself.
  assert.doesNotMatch(read('web/shortcuts.js'), /https?:\/\//);
});
