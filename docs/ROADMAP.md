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

## Next
1. **Aurora:** a one-screen remote with a joystick pad and smart "what's on" information, and aurora-field visuals across the app (in progress).
2. **Unlock full remote on Google TV:** Google's remote protocol v2 (TLS 6466/6467) for arrow keys and power. Optional, because Google always requires typing a one-time code shown on the TV.
3. **Always-on service:** `npm run service:install` (launchd on macOS, systemd on Linux).
4. **Scenes and schedules:** "School night: all TVs off at 9pm", "Movie night: living room on, HDMI 2, volume 25".
5. **Tune-up assistant in the app:** a per-TV checklist from docs/TUNEUP.md, with a firmware check that says whether this LG can be rooted.
6. **Keyboard:** send text to search boxes (LG `insertText`, Samsung `SendInputString`, Roku `Lit_` keys).
7. **Per-kid limits:** screen-time budgets, plus a home-portal widget showing which screens are on.
8. **Voice:** expose the hub as an MCP server, so an assistant can say "turn off the kids' TV".

## Later
- More brands: Apple TV (Companion protocol), Vizio SmartCast, Sony Bravia IP control, HDMI-CEC via a Pi.
- **Hearth Launcher:** an Android TV home-screen app that turns any streaming box into the "custom TV OS" (family profiles, no ads, synced across every TV, driven by the hub).
- Rooted-LG automation: one-tap Homebrew Channel setup and telemetry kill scripts over SSH.
- Native shells (Expo) for push notifications and lock-screen controls.
