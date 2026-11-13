#!/usr/bin/env node
// The landing page's iPhone Duo frames (site/duo/*.jpg): the real web app
// (the demo's pretend TVs) at the Duo's two screen sizes, with the closed
// screen's camera/status column as a right safe-area inset, as on the device.
//
//   npm run build:site && node scripts/duo-shots.mjs [base]   (base: a server for dist/, default :8134)
//
// Needs Playwright's Chromium (any checkout that has `playwright`): PLAYWRIGHT=<path to playwright pkg>.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT ?? 'playwright');
const base = process.argv[2] ?? 'http://127.0.0.1:8134';
const OUT = new URL('../site/duo/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// Measured on the Xcode 27.2 iPhone Duo simulator (hearth-app, 2026-11-10; cold-gas docs/NATIVE.md).
const SHOTS = [
  { name: 'closed-remote', w: 466, h: 678, insets: { right: 84, top: 0, bottom: 0, left: 0 }, hash: '#/tv/demo-living' },
  { name: 'closed-house', w: 466, h: 678, insets: { right: 84, top: 0, bottom: 0, left: 0 }, hash: '' },
  { name: 'open-house', w: 951, h: 669, insets: { top: 24, right: 0, bottom: 20, left: 0 }, hash: '' },
];

const browser = await chromium.launch();
for (const s of SHOTS) {
  const ctx = await browser.newContext({ viewport: { width: s.w, height: s.h }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  await ctx.addInitScript(() => {
    localStorage.setItem('hearth.tour.seen', JSON.stringify({ house: 1, remote: 1 }));
    localStorage.setItem('hearth.prefs', JSON.stringify({ skin: 'aurora', mode: 'dark' }));
    localStorage.setItem('hearth.whatsnew', JSON.stringify('99.0.0'));
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: s.insets }).catch((e) => console.warn('insets:', e.message));
  await page.goto(`${base}/hearth/demo/?embed=1${s.hash}`, { waitUntil: 'load' });
  await page.waitForTimeout(5500); // the CRT power-on, the TVs saying hello, aurora shapes forming
  await page.evaluate(() => document.querySelectorAll('.note, .tour, .tour-veil').forEach((e) => e.remove()));
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 86 });
  const file = path.join(OUT, `${s.name}.jpg`);
  (await import('node:fs')).writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('wrote', file);
  await ctx.close();
}
await browser.close();
