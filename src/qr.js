import { createRequire } from 'node:module';

// QR codes as SVG, using the encoder that ships inside qrcode-terminal (no
// extra dependency). Used for "scan this to get Hearth on your iPad".
const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode/index.js');
const Level = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js');

export function qrSvg(text, { dark = '#07080c', light = '#ffffff', margin = 2 } = {}) {
  const qr = new QRCode(-1, Level.M);
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
