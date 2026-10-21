# Roadmap

North star: **anyone can turn a house full of slow, ad-ridden smart TVs into one fast, private system in an afternoon.**

## Now (v0.1): universal remote ✅
- Auto-discovery (SSDP) + add-by-IP for LG webOS and Samsung Tizen
- One-time pairing flow with an on-screen illustration
- Phone-first remote: swipe pad, volume/channel rockers, media keys, app shelf, inputs, on-screen messages
- Live state over SSE (power, volume, what's playing), "Everything off"
- `npm run up` one-command setup with a QR code

## Next
1. **Always-on service:** `npm run service:install` (launchd on macOS, systemd on Linux) so Hearth survives reboots.
2. **Scenes and schedules:** "School night: all TVs off at 9pm", "Movie night: living room on, HDMI 2, volume 25".
3. **Tune-up assistant in the app:** a per-TV checklist from docs/TUNEUP.md, with a firmware check that says whether this LG can be rooted.
4. **Keyboard:** send text to search boxes (LG `insertText`, Samsung `SendInputString`).
5. **Per-kid limits:** screen-time budgets, plus a Family Portal widget showing which screens are on.
6. **Voice:** expose the hub as an MCP server so Claude/Jarvis can say "turn off the kids' TV".

## Later
- More brands: Roku (ECP, trivial), Android/Google TV (ADB or the Remote v2 protocol), Vizio SmartCast, Sony Bravia IP control, HDMI-CEC via a Pi.
- **Hearth Launcher:** an Android TV home-screen app that turns any streaming box into the "custom TV OS" (family profiles, no ads, synced across every TV, driven by the hub).
- Rooted-LG automation: one-tap Homebrew Channel setup and telemetry kill scripts over SSH.
- Native shells (Expo) for push notifications and lock-screen controls.
