// Builds the public site for mutaafaziz.com/hearth into dist/hearth:
//   /hearth/        landing page (site/) with the aurora-field hero
//   /hearth/demo/   the real app (web/) driving pretend TVs (web/demo.js)
// The home server never uses this; it serves web/ directly.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist', 'hearth');
const DEMO = path.join(OUT, 'demo');

rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });
mkdirSync(path.join(DEMO, 'vendor'), { recursive: true });

cpSync(path.join(ROOT, 'site'), OUT, { recursive: true });
cpSync(path.join(ROOT, 'web'), DEMO, { recursive: true });
cpSync(
  path.join(ROOT, 'node_modules', 'aurora-field', 'dist', 'aurora-field.min.js'),
  path.join(DEMO, 'vendor', 'aurora-field.min.js'),
);
cpSync(path.join(ROOT, 'src', 'insight-schema.js'), path.join(DEMO, 'vendor', 'insight-schema.js'));

// demo.js must run before app.js reads window.HearthDemo.
const demoHtml = path.join(DEMO, 'index.html');
const html = readFileSync(demoHtml, 'utf8');
const anchor = '  <script src="vendor/aurora-field.min.js" defer></script>';
if (!html.includes(anchor)) throw new Error('web/index.html changed: update the demo.js injection in build-site.mjs');
writeFileSync(
  demoHtml,
  html
    .replace(anchor, `  <script src="demo.js"></script>\n${anchor}`)
    .replace('<title>Hearth</title>', '<title>Hearth demo</title>')
    .replace('<link rel="manifest" href="manifest.webmanifest">\n', ''),
);

// no-transform keeps Cloudflare from injecting analytics into the pages,
// which would contradict the "nothing leaves your home" promise.
writeFileSync(
  path.join(ROOT, 'dist', '_headers'),
  '/hearth/*\n  Cache-Control: no-transform, max-age=300\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n',
);
console.log('Built dist/hearth (landing + demo)');
