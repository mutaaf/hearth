# 🔥 Hearth

**One remote for every TV in the house.** Hearth finds the LG and Samsung smart TVs on your Wi-Fi and gives every phone in the house a fast, tactile remote: power, D-pad, volume, apps, inputs, and "Dinner's ready!" on screen. No accounts, no cloud, no ads. It runs on any always-on computer at home.

```
git clone https://github.com/mutaaf/hearth && cd hearth
npm run up
```

Then scan the QR code it prints with your phone. That's the whole setup.

---

## Getting started (5 minutes, no tech skills needed)

1. **Install Node.js** (version 20.19 or newer) from [nodejs.org](https://nodejs.org) on a computer that's usually on: a Mac mini, an old laptop, a Raspberry Pi.
2. **Run `npm run up`** in the `hearth` folder. It installs what it needs and starts Hearth in the background. Run it again any time; it won't start a second copy.
3. **Open the link on your phone.** Scan the QR code or type the `http://192.168…:8770` address it shows. Your phone has to be on the same Wi-Fi.
4. **Tap "Find my TVs".** Turn the TVs on first. Hearth listens for them on the network.
5. **Tap "Add", then press _Allow_ on the TV.** Each TV asks once, using its own remote. After that, every phone in the house can control it.

> 💡 On iPhone, tap **Share → Add to Home Screen** so Hearth opens full-screen like an app.

### Turning TVs *on* from your phone

TVs that are fully off aren't on the network, so Hearth wakes them with Wake-on-LAN. Enable it once on each TV:

| Brand | Setting |
|---|---|
| LG (2018–2024) | Settings → General → Devices → TV Management → **Turn On via Wi-Fi** (older: _Mobile TV On_) |
| LG (2025+) | Settings → Support → IP Control Settings → **Wake On LAN** |
| Samsung | Settings → General → Network → Expert Settings → **Power On with Mobile** |

### What works

| | LG webOS (2014+) | Samsung Tizen (2016+) |
|---|---|---|
| Find automatically | ✅ | ✅ |
| D-pad, back, home, menu, media keys | ✅ | ✅ |
| Volume / mute / channel | ✅ with live level | ✅ |
| Power off / on | ✅ / ✅ Wake-on-LAN | ✅ / ✅ Wake-on-LAN |
| App shelf + launch | ✅ with icons | ✅ |
| Switch inputs | ✅ named HDMI list | ✅ Source key |
| Message on screen | ✅ | — |
| See what's playing | ✅ | — |
| Everything off at once | ✅ | ✅ |

### Commands

| | |
|---|---|
| `npm run up` | Install if needed, start in the background, print the phone link |
| `npm run down` | Stop it |
| `npm start` | Run in the foreground (see logs live) |
| `npm run scan` | List TVs on the network from the terminal |
| `npm test` | Run the test suite (no TV needed) |

Settings via environment: `HEARTH_PORT` (default `8770`), `HEARTH_HOME` (default `~/.hearth`, where your TVs and pairing keys are saved).

## Troubleshooting

- **"No TVs answered".** Make sure the TV is really on, not in standby, and on the same network as the computer running Hearth. Guest Wi-Fi and some mesh "client isolation" settings block discovery. Add the TV by IP instead (Settings → Network on the TV shows it).
- **Mac: nothing found at all.** macOS may ask to let Terminal/Node "find devices on your local network". Allow it (System Settings → Privacy & Security → Local Network).
- **The pairing prompt never appeared.** On LG, check Settings → General → **LG Connect Apps** is on. On Samsung, check Settings → General → External Device Manager → **Device Connection Manager**.
- **Phone can't open the link.** Your phone must be on the same Wi-Fi, and the computer's firewall must allow incoming connections for Node.

## Privacy and security

Hearth talks only to devices on your home network. TV pairing keys are stored in `~/.hearth/tvs.json` (readable only by your user) and are never sent to the browser. Anyone on your home Wi-Fi can open the remote, just like the TV makers' own apps. Commands require a JSON request, so a random website can't press buttons on your TV through your browser.

## Make your old smart TVs fast again

See **[docs/TUNEUP.md](docs/TUNEUP.md)** for a practical clean-up guide for 4+-year-old TVs: ads, tracking, bloat, and when to just turn the TV into a plain screen.

## Contributing

Adding a brand (Roku, Android/Google TV, Vizio, Sony…) is one file. See [CLAUDE.md](CLAUDE.md) for the architecture and [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.

MIT licensed.
