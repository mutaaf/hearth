# Roadmap

North star: **anyone can turn a house full of slow, ad-ridden smart TVs into one fast, private system in an afternoon.**

## Shipped

**v0.1: universal remote**
- Auto-discovery (SSDP) plus add-by-IP for LG webOS and Samsung Tizen
- Phone-first remote: swipe pad, rockers, media keys, app shelf, inputs, on-screen messages
- Live state over SSE (power, volume, what's playing), "Everything off"
- `npm run up` one-command setup with a QR code

**v0.2: feel**
- Press engine with haptics, hold-to-repeat, long-press and hold-to-confirm
- Two skins: Classic and 8-bit
- A setup wizard so easy a caveman can do it; "New TV nearby" auto-discovery

**v0.3: every TV in the house**
- **Roku** (ECP): no pairing, real press-and-hold, apps with icons
- **Google TV / Android TV** via Cast: no pairing and no code; volume, mute, apps, what's on
- **Samsung 2016–17** on ws:8001, connecting with no prompt
- **LG PIN pairing:** the TV shows a number and you type it, so no remote is needed
- Unpaired TVs can be woken; the wizard wakes an off TV before connecting
- **Apple TV** via pyatv (one shared Python bridge): two on-screen codes (Companion, then AirPlay), keys with holds, power, every installed app, live app/title/power pushed (no polling), typing into search

**v0.10: one launcher, true state**
- **Open any popular app on every TV at once** ("YouTube TV on all TVs"): a cross-brand catalog of 20 streaming apps with each platform's own ids, a house-wide Watch row (hold to open everywhere, wakes TVs first) and a per-TV grid; `POST /api/launch`, and scenes/bulk speak the same `{ app }`
- **Samsung that matches the TV**, 2016-17 sets included: the app on screen (REST), real volume and mute (UPnP), real on/asleep/off (probed on a KU6290), REST launch fallback
- **No stale state anywhere:** every command is re-checked a moment later; Google TVs report standby; quiet Cast sockets are dropped; LG/Roku standby clears "now playing"; polling speeds up while the app is open

## Road to the App Store (current focus)
Make Hearth robust enough to charge for, then ship it native.
1. **Resilient core:**
   - No single TV, socket or bad response can crash or wedge the server.
   - Every network call has a timeout.
   - Every reconnect backs off with jitter and cleans up after itself.
   - Pairings survive a corrupt or half-written store.
2. **Honest live state:** heartbeats on the live stream; the app shows "reconnecting…" instead of stale buttons. Commands get one clear result: done, retried, or why not.
3. **Operations:**
   - Logs that rotate and never contain keys.
   - A health endpoint that reports every driver.
   - Crash-safe restarts.
   - A support bundle a user can send.
4. **Security on the LAN:**
   - Only this household's phones can control or forget TVs. **Not done yet:** this needs a per-household token. A phone would join by scanning a QR code from a phone that's already trusted. Today anyone on the Wi-Fi can use the remote.
   - DNS-rebinding and cross-site protection. **Done in v0.12:** Host allowlist, Origin check, icon proxy limited to the TV's own icons, rate limits.
5. **Chaos tests:** fake TVs that drop mid-command, answer garbage, go slow, or change IP.
6. **Native app:** backlogged in [backlog/native-app.md](backlog/native-app.md). Works on any network, no home server needed.

## Next
1. **Aurora:** a one-screen remote with a joystick pad and smart "what's on" information, and aurora-field visuals across the app (in progress).
2. **Unlock full remote on Google TV:** Google's remote protocol v2 (TLS 6466/6467) for arrow keys and power. Optional, because Google always requires typing a one-time code shown on the TV.
3. **Always-on service:** `npm run service:install` (launchd on macOS, systemd on Linux).
4. **Scenes and schedules:** "School night: all TVs off at 9pm", "Movie night: living room on, HDMI 2, volume 25".
5. **Tune-up assistant in the app:** a per-TV checklist from docs/TUNEUP.md, with a firmware check that says whether this LG can be rooted.
6. **Launcher, next:** real app artwork (from each TV's own icon where it has one), favourites per family member, deep links (a channel in YouTube TV, a show in Netflix), and Android TV intents for the no-Cast apps once the Google remote protocol is in.
7. **Per-kid limits:** screen-time budgets, plus a home-portal widget showing which screens are on.
8. **Voice:** expose the hub as an MCP server, so an assistant can say "turn off the kids' TV".

## Later
- Apple TV extras: artwork for what's playing, re-run just the AirPlay code from TV settings, swipe gestures on the pad (Companion touch), account switching.
- More brands: Vizio SmartCast, Sony Bravia IP control, HDMI-CEC via a Pi.
- **Hearth Launcher:** an Android TV home-screen app that turns any streaming box into the "custom TV OS" (family profiles, no ads, synced across every TV, driven by the hub).
- Rooted-LG automation: one-tap Homebrew Channel setup and telemetry kill scripts over SSH.
- Native shells (Expo) for push notifications and lock-screen controls.
