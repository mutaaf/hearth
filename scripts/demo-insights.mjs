// Box Office analytics (mutaafaziz.com/boxoffice) for the PUBLIC WEBSITE ONLY:
// the landing pages (site/, tagged in source) and, through this snippet, the
// demo and Light Racer copies in dist/. Hearth promises "nothing leaves your
// home", so the home server (web/ served by src/server.js) and the phone app
// (hearth-app bundles web/) must never load it. Same three locks as demo-ads.mjs:
//   1. Only scripts/build-site.mjs injects this, and only into dist/hearth/demo/
//      and dist/hearth/racer/. web/ never references the loader (test checks).
//   2. At runtime the snippet still checks the page is https://mutaafaziz.com/hearth/.
//   3. Never inside the phone app (window.HearthHost) or the landing page's
//      phone-frame embed (?embed=1), which the landing page already counts.
// The loader itself honours GPC/DNT, truncates IPs and masks inputs in replays.
export const LOADER = '/boxoffice/v1/insights.js';
export const TAG = `<script async src="${LOADER}"></script>`;

/** Must stay self-contained: its source is inlined into the page. */
export function insightsAllowed(loc, win) {
  if (!loc || loc.protocol !== 'https:' || loc.hostname !== 'mutaafaziz.com') return false;
  if (loc.pathname.indexOf('/hearth/') !== 0) return false;
  if (/[?&]embed=1/.test(loc.search || '')) return false;
  if (win && win.HearthHost) return false;
  return true;
}

/** The inline <script> build-site.mjs puts last in <body> of the demo and racer pages.
 *  On the demo it also counts remote presses: the key's fixed name (up, ok, mute…)
 *  and the button's fixed action (power, setup…), never anything typed or a TV's name. */
export function insightsSnippet() {
  return `  <!-- Box Office: anonymous analytics on the public website only, never at home. scripts/demo-insights.mjs -->
  <script>
  (function (allowed) {
    if (!allowed(location, window)) return;
    var bo = window.boxoffice = window.boxoffice || { q: [], track: function () { this.q.push([].slice.call(arguments)); } };
    if (window.HearthDemo) {
      document.addEventListener('click', function (e) {
        var b = e.target && e.target.closest && e.target.closest('[data-key],[data-action]');
        if (!b) return;
        var key = b.getAttribute('data-key'), action = b.getAttribute('data-action');
        if (key && /^[a-z0-9_-]{1,24}$/.test(key)) bo.track('demo_remote_press', { key: key });
        else if (action && /^[a-z0-9_-]{1,24}$/.test(action)) bo.track('demo_action', { action: action });
      }, true);
    }
    var s = document.createElement('script');
    s.async = true;
    s.src = ${JSON.stringify(LOADER)};
    document.body.appendChild(s);
  })(${insightsAllowed.toString()});
  </script>
`;
}
