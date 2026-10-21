# 🔥 Hearth

**[mutaafaziz.com/hearth](https://mutaafaziz.com/hearth/)** · **[try the demo](https://mutaafaziz.com/hearth/demo/)**

**One remote for every TV in the house.** Hearth finds the LG and Samsung smart TVs, Rokus, Google TVs and Apple TVs on your Wi-Fi and gives every phone in the house a fast, tactile remote: power, D-pad, volume, apps, inputs, and "Dinner's ready!" on screen. No codes, no accounts, no cloud, no ads. It runs on any always-on computer at home.

```
git clone https://github.com/mutaaf/hearth && cd hearth
npm run up
```

Then scan the QR code it prints with your phone. That's the whole setup.

---

## Getting started (5 minutes, no tech skills needed)

1. **Install Node.js** (version 20.19 or newer) from [nodejs.org](https://nodejs.org) on a computer that's usually on: a Mac mini, an old laptop, a Raspberry Pi. For Apple TVs it also needs Python 3.10+ (macOS: `brew install python`); without it everything else still works.
2. **Run `npm run up`** in the `hearth` folder. It installs what it needs (including Apple TV support, in its own Python environment) and starts Hearth in the background. Run it again any time; it won't start a second copy.
3. **Open the link on your phone.** Scan the QR code, or type the address it shows: `http://<your-computer>.local:8770` (or the `http://192.168…:8770` number). Your phone has to be on the same Wi-Fi.
4. **Follow the setup screens.** Turn the TV on and tap the big button. Hearth finds it and connects:
   - **Roku and Google TV:** nothing to press.
   - **Samsung:** 2016–17 sets connect by themselves; newer ones ask for _Allow_ once.
   - **LG:** pick *Show a number on the TV* and type it into your phone (no need to reach the TV's remote), or press _Allow_.
   - **Apple TV:** it shows 4 numbers; type them into your phone. Then it shows 4 more: that second code lets Hearth see what's playing (the remote already works after the first).

   Pick the room. Done. Every phone in the house can now control it, and new TVs show up as a "New TV nearby" banner. A TV you already added but is off? Tap its power button: waking doesn't need it to be connected first.

> 💡 On iPhone, tap **Share → Add to Home Screen** so Hearth opens full-screen like an app.

> 🏠 **A friendlier address.** If you already run a home page on port 80 (a family portal, a dashboard), have it redirect a path like `/tv` to `http://<this-computer>:8770/`, so the whole house just remembers `http://<your-home-name>.local/tv`.

### Turning TVs *on* from your phone

TVs that are fully off aren't on the network, so Hearth wakes them with Wake-on-LAN. Enable it once on each TV:

| Brand | Setting |
|---|---|
| LG (2018–2024) | Settings → General → Devices → TV Management → **Turn On via Wi-Fi** (older: _Mobile TV On_) |
| LG (2025+) | Settings → Support → IP Control Settings → **Wake On LAN** |
| Samsung | Settings → General → Network → Expert Settings → **Power On with Mobile** |
| Roku | Nothing to set: Hearth sends *PowerOn*, which works from standby. A stick whose USB power is cut can't be woken over Wi-Fi. |
| Google TV | Not yet. Power needs Google's one-time code (see below). |
| Apple TV | Nothing to set: a connected Apple TV wakes over the network, and turns the TV on with it over HDMI-CEC. |

### How it feels

- **Every press clicks back** with a short buzz and an optional sound. On iPhone (iOS 18+) the buzz lands as your finger lifts, because Safari only allows it then; Android buzzes on touch and through holds.
- **Hold to repeat:** volume, channel and the D-pad speed up the longer you hold.
- **Swipe the pad** like a trackpad to fly through rows of tiles.
- **Long-press:** OK (a real press-and-hold on Samsung, Roku and Apple TV; holding Home on an Apple TV opens Control Center), a TV card for its settings, and power to turn off **every** TV.
- **Three looks:** *Aurora*, *Classic* (70s hi-fi) and *8-bit*, a pocket game console with a dot-matrix screen that tells you what the TV is doing. Change it under ⚙.
- **Set up a TV in a minute:** a step-by-step wizard (turn it on, connect, pick the room) that wakes an off TV for you, and Hearth notices new TVs on the network by itself.
- **Stays awake** while the remote is open, and works sideways too.

### What works

| | LG webOS (2014+) | Samsung Tizen (2016+) | Roku (players & TVs) | Google TV / Android TV | Apple TV (tvOS 15+) |
|---|---|---|---|---|---|
| Find automatically | ✅ | ✅ | ✅ | ✅ | ✅ |
| Connect | Number on screen, or Allow | Allow once (2016–17: nothing) | Nothing to press | Nothing to press, no code | Two 4-digit codes on screen |
| D-pad, back, home, menu, media keys | ✅ | ✅ | ✅ with real press-and-hold | — needs Google's code | ✅ with press-and-hold |
| Volume / mute | ✅ with live level | ✅ up/down | ✅ up/down | ✅ with live level | up/down (passed to the TV); no mute |
| Power off / on | ✅ / ✅ Wake-on-LAN | ✅ / ✅ Wake-on-LAN | ✅ / ✅ from standby | — needs Google's code | ✅ / ✅ sleep and wake |
| App shelf + launch | ✅ with icons | ✅ | ✅ with icons | YouTube, Netflix, Spotify, Plex | ✅ every installed app |
| Switch inputs | ✅ named HDMI list | ✅ Source key | Roku TVs only | — | — |
| Message on screen | ✅ | — | — | — | — |
| See what's playing | ✅ | — | ✅ | apps opened by cast | ✅ app and title, live |
| Typing into search | ✅ | ✅ | ✅ | — | ✅ when the keyboard is up |
| Everything off at once | ✅ | ✅ | ✅ | — | ✅ |

**About Google TV.** Hearth talks to Google TVs over Cast, which any phone on your Wi-Fi may use, so there's nothing to pair and no code. Cast covers volume, mute and launching apps. Arrow keys and power live in Google's separate remote protocol, which always requires typing a one-time code shown on the TV. That's coming as an optional *Unlock full remote*.

**About Apple TV.** Hearth uses [pyatv](https://pyatv.dev), the open-source implementation of Apple's own remote protocols, in one small helper process. The first code pairs *Companion* (buttons, power, apps); the second pairs *AirPlay*, which tells Hearth what's playing the moment it changes. iPads, Macs and HomePods also announce themselves on the network; Hearth only lists Apple TVs. Volume buttons go to the TV over HDMI-CEC, so Hearth can't show a level unless the Apple TV plays through HomePods.

### Commands

| | |
|---|---|
| `npm run up` | Install if needed, start in the background, print the phone link |
| `npm run down` | Stop it |
| `npm start` | Run in the foreground (see logs live) |
| `npm run scan` | List TVs on the network from the terminal |
| `npm test` | Run the test suite (no TV needed) |

Settings via environment: `HEARTH_PORT` (default `8770`), `HEARTH_HOME` (default `~/.hearth`, where your TVs and pairing keys are saved), `HEARTH_VENV` (default `~/.hearth/py`, the Python environment for Apple TV support).

## Troubleshooting

- **"No TVs answered".** Make sure the TV is really on, not in standby, and on the same network as the computer running Hearth. Guest Wi-Fi and some mesh "client isolation" settings block discovery. Add the TV by IP instead (Settings → Network on the TV shows it).
- **Mac: nothing found at all.** macOS may ask to let Terminal/Node "find devices on your local network". Allow it (System Settings → Privacy & Security → Local Network).
- **The pairing prompt never appeared.** On LG, check Settings → General → **LG Connect Apps** is on (or use *Show a number on the TV*). On Samsung, check Settings → General → External Device Manager → **Device Connection Manager**.
- **Roku says no.** Recent Roku OS versions can block network remotes. On the Roku: Settings → System → Advanced system settings → **Control by mobile apps** → Network access → **Default** (or Permissive).
- **Google TV not found.** It's found over Cast, so it must be on the same network as the computer running Hearth (not a guest network). Nothing needs to be switched on in the TV for this. Guest mode isn't needed either.
- **Apple TV says it "needs Python 3 and pyatv".** Install Python 3.10+ (`brew install python` on a Mac) and run `npm run up` again. No restart needed.
- **Apple TV never shows the numbers.** On the Apple TV: Settings → AirPlay and HomeKit → Allow Access → **Anyone on the Same Network**. Type the code within a minute; tap *Show the number again* for a fresh one.
- **Phone can't open the link.** Your phone must be on the same Wi-Fi, and the computer's firewall must allow incoming connections for Node.

## Privacy and security

Hearth talks only to devices on your home network. TV pairing keys are stored in `~/.hearth/tvs.json` (readable only by your user) and are never sent to the browser. Anyone on your home Wi-Fi can open the remote, just like the TV makers' own apps. Commands require a JSON request, so a random website can't press buttons on your TV through your browser.

## Make your old smart TVs fast again

See **[docs/TUNEUP.md](docs/TUNEUP.md)** for a practical clean-up guide for 4+-year-old TVs: ads, tracking, bloat, and when to just turn the TV into a plain screen.

## Contributing

Adding a brand (Vizio, Sony…) is one file. See [CLAUDE.md](CLAUDE.md) for the architecture and [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.

MIT licensed.
