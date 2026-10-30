// Marquee ads for the PUBLIC DEMO ONLY (owner's decision, 2026-10-30: monetize
// the collection). Hearth promises "nothing leaves your home", so the home
// server (web/ served by src/server.js) and the phone app (hearth-app bundles
// web/) must never load an ad. Three locks:
//   1. Only scripts/build-site.mjs injects this, and only into dist/hearth/demo/.
//      web/ never references the loader (test/demo-ads.test.js checks).
//   2. At runtime the snippet still checks the page is mutaafaziz.com/hearth/demo/,
//      so a copied dist/ on a LAN host loads nothing.
//   3. Never inside the phone app (window.HearthHost) or the landing page's
//      phone-frame embed (?embed=1).
export const ADS_HOST = 'mutaafaziz.com';
export const ADS_PATH = '/hearth/demo/';
export const LOADER = 'https://mutaafaziz.com/ads/v1/ads.js';
export const SLOTS = 'demo:banner:menu';

/** Must stay self-contained: its source is inlined into the demo page. */
export function adsAllowed(loc, win) {
  if (!loc || loc.protocol !== 'https:' || loc.hostname !== 'mutaafaziz.com') return false;
  if (loc.pathname.indexOf('/hearth/demo/') !== 0) return false;
  if (/[?&]embed=1/.test(loc.search || '')) return false;
  if (win && win.HearthHost) return false;
  return true;
}

/** The inline <script> build-site.mjs puts before </body> of the demo page. */
export function demoAdsSnippet() {
  return `  <!-- Marquee: ads on the public demo only (2026-10-30), never at home. scripts/demo-ads.mjs -->
  <script>
  (function (allowed) {
    if (!allowed(location, window)) return;
    var slot = document.createElement('aside');
    slot.className = 'demo-ad';
    slot.setAttribute('aria-label', 'Advertisement');
    slot.setAttribute('data-marquee', 'demo');
    slot.style.cssText = 'display:block;max-width:728px;min-height:90px;margin:32px auto calc(24px + env(safe-area-inset-bottom,0px));padding:0 16px;box-sizing:border-box';
    document.body.appendChild(slot);
    var s = document.createElement('script');
    s.async = true;
    s.src = ${JSON.stringify(LOADER)};
    s.setAttribute('data-app', 'hearth');
    s.setAttribute('data-slots', ${JSON.stringify(SLOTS)});
    document.head.appendChild(s);
  })(${adsAllowed.toString()});
  </script>
`;
}
