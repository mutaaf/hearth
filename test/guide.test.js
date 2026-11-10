// The public guide at /hearth/guide/: real text in the HTML (no JS needed), linked from the site.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// build-site.mjs copies site/ into dist/hearth/ as is, so site/guide/ is what /hearth/guide/ serves.
// (Reading site/ rather than building avoids racing demo-ads.test.js, which rebuilds dist/.)
test('the guide has its text, title and canonical in the HTML', () => {
  assert.match(readFileSync(path.join(ROOT, 'scripts', 'build-site.mjs'), 'utf8'), /cpSync\(path\.join\(ROOT, 'site'\), OUT/);
  const html = readFileSync(path.join(ROOT, 'site', 'guide', 'index.html'), 'utf8');
  const title = html.match(/<title>([^<]+)<\/title>/)[1];
  assert.ok(title.length < 65, title);
  const desc = html.match(/<meta name="description" content="([^"]+)"/)[1];
  assert.ok(desc.length >= 70 && desc.length <= 160, String(desc.length));
  assert.match(html, /<link rel="canonical" href="https:\/\/mutaafaziz\.com\/hearth\/guide\/">/);
  assert.match(html, /<h1>Hearth Guide: Set Up One Remote for Every TV<\/h1>/);
  assert.doesNotMatch(html, /<script/i, 'no scripts on the guide');
  assert.doesNotMatch(html, /ads\.js/, 'no ads on the guide');
  assert.doesNotMatch(html, /—|&mdash;/);
  const words = html.replace(/<style[\s\S]*?<\/style>/, '').replace(/<head>[\s\S]*?<\/head>/, '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean);
  assert.ok(words.length >= 900, `${words.length} words`);
});

test('the landing, support and privacy pages link the guide', () => {
  for (const f of ['index.html', 'support/index.html', 'privacy/index.html']) {
    assert.match(readFileSync(path.join(ROOT, 'site', f), 'utf8'), /href="(\.\.\/)?guide\/"/, f);
  }
});
