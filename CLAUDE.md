# Hearth: agent and contributor guide

Universal remote for the house's smart TVs. A Node server on the LAN discovers TVs, holds a live connection per TV, and serves a phone-first web remote. Zero build step, a handful of small runtime dependencies (lgtv2, ws, multicast-dns, aurora-field, qrcode-terminal).

Brands: LG webOS, Samsung Tizen (2016+), Roku (ECP), Google TV / Android TV (Cast).

## Run it

- `npm run up`: idempotent bootstrap (Node check → install → start detached → health → URL + QR). `npm run down` stops it.
- `npm test`: node:test suite with no TV or network needed (fake drivers, a fake Samsung websocket TV, a fake LG PIN-pairing TV, a fake Roku ECP server).
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
src/discovery.js       SSDP (LG UPnP XML / Samsung REST :8001 / Roku roku:ecp) + mDNS (Google TV)
                       → one list; probe(ip) for add-by-IP; macFor(ip) via the OS ARP table
src/mdns.js            minimal mDNS browse (multicast-dns): PTR → SRV/TXT → A
src/proto.js           just-enough protobuf (varints + length-delimited) for Cast
src/drivers/base.js    the driver contract (start/stop/pair/key/power/apps/launch/inputs/toast)
src/drivers/lg.js      webOS via lgtv2 (SSAP over wss:3001 → ws:3000), plus in-house PIN pairing
src/drivers/samsung.js Tizen via samsung.remote.control: wss:8002 + token (2018+) or ws:8001 (2016-17)
src/drivers/roku.js    Roku ECP over HTTP :8060 (no pairing; keydown/keyup for real holds)
src/drivers/googletv.js Google TV / Android TV via Cast (TLS :8009): volume, mute, apps, status
src/keys.js            unified key names → brand key codes
src/wol.js             Wake-on-LAN magic packet
web/                   vanilla JS app (index.html, style.css, app.js, shapes.js), no framework
web/feel.js            haptics (Vibration API / iOS switch trick), WebAudio sounds, the press engine
                       (data-press="down|up|repeat|long|confirm"), the gesture D-pad, wake lock
web/setup.js           the caveman setup wizard (turn on → find → [wake] → connect per brand → room → done)
web/skin-8bit.css      8-bit pocket-console skin (only under <html data-skin="8bit">)
web/demo.js            pretend TVs for the public demo only
site/                  landing page for mutaafaziz.com/hearth
scripts/build-site.mjs builds dist/ for the Worker (wrangler.jsonc)
```

## Adding a brand

1. `src/drivers/<brand>.js` extends `Driver`; set `static brand` and `capabilities`.
2. Add key codes for the brand in `src/keys.js`, or keep a private map in the driver (Roku does).
3. Register it in `DRIVERS` in `src/hub.js` and teach `discovery.js` to identify it.
4. Add a test with a fake device (see `test/samsung.test.js`).

The UI adapts from `capabilities` (`volumeLevel`, `inputs`, `toast`, `appIcons`); no UI change is needed for a new brand.

## Pairing, per brand

- **LG:** `pair()` = Allow prompt (lgtv2, PROMPT). `pair({ mode: 'pin' })` → `{ needsPin }` (the TV shows a number), then `pair({ pin })` finishes. The API passes `{ mode, pin }` through `POST /api/tvs/:id/pair`.
- **Samsung:** 2018+ asks Allow and returns a token; 2016-17 connects with no prompt and no token → credentials `{ legacy: true }`.
- **Roku:** `{ ecp: true }` after device-info answers. A 403 means "Control by mobile apps" blocks network access.
- **Google TV:** `{ cast: true }` after a RECEIVER_STATUS arrives. No code. The optional full remote (Google's remote protocol v2, ports 6466/6467, needs the on-screen code) is roadmap.
- Unpaired TVs get a reachability watch (TCP connect to the brand's control port every 10 s), so the app knows on/off and offers Wake-on-LAN before pairing.

## Touch model (keep it consistent)

- Every pressable element declares `data-press`. Remote keys use `down` (fire instantly), volume/channel/seek use `repeat` (it speeds up), lists use `up` (scrolling never fires a tap), and OK/A/power/TV cards use `long`. Destructive or house-wide actions use `confirm` (hold about 0.75 s while a bar fills).
- A long OK is sent as `{ key: 'ok', hold: ms }`. Samsung (Press/Release) and Roku (keydown/keyup) do a real hold; LG has no network hold, so it's a click. Google TV over Cast has no keys except volume/mute (other keys → 409 with an explanation).
- The D-pad is a gesture surface: tap a zone, hold to repeat, or drag to step every 34 px.
- Power: tap toggles this TV, hold turns every TV off. A long-press on a TV card opens its settings.
- Skins are pure CSS. The 8-bit LCD text comes from `renderLcd()`. `?skin=8bit|classic` overrides the saved preference, and `?embed=1` hides the demo banner.

## Connection doctor & codes (src/doctor.js, web/doctor.js)

- `runDoctor(hub, id, deps)` runs these steps in order:
  1. **network:** a TCP probe of the brand's ports, plus the ARP MAC.
  2. **wake:** WOL, then wait up to 25 s.
  3. **find:** `hub.scan()`, which self-heals moved TVs.
  4. **reconnect:** `driver.stop()`, then `start()`. Unpaired Roku and Google TV get a pair-less `hub.pair()`.
  5. **verify:** `driver.verify()`.
  6. **pair:** the advice for re-pairing.

  Each step is streamed as an SSE `doctor` event `{id, step, status, detail, nerd}`. All I/O (probe, macFor, wake, sleep, now) is injectable for tests.
- `driver.verify()` is a read-only check returning `{ ok, auth: 'ok'|'missing'|'rejected'|'prompt', how?, detail }`. It never sends a button.
  - **LG:** waits for connect, prompt or refused, then `getSystemInfo` and `getPowerState`.
  - **Samsung:** REST, then the ws channel up to `ms.channel.connect`. A 403 means rejected; a 408 means it's prompting.
  - **Roku:** device-info. A 403 means Network access is limited.
  - **Google TV:** Cast status, plus the remote handshake if it has been unlocked.
- `how` tells the UI which pairing step to open: `lg-pin`, `lg-allow`, `samsung-allow`, `googletv-code` or `roku-network-access`. Re-pairing calls `POST /api/tvs/:id/unpair` first, then `setup.open({ tvId, candidate, step, repair: true })`. With `repair`, the wizard skips "which room?".
- **Self-healing:** `hub.#heal()` runs on every scan. A known TV is matched by id, any shared MAC, or `macForFn(ip)` for MAC-less discoveries. It's then moved with `relocate()`, which rebuilds the driver, persists, and emits SSE `healed`. It never takes an IP another known TV holds.
- **Google TV full remote** (`src/drivers/googletv-remote.js`, Android TV Remote v2):
  - Pairing runs on TLS :6467 with varint-framed protobuf `PairingMessage`: request → option → configuration. The TV then shows a code.
  - `pair({mode:'code'})` returns `{needsCode}`; `pair({code})` sends `SHA256(client n ‖ client e ‖ server n ‖ server e ‖ code[1..2])`. If the code's first byte doesn't match the hash, that's a local 400 and nothing is sent.
  - The remote runs on TLS :6466 with the same client cert. It does configure (622) and set_active, answers every ping, and sends key_inject with SHORT, or START_LONG/END_LONG for holds.
  - Credentials `remoteCert`/`remoteKey` live in `tv.credentials`, which never reach the browser. Cast stays in charge of app launches and status.

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
| Samsung 2016-17 (e.g. KU6290) has no `TokenAuthSupport` in `:8001/api/v2/` and times out on wss:8002 | Use ws:8001. Those sets connect instantly with no Allow prompt and give no token, so credentials become `{ legacy: true }`. |
| Choosing the Samsung port while the TV is off would lock in a wrong guess | `#pickPort()` throws `offline()` when REST info is missing and decides on the next attempt; a failed connect clears the cached promise. |
| lgtv2 has no PIN pairing | `lg.js` does it in-house: register with `pairingType: 'PIN'` and lgtv2's signed manifest (read from its `pairing.json`), then `ssap://pairing/setPin`; `registered` carries the client-key. |
| Cast framing differs from the Android TV remote protocol | Cast: a 4-byte big-endian length, then protobuf CastMessage (2 source, 3 destination, 4 namespace, 6 JSON payload). Receiver volume reports `controlType: master`, so SET_VOLUME moves the TV's own volume. |
| mDNS is lossy; Google TVs sometimes miss a scan | `browse()` asks 3× over about 3 s and follows up A records for SRV targets without an address. |
| Nest Hubs answer `_googlecast` too | `googleTvsFrom()` keeps a cast device only if it also offers `_androidtvremote2` or its `md` says TV/Chromecast; Nest/Hub/speaker/display models are dropped. The model comes from the same IP's `_airplay` TXT (e.g. TCL 65A300W). |
| A Google TV's MAC isn't in the ARP table after mDNS alone | Make one unicast TCP contact (port 8009) before `macFor(ip)`. `Hub.add` also looks up a MAC when discovery had none. |
| iOS only plays the switch-haptic during user activation | pointerdown/touchstart aren't activation; pointerup/touchend/click are. `feel.js` queues the buzz and plays it on finger-up; buzzes during holds are dropped on iOS. |
| Roku active-app gives an id and a title | `<app id="12">Netflix</app>`: `state.app` = id (matches the app shelf) and `state.appTitle` = title (shown on cards). The home screen has no id. |
| A Roku stick reports `supports-wake-on-wlan: false` | It can't be woken over Wi-Fi when unpowered; `PowerOn` works from standby. |
| Wake-on-LAN sent to `x.y.z.255` never reached the LG on an eero mesh | eero hands out a /22 (192.168.4.0–7.255). `wol.js` computes the broadcast from the real netmask and also unicasts to the TV's IP on ports 9 and 7. The LG then woke in 3.6 s. |
| 2016-17 Samsungs answer REST and the websocket even in standby, with no PowerState | Hearth can't know if they're on: state `unknown` ("Ready"), and power acts as a toggle (WOL + KEY_POWER), like the TV's own remote. |
| Synthetic PointerEvents with an unknown pointerId make `setPointerCapture` throw | The pad wraps it in try/catch. Use `pointerId: 1` in browser tests. |
| `python3 -m http.server` lets Chrome cache JS/CSS heuristically; previews look stale | Re-fetch with `{cache:'reload'}`, or serve with `--directory dist` after each build (the build deletes dist). |
| Never use `ok`/`bad` as a state class | `.ok` is the D-pad's OK button (`position:absolute; inset:31%`), so `.dr-step.ok` or `.chip-result.ok` turn into floating circles. Prefix state classes (`st-ok`, `res-ok`). |
| Fields named `cert`/`key` on a class with a `key()` method | `Object.assign(this, { key })` shadows the method. AtvRemote stores `certPem`/`keyPem`. |
| A Google TV paired with a cert it later forgets drops the TLS handshake on :6466 | Surfaced as 401 "unlock again", with retries backed off to 60 s. The doctor reports `googletv-code`. |
| `tv` objects are live: `relocate()` mutates `tv.ip` | Capture `startIp` before scanning; comparing `hub.get(id).ip` with `tv.ip` is always equal. |
| `arp -n <ip>` spawned from Node sees "no entry" (and `netstat -rn` shows no LAN routes) on this Mac, while the same command in a shell works | Seen 2026-10-21; likely macOS Local Network privacy filtering what Node's child processes can read. `macFor()` then returns null: Google TVs added without a MAC can't be woken, and MAC-based self-healing falls back to id matching. Granting Node Local Network access (System Settings → Privacy & Security → Local Network) may fix it. Not reproducible in tests. |
| macOS has no `timeout` binary | Don't rely on it in scripts. |
| macOS Local Network privacy can silently block multicast for Terminal/Node | If a scan finds nothing on a Mac, check System Settings → Privacy & Security → Local Network. |

## Definition of done

Tests green (`npm test`), README updated for anything user-facing, a new nuance added to the table above whenever one bites.
