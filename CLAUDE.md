# Hearth: agent and contributor guide

Universal remote for the house's smart TVs. A Node server on the LAN discovers TVs, holds a live connection per TV, and serves a phone-first web remote. Zero build step, three runtime dependencies.

## Run it

- `npm run up`: idempotent bootstrap (Node check → install → start detached → health → URL + QR). `npm run down` stops it.
- `npm test`: node:test suite with no TV or network needed (fake drivers + a fake Samsung websocket TV).
- Dev loop: `npm start` in the foreground, edit `web/*`, reload the browser. Server changes need a restart.
- To experiment without touching your real setup: `HEARTH_HOME=/tmp/h HEARTH_PORT=8771 npm start`.

## The public site (mutaafaziz.com/hearth)

- `site/` is the landing page. Its aurora-field hero (the user's own npm lib) builds Hearth's shapes from `web/shapes.js`.
- `/hearth/demo/` is the real `web/` app with `web/demo.js` injected, which stands in pretend TVs for the server. App code reads `window.HearthDemo`; keep that seam when changing `api()` or events.
- `npm run build:site` → `dist/`. `npm run deploy:site` builds, then runs `wrangler deploy` to the Worker `hearth` on the route `mutaafaziz.com/hearth*`. Assets only, no Worker code.
- `dist/_headers` sets `Cache-Control: no-transform` so Cloudflare's zone analytics isn't injected, which keeps the "nothing leaves your home" promise.
- Web assets use **relative** paths so the same files work at `/` at home and at `/hearth/demo/`.
- URLs the launchers may deep-link to: `/hearth/` and `/hearth/demo/`. There are no query parameters.

## Layout

```
bin/hearth.js          CLI: `serve` (default) and `scan`
scripts/up.mjs|down    one-command env (see feedback: one idempotent `npm run up`)
src/server.js          node:http JSON API + SSE (/api/events) + static web/ + icon proxy
src/hub.js             owns TVs + one driver per TV; emits 'change' → SSE
src/store.js           ~/.hearth/tvs.json (0600, queued atomic writes)
src/discovery.js       SSDP M-SEARCH → identify (LG UPnP XML / Samsung REST :8001); probe(ip)
src/drivers/base.js    the driver contract (start/stop/pair/key/power/apps/launch/inputs/toast)
src/drivers/lg.js      webOS via lgtv2 (SSAP over wss:3001 → ws:3000 fallback)
src/drivers/samsung.js Tizen via samsung.remote.control websocket on wss:8002
src/keys.js            unified key names → brand key codes
src/wol.js             Wake-on-LAN magic packet
web/                   vanilla JS app (index.html, style.css, app.js, shapes.js), no framework
web/feel.js            haptics (Vibration API / iOS switch trick), WebAudio sounds, the press engine
                       (data-press="down|up|repeat|long|confirm"), the gesture D-pad, wake lock
web/setup.js           the caveman setup wizard (turn on → find → Allow → room → done)
web/skin-8bit.css      8-bit pocket-console skin (only under <html data-skin="8bit">)
web/demo.js            pretend TVs for the public demo only
site/                  landing page for mutaafaziz.com/hearth
scripts/build-site.mjs builds dist/ for the Worker (wrangler.jsonc)
```

## Adding a brand

1. `src/drivers/<brand>.js` extends `Driver`; set `static brand` and `capabilities`.
2. Add key codes for the brand in `src/keys.js`.
3. Register it in `DRIVERS` in `src/hub.js` and teach `discovery.js` to identify it.
4. Add a test with a fake device (see `test/samsung.test.js`).

The UI adapts from `capabilities` (`volumeLevel`, `inputs`, `toast`, `appIcons`); no UI change is needed for a new brand.

## Touch model (keep it consistent)

- Every pressable element declares `data-press`. Remote keys use `down` (fire instantly), volume/channel/seek use `repeat` (it speeds up), lists use `up` (scrolling never fires a tap), and OK/A/power/TV cards use `long`. Destructive or house-wide actions use `confirm` (hold about 0.75 s while a bar fills).
- A long OK is sent as `{ key: 'ok', hold: ms }`. Samsung turns it into a real Press/Release; LG has no network hold, so it's a click.
- The D-pad is a gesture surface: tap a zone, hold to repeat, or drag to step every 34 px.
- Power: tap toggles this TV, hold turns every TV off. A long-press on a TV card opens its settings.
- Skins are pure CSS. The 8-bit LCD text comes from `renderLcd()`. `?skin=8bit|classic` overrides the saved preference, and `?embed=1` hides the demo banner.

## Invariants

- Pairing keys never leave the server: `Hub.view()` is the only shape sent to clients. A test enforces this.
- Mutating API calls must be `application/json` (blocks cross-site form POSTs). Keep it that way.
- The icon proxy only fetches from the TV's own IP.
- Drivers throw `HearthError` with a status (`unsupported()` → 501, `offline()` → 503), never HTTP-aware code.
- Unpaired TVs are never connected to automatically, because connecting pops a prompt on the TV.

## Environment nuances

| Nuance | Why it matters |
|---|---|
| `node --test test/` fails on Node 25 ("Cannot find module …/test") | Directory args were dropped; the script uses the glob `"test/*.test.js"`. |
| LG exposes ~6 UPnP descriptions with junk model fields (`1.0`, `WEBOS`, `6.5.3`, `LG Smart TV`) | `isModelCode()` filters them; only the `urn:lge:device:tv:1` description carries wired+Wi-Fi MACs, so it is searched for explicitly. |
| SSDP answers are lossy; a single M-SEARCH sometimes misses the tv:1 service | Discovery sends each search twice. After pairing, the LG driver backfills model (`getSystemInfo`) and MACs (`connectionmanager/getinfo`). |
| lgtv2 reads `~/.lgtv2/keyfile-<host>` when `clientKey` is undefined | The driver passes `clientKey: ''` and a `keyFile` under `HEARTH_HOME` so nothing leaks between tools. |
| LG firmware from 2023 on only accepts `wss://:3001` with a self-signed cert | lgtv2 tries wss first and falls back to ws; app icons may be https on the TV, hence the server-side icon proxy. |
| Two saves in the same tick raced on one temp file (ENOENT on rename) | `Store.save` is queued; `Hub.pair` awaits a save so the key is on disk before success is reported. |
| Headless Chrome `--screenshot` hangs with `--virtual-time-budget` | The SSE stream keeps the network busy forever. Use `--timeout` and kill the process; window widths under ~500px are clamped. |
| aurora-field sizes its canvas from the container, not the canvas's own CSS box | Position the shape with the `stage` option (an invisible box), never by moving the canvas. |
| Headless SwiftShader screenshots catch aurora particles mid-flight (looks like stars only) | Verify the hero in real Chrome; shapes take about 2.6 s of intro before they form. |
| The first SSDP M-SEARCH from a freshly started process (seen under launchd) often gets no answers | `discover()` re-asks once when nobody answered. The hub also re-scans every 60 s (`startAutoDiscovery`) and pushes `nearby` over SSE. |
| A launchd plist pointing at `/opt/homebrew/Cellar/node/<ver>/bin/node` breaks on `brew upgrade` | Use `/opt/homebrew/opt/node/bin/node`. The home install (`~/hearth-home`, label `com.hearth.home`) does. |
| iOS Safari has no Vibration API | `feel.js` toggles a hidden `<input type=checkbox switch>`, which plays the system haptic on iOS 18+. It only works inside a user gesture, so repeat ticks during a hold may stay silent. |
| Chrome-extension `resize_window` may not shrink below the desktop layout | Verify phone layouts with DevTools-protocol screenshots (see the site agent's `shoot.cjs` approach) or on a real phone. |
| macOS has no `timeout` binary | Don't rely on it in scripts. |
| macOS Local Network privacy can silently block multicast for Terminal/Node | If a scan finds nothing on a Mac, check System Settings → Privacy & Security → Local Network. |

## Definition of done

Tests green (`npm test`), README updated for anything user-facing, a new nuance added to the table above whenever one bites.
