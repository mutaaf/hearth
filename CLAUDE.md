# Hearth: agent and contributor guide

Universal remote for the house's smart TVs. A Node server on the LAN discovers TVs, holds a live connection per TV, and serves a phone-first web remote. Zero build step, a handful of small runtime dependencies (lgtv2, ws, multicast-dns, aurora-field, qrcode-terminal).

Brands: LG webOS, Samsung Tizen (2016+), Roku (ECP), Google TV / Android TV (Cast), Apple TV (pyatv: Companion + AirPlay/MRP, via a Python bridge; or the pure-JS Companion client in src/atv/ where there's no Python, e.g. the phone app).

## Run it

- `npm run up`: idempotent bootstrap (Node check → install → Apple TV venv with pinned pyatv (optional) → start detached → health → URL + QR). `npm run down` stops it.
- `npm test`: node:test suite with no TV, network or Python needed (fake drivers, a fake Samsung TV (websocket + REST apps + UPnP SOAP), a fake LG PIN-pairing TV, a fake Roku ECP server, a fake Cast TV over TLS, a fake pyatv bridge and bridge process, and a fake Apple TV Companion server that does real SRP pair-setup, pair-verify and the encrypted session).
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
src/discovery.js       SSDP (LG UPnP XML / Samsung REST :8001 / Roku roku:ecp) + mDNS (Google TV;
                       Apple TV via _companion-link/_airplay, AppleTV* models only)
                       → one list; probe(ip) for add-by-IP (Apple TV: AirPlay :7000/info); macFor(ip) via ARP
src/mdns.js            minimal mDNS browse (multicast-dns): PTR → SRV/TXT → A
src/proto.js           just-enough protobuf (varints + length-delimited) for Cast
src/drivers/base.js    the driver contract (start/stop/pair/key/power/apps/launch/inputs/toast)
src/drivers/lg.js      webOS via lgtv2 (SSAP over wss:3001 → ws:3000), plus in-house PIN pairing
src/drivers/samsung.js Tizen: keys/launch over samsung.remote.control (wss:8002 + token 2018+, ws:8001 2016-17);
                       state from REST :8001 (visible app per id) + UPnP :9197 (volume/mute) + :9119 (screen on)
src/drivers/roku.js    Roku ECP over HTTP :8060 (no pairing; keydown/keyup for real holds)
src/drivers/googletv.js Google TV / Android TV via Cast (TLS :8009): volume, mute, apps (GET_APP_AVAILABILITY),
                       status incl. isStandBy; drops a socket that goes quiet
src/drivers/appletv.js Apple TV: one driver over either transport (pyatv bridge or src/atv/transport.js, same ops
                       and events; atvMode() in atv-bridge.js picks); PIN pairing, pushed state
src/drivers/appletv-bridge.py  the Python side: ONE process for every Apple TV, JSON lines on stdio
src/atv-bridge.js      spawns/owns that process (lazy start, restart with backoff, 'restart' → drivers
                       reconnect); venv path + pinned PYATV_VERSION shared with scripts/up.mjs; atvMode()
src/atv/               pure-JS Apple TV Companion (no Python, runs in Hermes): opack.js (OPACK), tlv8.js, srp.js
                       (SRP-6a 3072/SHA-512), hap.js (pair-setup/verify, credentials, session cipher; @noble crypto),
                       link.js (frames + encryption + _x requests), companion.js (handshake, HID, apps, launch, power),
                       transport.js (the bridge-shaped ops, Companion port probing)
src/catalog.js         the cross-brand app catalog (20 streaming apps × per-brand id arrays + sources) and
                       resolveApp(): id → exact title → fuzzy (never YouTube for YouTube TV)
src/launch.js          POST /api/launch: wake → resolve per TV → launch in parallel → per-TV results; also
                       the `launch` action for bulk/scenes and GET /api/catalog/status
src/upnp.js            just-enough UPnP SOAP (Samsung RenderingControl)
src/bill-schema.js     the power bill: chargeLines() privacy filter, prompt/schema, validateBill(); shared by
                       web (vendor/bill-schema.js), hub and Worker (POST /hearth/api/bill)
src/energy.js          watts estimate from the model code, ~/.hearth/energy.json (price, bill numbers, watts),
                       report() = telemetry hours on × watts × price; web/energy.js|.css draws it
src/devices.js         the device knowledge base: deviceGuide({brand, model, firmware}) → family/year, how it connects,
                       settings to switch on first, keep-it-reachable menu paths, fixes per symptom (by model year)
src/device-schema.js   AI connection guides + the support queue: what may leave the house (sanitizeDevice/Symptom/
                       Support, scrub), the guide schema/prompt/validateGuide; shared by the Worker and the hub
src/keys.js            unified key names → brand key codes
src/wol.js             Wake-on-LAN magic packet
src/jsonfile.js        crash-safe JSON files (fsync, .bak, corrupt → aside) + a save queue
src/backoff.js         shared reconnect pacing (exponential, jitter, healthy-reset)
src/guard.js           Host/Origin allowlist (DNS rebinding), forbidden TV addresses, rate limiter
src/log.js             timestamped log lines + copy-truncate rotation of ~/.hearth/hearth.log
web/                   vanilla JS app (index.html, style.css, app.js, shapes.js), no framework
web/feel.js            haptics (Vibration API / iOS switch trick), WebAudio sounds, the press engine
                       (data-press="down|up|repeat|long|confirm"), the gesture D-pad, wake lock
web/setup.js           the caveman setup wizard (looks at once and keeps looking → [wake] → connect per brand → room → done)
web/tour.js|.css       the tour: spotlight + bubble + an animated finger per feature; first visit to the house and
                       the remote, "?" in both headers, Settings → Show me around (localStorage hearth.tour.seen)
web/icons.js           app icons, best first: the TV's own icon for that app (Roku/LG list them; home server proxies
                       api/tvs/:id/icon, the phone app gets GET /api/tvs/:id/icon-data), then web/brand-icons.js
                       (Simple Icons, CC0, `node scripts/brand-icons.mjs`; Prime Video, Disney+, Hulu, Peacock, ESPN,
                       Pluto TV and Sling aren't there at their owners' request), then a letter tile
web/guide.js|.css      "we know your TV": the model's guide in setup (pairing screen), after a failed pair or doctor
                       run, and from TV settings; "Ask the AI"; "Still stuck? Send it to us" → POST /api/support;
                       checks its tickets every 6 h and says when one is `supported`
web/skin-8bit.css      8-bit pocket-console skin (only under <html data-skin="8bit">)
web/launcher.js|.css   the app launcher: "Watch" strip on the house (hold = every / selected TVs) and the
                       "Streaming" grid on a TV's Apps panel (tap = this TV), ✓/✕ chips per TV
web/away.js|.css       away mode: SSE error → probes api/health; 3 misses → Light Racer in a frame (racer/?away=1);
                       postMessage {hearth:'home'|'back'|'retry'}; keepOffline() registers web/sw.js on secure origins
web/playback.js        shared: state.media parsers (Roku media-player, LG media pipeline, Apple TV) + phaseOf()
                       (TV signal → this phone's last keys → time) → playback | browse | other
web/stream.js|.css     the Stream Center ("Watch" mode): tap surface = play/pause, sides/swipes = skip, hold = scrub,
                       live progress; modes.js auto-switches to it when phaseOf() says playback
web/racer/             Light Racer (canvas game + aurora-field sky), own manifest + sw.js; public at /hearth/racer/
web/demo.js            pretend TVs for the public demo only (has a slice of the catalog)
site/                  landing page for mutaafaziz.com/hearth
scripts/build-site.mjs builds dist/ for the Worker (wrangler.jsonc)
```

## Adding a brand

1. `src/drivers/<brand>.js` extends `Driver`; set `static brand` and `capabilities`.
2. Add key codes for the brand in `src/keys.js`, or keep a private map in the driver (Roku does).
3. Register it in `DRIVERS` in `src/hub.js` and teach `discovery.js` to identify it.
4. Add a test with a fake device (see `test/samsung.test.js`; for a bridged brand, `test/appletv.test.js`).
5. Brand-aware spots outside the driver: `REACH_PORTS`/`BRAND_NAMES` in hub.js, `KNOWN_PORTS`/`CONTROL_PORT`/`brandInfo` in diagnostics.js, `WAKE_FIX`/`PRIVACY_FIX`/`controls()` in health.js, `BRANDS` in web/app.js, `brandName`/`startPair` in web/setup.js, and web/demo.js.

The UI adapts from `capabilities` (`volumeLevel`, `inputs`, `toast`, `appIcons`, `pointer`, `keyboard`); no UI change is needed for a new brand. Cards carry `data-brand`, so a brand can get its own look in CSS (Apple TV: a glossy puck and a cool glow in each skin).

## Pairing, per brand

- **LG:** `pair()` = Allow prompt (lgtv2, PROMPT). `pair({ mode: 'pin' })` → `{ needsPin }` (the TV shows a number), then `pair({ pin })` finishes. The API passes `{ mode, pin }` through `POST /api/tvs/:id/pair`.
- **Samsung:** 2018+ asks Allow and returns a token; 2016-17 connects with no prompt and no token → credentials `{ legacy: true }`.
- **Roku:** `{ ecp: true }` after device-info answers. A 403 means "Control by mobile apps" blocks network access.
- **Apple TV:** two codes, one protocol at a time, through the same `{ mode: 'pin' }` / `{ pin }` API as LG. `pair({ mode: 'pin' })` asks the bridge which protocols need pairing (`info`), begins the first → `{ needsPin, step: 1, steps: 2, label }` (the TV shows 4 digits). `pair({ pin })` finishes it, saves `credentials.companion` (remote works from here), and begins AirPlay → `{ needsPin, step: 2 }`. The second `pair({ pin })` saves `credentials.airplay` (MRP: now playing). `Hub.pair` passes `step/steps/label` through; the wizard shows "Step n of 2". A wrong/expired code → 401 "Show the number again" (the bridge drops the session; asking again shows a new code). If AirPlay can't start, Companion-only still works. Pairing name on the TV: "Hearth".
- **Apple TV without Python (JS transport):** `info` reports only Companion, so it's `{ needsPin, step: 1, steps: 1 }` and done after one code. The credential is pyatv's own string (`ltpk:ltsk:atvId:clientId`, hex), so it moves between the two transports. The Companion port is saved as `tv.atvPort` (not a secret, never in `view()`).
- **Google TV:** `{ cast: true }` after a RECEIVER_STATUS arrives. No code. The optional full remote (Google's remote protocol v2, ports 6466/6467, needs the on-screen code) is roadmap.
- Unpaired TVs get a reachability watch (TCP connect to the brand's control port every 10 s), so the app knows on/off and offers Wake-on-LAN before pairing.

## Touch model (keep it consistent)

- Every pressable element declares `data-press`. Remote keys use `down` (fire instantly), volume/channel/seek use `repeat` (it speeds up), lists use `up` (scrolling never fires a tap), and OK/A/power/TV cards use `long`. Destructive or house-wide actions use `confirm` (hold about 0.75 s while a bar fills).
- A long OK is sent as `{ key: 'ok', hold: ms }`. Samsung (Press/Release) and Roku (keydown/keyup) do a real hold; LG has no network hold, so it's a click. Google TV over Cast has no keys except volume/mute (other keys → 409 with an explanation). Apple TV holds use pyatv `InputAction.Hold` (~1 s) for arrows/OK/back/home; a held Home is Control Center. Apple TV play/pause sends the toggle unless the pushed `state.playing` says it's already in the asked state; mute/source → 501.
- The D-pad is a gesture surface: tap a zone, hold to repeat, or drag to step every 34 px.
- Power: tap toggles this TV, hold turns every TV off. A long-press on a TV card opens its settings.
- Skins are pure CSS. Light/dark is `prefs.mode` ('light' default | 'dark' | 'auto') → `<html data-mode>` (feel.js `applySkin()`, which also fires `hearth:mode` for the native app). Aurora's daylight look is `skin-aurora-light.css` (`[data-skin="aurora"][data-mode="light"]`); Classic's dark is `[data-mode="dark"]`, not the phone's media query. The 8-bit LCD text comes from `renderLcd()`. `?skin=8bit|classic` overrides the saved preference, and `?embed=1` hides the demo banner.

## Live state must match the TV

The app only ever shows what the TV last said; nothing optimistic sticks.

- **After every command** (key, power, volume, launch, input, bulk) `Hub.settle(id)` calls `driver.refresh()` ~0.7 s and ~2.5 s later. Drivers with no `refresh()` rely on their own push/poll.
- **Pollers speed up while someone looks:** the server reports SSE clients to `Hub.setViewers()`, which calls `driver.setActive(bool)`. Samsung polls every 3 s with the app open, 15 s idle.
- **Samsung:** `state.app` = the app whose REST `/api/v2/applications/<id>` says `visible: true` (last-seen app first, then catalog ids, then the installed list; a few per poll in batches of 4, ids that 404 are skipped for an hour). `appTitle` is its REST name. Volume/mute from UPnP RenderingControl (`capabilities.volumeLevel` turns true once it answers); mute uses SetMute, not a blind toggle. Power: 2018+ `PowerState`; 2016-17 → an app visible or `:9119` open = `on`, `:9119` closed = `standby`, unreachable = `off` (see the nuance below). After Hearth sends power-off it reports `standby` for 15 s.
- **LG:** subscriptions push power/app/volume; `refresh()` re-reads them. Any non-`on` power clears `app`/`inputLabel`.
- **Roku:** 5 s poll. Standby and the home screen (`<app>Roku</app>` or *Roku Dynamic Menu*, id 562859) mean `app: null`.
- **Google TV:** `RECEIVER_STATUS.isStandBy` → `power: 'standby'`, `app: null`. No message for 20 s (5 s heartbeats) → the socket is dropped and the TV shows off until Cast answers again.
- **Web:** `.current` app, "now playing" and LEDs all read `state`. Play/pause shows a state only when the TV reports one (Apple TV `state.playing`).

## The app launcher (catalog)

- `src/catalog.js` lists apps as `{ key, title, aliases?, mark, color, ids: { samsung, lg, roku, androidtv, appletv }, note? }`. ids are arrays, newest first; each has a source comment ("seen" = read off this house's TVs).
- Resolution per TV (`resolveApp`): the first catalog id in the TV's installed list (`Hub.apps()`, cached 10 min) → exact title/alias → fuzzy: an installed app belongs to the catalog entry whose name is its longest whole-word prefix, so "YouTube TV" can never satisfy "YouTube" and vice versa. A TV that can't list apps gets the first catalog id blind. Free titles (scenes: "Pandora") use `matchTitle`, same rule.
- Google TV opens only apps with a Cast receiver; entries with `androidtv: []` carry a `note` and resolve to reason `unsupported`.
- One vocabulary everywhere: `POST /api/launch { app: 'youtubetv' | 'YouTube TV', tvs: 'all' | [ids], wake }`, bulk/scene action `launch` with `{ app }`, `{ title }` or `{ id }` (+ `wake`). Results: `{ id, name, ok, appId?, title?, via?, woke?, reason?, error? }`, reasons `not-installed`, `unsupported`, `off`, `offline`, `unpaired`, `failed`.
- `wake: true` powers on TVs that are off/asleep first and waits (25 s) for them; it never toggles a TV whose power is `unknown`. Rokus and Google TVs open apps from standby by themselves.

## Device guides, AI and the support queue

- `POST /api/guide { tvId | device, symptom?, ai? }` → `{ guide, ai, aiError? }`. The built-in guide (src/devices.js) answers at
  once; the AI (Worker `POST /hearth/api/device`, Gemma on Workers AI) is asked when the model isn't in the table, when
  something went wrong (`symptom`), or on "Ask the AI". `mergeGuide()` (src/routes.js): the built-in `connect.how` always
  wins (it's how the drivers really connect); the AI adds family/year/menus/fixes for that exact model.
- The Worker keeps one AI guide per brand + model + symptom for 30 days in D1 `device_guides`, shared by every house.
- `POST /api/support { tvId?, report }` → Worker `POST /hearth/api/support` → D1 `support` (id, status new → triaged →
  in-progress → supported | wont-fix | duplicate, resolution). The app polls `GET /api/support/:id`.
- Only `sanitizeSupport()` output leaves: brand, model, firmware, symptom (when, steps, ports, scrubbed error), platform,
  scrubbed note. Rate limits: guides 20/h per IP (and the shared daily AI cap), support 5/h per IP.
- Working the queue: `npm run support` (needs `SUPPORT_TOKEN` in `.env`, also a Worker secret) and docs/SUPPORT-TRIAGE.md.

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
- The icon proxy only fetches from the TV's own IP, and only icon URLs that TV listed in `apps()`.
- Drivers throw `HearthError` with a status (`unsupported()` → 501, `offline()` → 503), never HTTP-aware code. Network errors go through `asOffline()`/`isUnreachable()` in errors.js (one shared errno set); the server also maps any stray unreachable error to 503.
- Unpaired TVs are never connected to automatically, because connecting pops a prompt on the TV.
- **Nothing a TV does can crash Hearth.** Every socket, dgram and child stdin has a persistent `'error'` listener; socket `'data'` handlers are wrapped so a bad frame destroys that socket only; frames are size-capped (Cast/remote 64 KB). `bin/hearth.js` logs `uncaughtException`/`unhandledRejection` and keeps running; only the HTTP server failing exits (launchd restarts it). Shutdown has a 5 s deadline.
- **Every network call has a timeout; every reconnect uses `src/backoff.js`** (2 s → 60 s, ±20% jitter, reset only after 60 s up). LG runs lgtv2 with `reconnect: 0` and reconnects itself; Cast, the Google remote and the Apple TV helper use the same helper.
- **Persistence never throws:** `src/jsonfile.js` writes temp (unique name) → fsync → previous copy to `.bak` → rename, and reads fall back to `.bak`, else move the bad file to `<name>.corrupt-<ts>` and start empty. Store, scenes and telemetry all use it, each through a save queue.
- **One change per TV at a time:** `Hub` serialises relocate/update/unpair/remove per TV and add per IP (`#withLock`), and there is one scan in flight (`scan()` is shared). `#reattach()` is the only way to swap a driver (it stops the old one and any watcher first). `remove()` clears every per-TV map and timer.
- **Who may call the API (src/guard.js):** the Host must be a local name (private IP literal, localhost, single-label, `.local`/`.lan`/`.home.arpa`…, the friendly URL's host, `HEARTH_ALLOWED_HOSTS`) or it's 421, which stops DNS rebinding. A mutating request with an `Origin` must come from such a host (403). TV addresses can't be loopback/link-local/multicast (`Hub({ forbiddenIp })`; tests on 127.0.0.1 pass `() => false`). Scan, add, doctor and AI calls are token-bucket rate limited per client (429 + Retry-After). Only phones in the household get past this (next line).
- **The household (src/household.js, web/household.js):** every `/api/*` call needs a joined phone except `GET /api/health` (away mode's probe), `GET /api/household` (status) and `POST /api/household/join` ({code} or {invite}). Joining sets an HttpOnly `hearth_device` cookie (SameSite=Strict, 10 years; the native app will send `x-hearth-device`). Tokens are stored sha256-hashed in `~/.hearth/household.json` (0600) with the plaintext house code; neither the code nor tokens are ever logged or printed by `npm run up` (its output lands in log files; `npm run code` prints the code to the terminal on purpose). Loopback (127.0.0.1/::1) is always trusted, which is how the owner gets the first code. The family portal *redirects* /tv to :8770; if it ever proxied instead, every phone would look like loopback. Invites are one-time, 24 h. Wrong codes: the `join` rate-limit bucket per client, plus 20 misses/hour across everyone pauses typed codes. Removing a phone drops its SSE at once; the app's api() turns a 401 into the door. `HEARTH_OPEN=1` disables it; `createServer` without `household` is open (tests), `trustLoopback: false` lets tests act like a phone.
- **SSE:** a client whose buffer passes 512 KB, or whose socket closed or errored, is dropped and stops counting as a viewer. The web app reopens a CLOSED EventSource with backoff (and at once when the page becomes visible) and shows "Reconnecting…" (`html.stale`) meanwhile. `api()` times out (15 s; 90 s for pair/launch/doctor/AI/scan/bulk/power/add).
- **Logs:** one format, `<ISO time> LEVEL [hearth] message` (src/log.js; quiet under `node --test`). `~/.hearth` is 0700, and `hearth.log` is 0600 and rotated in-process at 5 MB (keep 3) by copy-then-truncate, because launchd and `npm run up` hold it open in append mode. Never log credentials.

## Apple TV state (pushed, never polled)

- `power`: Companion SystemStatus push (`on`/`off`; asleep Apple TVs stay connected, so `online: true, power: 'off'`).
- `app`/`appTitle`: MRP now-playing app (bundle id + name), so it's the app *playing*, not merely focused (pyatv exposes no focus-app). After `launch()` the driver sets it at once; the next push refines it. Needs the AirPlay credential.
- `nowPlaying` (title, "Series: Episode"), `playing` (`playing`/`paused`/`loading`).
- `volume` + `capabilities.volumeLevel` only when pyatv reports a level (Apple TV driving HomePods). With a TV over HDMI-CEC, volume up/down are HID presses with no level.
- `unavailable`: set when the bridge can't start (no Python/pyatv); the app shows "Needs setup" and the reason. In `auto` mode (the venv exists) a bridge that then fails to start hands the driver to the JS transport instead.
- **JS transport:** `power` from FetchAttentionState + SystemStatus/TVSystemStatus pushes, volume from `_iMC`/`_mcc` GetVolume (HomePods only). No `app`/`nowPlaying`/`playing` (that's MRP over AirPlay) and no typing (`capabilities.keyboard: false`; tvOS wants keyed-archiver RTI payloads). Unverified on a real Apple TV as of 2026-10-27; tested against a fake in test/appletv-js.test.js and, once by hand, against pyatv 0.18's own server-side Companion auth (`pyatv.protocols.companion.server_auth`) on 127.0.0.1.

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
| …and that made the fields blurry on phones (2026-10-26): the house field's backing store was 402×874 CSS px (the page) shown in a 402×629 box (72dvh), at maxDpr 2 on a 3× screen | `makeField()` and the racer pass `container: <the canvas>`, `maxDpr: 3`, `fpsFloor: 30` (the governor's first step down is resolution). Check with `canvas.width / getBoundingClientRect().width` = devicePixelRatio on both axes. |
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
| 2016-17 Samsungs have no PowerState. Probed 2026-10-21 on the UN55KU6290, read-only, through a real off/on by the family: REST :8001, ws :8001, UPnP :9197 and :9119 all answer while on; on power-off :9119 closed first (~20 s), then the whole set left the network ~40-50 s in (no ping, EHOSTDOWN) and stayed silent for 11 min until switched on, when everything came back at once. No periodic wake-ups seen. | Power = app visible or :9119 open → `on`; :9119 closed but REST answering → `standby` (going down); unreachable → `off`. The old "answers in standby → `unknown`" note was wrong for this set (maybe true with *Power On with Mobile* on). HA uses websocket reachability; openHAB uses the DMR's SSDP alive/byebye; neither has a better signal. |
| Samsung REST `/api/v2/applications/<id>` | `{ name, running, visible, version }`; 404 = not installed. `running` stays true in the background, so only `visible` means on screen. POST to it launches the app (the REST fallback). Both the store id (YouTube TV `3201707014489`) and the Tizen package id (`PvWgqxV3Xa.YouTubeTV`) answer. |
| Samsung UPnP renderer :9197 (`/dmr`) | RenderingControl GetVolume/GetMute/SetVolume/SetMute work on the 2016 set (SOAP to `/upnp/control/RenderingControl1`); AVTransport is idle (`NO_MEDIA_PRESENT`) unless something is cast to it. |
| Google TV keeps Cast alive in standby | RECEIVER_STATUS carries `isStandBy: true`; Hearth used to show such a TV as "on". `GET_APP_AVAILABILITY` says which Cast apps it can open (Netflix `CA5E8412` is APP_UNAVAILABLE on the TCL: Netflix uses its own protocol on Android TV). |
| The D-pad's OK button is `class="ok"` | Global `.ok` (absolute, round) also hit `.chip-result.ok` result chips; launcher.css resets them for `.launch-results` and `.bulk-results`. Don't give new elements a bare `.ok` class. |
| Synthetic PointerEvents with an unknown pointerId make `setPointerCapture` throw | The pad wraps it in try/catch. Use `pointerId: 1` in browser tests. |
| `python3 -m http.server` lets Chrome cache JS/CSS heuristically; previews look stale | Re-fetch with `{cache:'reload'}`, or serve with `--directory dist` after each build (the build deletes dist). |
| The house redraws its cards on every TV update, so an element found a moment ago is detached | Anything that points at a card later (web/tour.js) re-finds it by selector when `!el.isConnected`. |
| Simple Icons' `max` is the Cycling '74 music app, not the streaming service | The catalog's Max uses `hbomax` (scripts/brand-icons.mjs). Check every new logo by eye. |
| Never use `ok`/`bad` as a state class | `.ok` is the D-pad's OK button (`position:absolute; inset:31%`), so `.dr-step.ok` or `.chip-result.ok` turn into floating circles. Prefix state classes (`st-ok`, `res-ok`). |
| Fields named `cert`/`key` on a class with a `key()` method | `Object.assign(this, { key })` shadows the method. AtvRemote stores `certPem`/`keyPem`. |
| A Google TV paired with a cert it later forgets drops the TLS handshake on :6466 | Surfaced as 401 "unlock again", with retries backed off to 60 s. The doctor reports `googletv-code`. |
| `tv` objects are live: `relocate()` mutates `tv.ip` | Capture `startIp` before scanning; comparing `hub.get(id).ip` with `tv.ip` is always equal. |
| `arp -n <ip>` spawned from Node sees "no entry" (and `netstat -rn` shows no LAN routes) on this Mac, while the same command in a shell works | Seen 2026-10-21; likely macOS Local Network privacy filtering what Node's child processes can read. `macFor()` then returns null: Google TVs added without a MAC can't be woken, and MAC-based self-healing falls back to id matching. Granting Node Local Network access (System Settings → Privacy & Security → Local Network) may fix it. Not reproducible in tests. |
| An LG that is already off when Hearth starts never connects, so lgtv2 never emits `close` | The driver marks it `off` on a connection error before the first connect; before this it stayed at the boot-time `unknown` (seen 2026-10-21, Living Room TV fully off, no ping). |
| Service workers only register on secure origins (HTTPS or localhost) | `http://azizfamily.local` can't cache the app, so a cold launch away from home shows the browser's error page; away mode only kicks in when the page is already loaded. The public `/hearth/racer/` (HTTPS) is the offline-installable copy. `localhost` gets `web/sw.js`, so test cold-offline there. |
| CSS `display` on a class beats the `hidden` attribute | racer.css sets `[hidden] { display: none !important }`; `.ghost`/`.go` are `display:block`. |
| Not every TV can say "playing" | Roku `/query/media-player` (state, position, duration, is_live), LG `ssap://com.webos.media/getForegroundAppInfo` (playState only, webOS 4+; apps that skip the webOS media pipeline say nothing), Apple TV via pyatv (state + position). Samsung and Google TV over Cast give nothing, so `phaseOf()` falls back to this phone's last keys (play/skip → watching, arrows in the last 30 s → browsing) and 90 s settled in a streaming app. |
| LG "Turn on via Wi-Fi" is `ssap://settings/getSystemSettings` `{category:'network', keys:['wolwowlOnOff']}` | Readable and writable with lgtv2's normal permissions (verified 2026-10-21 on the 55UP7000PUA, already `'true'`). One unknown key in `keys` (e.g. `wakeUpWithMobile`) fails the whole read with "500 Application error". The driver reads it on every connect and sets it to `'true'` if off → `state.wakeOnLan`. Samsung 2016-17 ("Power On with Mobile"), Roku sticks and Google TV have no network-settable equivalent. |
| A file someone else holds open in append mode can't be renamed to rotate it | launchd's `StandardOutPath` and up.mjs's `'a'` fd would keep writing into `hearth.log.1`. `rotate()` copies to `.1` and truncates in place; O_APPEND writers carry on at offset 0. |
| lgtv2 copies its config, so `reconnect` can't be changed after construction | Run it with `reconnect: 0` and call `client.connect()` from the driver's own backoff timer. After trying wss and ws it reports `ECONNFAILED`, which counts as unreachable. |
| An `'error'` emitted twice on a socket with only a `once('error')` listener crashes Node | Seen in SSDP (12 sends, one listener) and Cast. Always use `on('error')`. |
| `fetch` can't set the `Host` header | Host/Origin tests use `node:http` requests (test/resilience.test.js). |
| A late answer from a slow Roku could overwrite a newer one | `#tick()` numbers each read and drops older ones; the interval skips while a read is in flight. |
| macOS has no `timeout` binary | Don't rely on it in scripts. |
| Apple TV needs Python: pyatv is Python-only | `npm run up` creates `~/.hearth/py` (override `HEARTH_VENV`; shared by every HEARTH_HOME, so a scratch server reuses it) and pins `pyatv==PYATV_VERSION` (src/atv-bridge.js). No python3 ≥ 3.10 → it prints a skip line and Hearth runs; Apple TVs answer 503 "needs Python 3 and pyatv". The bridge isn't cached as failed, so installing later works without a restart. |
| `brew upgrade python` leaves a venv whose `bin/python` symlink dangles | `up.mjs` runs the venv's python; if it fails it rebuilds with `venv --clear` and reinstalls pyatv. |
| Macs, iPads and HomePods announce `_companion-link`/`_airplay` too; so do LG/TCL/Roku TVs with AirPlay built in | `appleTvsFrom()` keeps only `rpMd`/`model` = `AppleTV*`. Seen here: MacBookPro18,2 ("YLQ51F65YV"), Denon AVR-S960H ("Home Theater"). HomePods are `AudioAccessory*`. |
| An Apple TV's AirPlay `deviceid` looks like a MAC but is randomised (locally administered bit) | Stored as `tv.atvId` (pyatv's identifier, used to find it if DHCP moves it), never in `macs`. Apple TVs wake over Companion, not WOL. |
| pyatv `connect()` with a protocol that needs pairing but has no credentials fails or prompts | The bridge disables unpaired Mandatory services plus RAOP/DMAP before connecting, so Companion-only works between the two codes. |
| A paired Apple TV's Companion port isn't fixed (49153 here, varies) | Reachability/diagnostics use AirPlay :7000; the bridge re-resolves the device by unicast mDNS to its IP, then by identifier. |
| The JS transport has no mDNS to find Companion's port | `findPort()`: the saved `tv.atvPort`, then 49152-49160 in parallel. A port counts only if it answers PV_Start (pair-verify step 1) with a key: harmless, no code on screen, nothing stored, since we hang up before step 3. |
| OPACK back-references: pyatv's packer counts dicts/lists in its table but its unpacker doesn't, and 0xC3/0xC4 are 4/8-byte on pack but 3/4-byte on unpack | src/atv/opack.js uses one rule both ways (scalars whose encoding is >1 byte; 0xC1-0xC4 = 1-4 byte index, as pyatv decodes what Apple sends). Every pyatv test vector passes. |
| pyatv doesn't check the Apple TV's pair-setup proof (M4) or its M6 signature | hap.js checks both (HAP spec); verified against pyatv's server-side auth. If a real Apple TV ever fails there with the right code, that check is the first suspect. |
| pyatv logs to stdout by default would corrupt the JSON-lines protocol | The bridge logs to stderr only (Node prefixes and forwards it to hearth.log); stdout is protocol. |
| macOS Local Network privacy can silently block multicast for Terminal/Node | If a scan finds nothing on a Mac, check System Settings → Privacy & Security → Local Network. |

## Definition of done

Tests green (`npm test`), README updated for anything user-facing, a new nuance added to the table above whenever one bites.
| iOS home-screen web apps may keep their own cookies, separate from Safari | A phone that joined in Safari may see the door again after Add to Home Screen; the door then says to type the code (an invite QR opens Safari, not the app). Not verified on a device. |
| A same-page jump to `#join=…` doesn't reload the app | web/household.js also listens for `hashchange` while the door is up. |
| iOS haptics have no API; Safari 18+ taps when a `<input type=checkbox switch>` toggles inside a user activation | feel.js clicks a persistent off-screen switch (not display:none) on pointerup/touchend/click; pointermove isn't an activation, so iPhone can't tick *during* a slide (Android can). `hapticSupport()` tells Settings what to say. System Haptics must be on in iPhone Settings. |
| Edge sliders overlapped the orb on narrow phones and sat in iOS Safari's swipe-back zone | Aurora orb zone is three rails sized with container units (`--rail`, `--gap`, `--pad` from `100cqw` of `.device`): the orb shrinks, the rails never overlap. Volume is a real slider (fill follows the finger, 40 steps per full slide, `POST /volume` throttled 150 ms); channel is a two-button rocker. |
| The home server is plain http, so phones refuse Wake Lock, Web Share, Clipboard, Badging and storage.persist | web/native.js uses each when `isSecureContext`, else: a 1.5 KB muted looping inline (data: URI) mp4 keeps the screen on (needs a touch to start, retried on touchend), `sms:` link for Send with Messages, `execCommand('copy')`. Real fix for all of them: HTTPS on the LAN or the native app. |
| Pull to refresh must not fight the D-pad, sliders, Stream Center or trackpad swipes | web/pull.js only starts in the house view or the remote's top bar/HUD, never inside `.pad, .orb-zone, .slider, .rocker-ch, .sc-surface, .mode-panel`; touch events (non-passive) so it can cancel page scroll and Safari's own pull-to-reload. `POST /api/refresh` → `hub.refreshAll()` (each driver's `refresh()`, 4 s cap, plus a background scan). |
| Manifest shortcuts (`?go=last`, `&mode=stream`, `?do=all-off`, racer/) | `native.launch()` reads and strips them at boot; `followLaunch()` acts after the first `hello`. Android shows shortcuts only for installed (https) apps; iOS ignores them. |
| A 2016 Samsung (UN55KU6290) switched itself off ~15 min after every switch-on (seen 2026-10-21/22, telemetry), and Hearth then showed "Not responding · Fix", which read as "it forgot the TV" | `Telemetry.offPattern()` → `view.off`: `last: 'off'` (powered down, then left the network: normal) vs `'lost'` (vanished while on); `autoOff` when ≥2 sessions with nobody pressing power on *any* TV (a Roku's power-off reaches its TV over CEC) end at the same length (±2 min). The card drops "Fix" for a normal off; the banner says "Switched off · still connected", or "Turns itself off after ~N min" → health finding with the TV's sleep/no-signal settings. Wakes resolved after the 90 s window no longer count as working (a hand switch-on 20 min later used to). |
| A power bill carries a name, service address and account number | Never sent whole. PDFs are read on the phone (pdf.js 6, `vendor/pdf.min.mjs` served from node_modules, copied into the demo build) and only `chargeLines()` go out (lines with money/kWh/rate words; lines with account/address/phone/email/meter-no words dropped; digit runs of 7+ digits → `#`); the person sees them first. Photos: the person crops to the charges box. Hub and Worker run `chargeLines()` again. The `@` in "918 kWh @ $0.0921" once matched an email filter and dropped every rate line; dates like 09/01/2026 - 09/30/2026 once got scrubbed as account numbers: both covered by test/energy.test.js. |
| Gemma 4 on Workers AI reads bill photos | OpenAI-style `image_url` data-URL parts in `env.AI.run` (verified 2026-10-22: text 1.7 s, photo 2.8 s, ~$0.0001 each). Fallback vision model: mistral-small-3.1. `/bill` takes bodies up to 2.3 MB (hub: 2.4 MB on that route only); free calls are 6/h per IP within the shared daily cap. |
