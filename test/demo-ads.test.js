// Ads run on the public demo only, never on a home server or in the phone app
// (owner's decision 2026-10-30; scripts/demo-ads.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { adsAllowed, demoAdsSnippet } from '../scripts/demo-ads.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const loc = (href) => { const u = new URL(href); return { protocol: u.protocol, hostname: u.hostname, pathname: u.pathname, search: u.search }; };

test('ads are allowed only at https://mutaafaziz.com/hearth/demo/', () => {
  assert.equal(adsAllowed(loc('https://mutaafaziz.com/hearth/demo/'), {}), true);
  assert.equal(adsAllowed(loc('https://mutaafaziz.com/hearth/demo/index.html?skin=8bit'), {}), true);
  for (const href of [
    'http://192.168.4.20:8770/',                    // the home server
    'http://hearth.local:8770/hearth/demo/',        // a home server with the demo path
    'http://localhost:8770/',
    'https://mutaafaziz.com/hearth/',               // the landing page
    'https://mutaafaziz.com/hearth/racer/',
    'https://mutaafaziz.com/hearth/demo/?embed=1',  // the landing page's phone frame
    'http://mutaafaziz.com/hearth/demo/',
    'https://mutaafaziz.com.evil.example/hearth/demo/',
    'capacitor://localhost/demo.html',              // the phone app's demo page
  ]) assert.equal(adsAllowed(loc(href), {}), false, href);
  // Inside the phone app, never, even at the public URL.
  assert.equal(adsAllowed(loc('https://mutaafaziz.com/hearth/demo/'), { HearthHost: {} }), false);
});

function runSnippet(href, win = {}) {
  const added = [];
  const el = () => ({ style: {}, setAttribute(k, v) { this[k] = v; } });
  const document = {
    createElement: (tag) => Object.assign(el(), { tag }),
    body: { appendChild: (n) => added.push(n) },
    head: { appendChild: (n) => added.push(n) },
  };
  const code = demoAdsSnippet().replace(/^[\s\S]*?<script>/, '').replace(/<\/script>[\s\S]*$/, '');
  vm.runInNewContext(code, { location: loc(href), window: win, document });
  return added;
}

test('the snippet loads the loader on the public demo and nothing elsewhere', () => {
  const on = runSnippet('https://mutaafaziz.com/hearth/demo/');
  const loader = on.find((n) => n.tag === 'script');
  assert.equal(loader.src, 'https://mutaafaziz.com/ads/v1/ads.js');
  assert.equal(loader['data-app'], 'hearth');
  assert.equal(loader['data-slots'], 'demo:banner:menu');
  assert.ok(on.find((n) => n['data-marquee'] === 'demo'));
  assert.deepEqual(runSnippet('http://192.168.4.20:8770/'), []);
  assert.deepEqual(runSnippet('https://mutaafaziz.com/hearth/demo/', { HearthHost: { native: true } }), []);
});

test('web/ (home server + phone app) never references the ad loader', () => {
  for (const f of readdirSync(path.join(ROOT, 'web'), { recursive: true })) {
    if (!/\.(html|js|css|webmanifest)$/.test(f)) continue;
    const s = readFileSync(path.join(ROOT, 'web', f), 'utf8');
    assert.ok(!/ads\/v1\/ads\.js|data-marquee|marquee\./.test(s), `web/${f} mentions the ad loader`);
  }
});

test('the site build injects ads into the demo page only', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-site.mjs')], { cwd: ROOT, stdio: 'pipe' });
  const demo = readFileSync(path.join(ROOT, 'dist', 'hearth', 'demo', 'index.html'), 'utf8');
  assert.equal(demo.split('ads/v1/ads.js').length - 1, 1);
  assert.ok(demo.indexOf('ads/v1/ads.js') > demo.indexOf('demo.js'));
  for (const f of ['index.html', 'racer/index.html', 'privacy/index.html']) {
    let s = '';
    try { s = readFileSync(path.join(ROOT, 'dist', 'hearth', f), 'utf8'); } catch { continue; }
    assert.ok(!s.includes('ads/v1/ads.js'), `dist/hearth/${f} must not load ads`);
  }
});
