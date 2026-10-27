# 🔥 Hearth

**[mutaafaziz.com/hearth](https://mutaafaziz.com/hearth/)** · **[try the demo](https://mutaafaziz.com/hearth/demo/)**

**One remote for every TV in the house.** Hearth finds the LG and Samsung smart TVs, Rokus, Google TVs and Apple TVs on your Wi-Fi and gives every phone in the house a fast, tactile remote: power, D-pad, volume, apps, inputs, and "Dinner's ready!" on screen. No codes, no accounts, no cloud, no ads.

**Most people want the iPhone app** (coming soon to the App Store): download it, open it on your Wi-Fi, tap your TV. No computer, nothing to install, nothing to type. Your first TV is free.

This repo is the open-source engine behind it. You can also run it yourself on an always-on computer so every phone and browser in the house shares one Hearth; that's what the rest of this page covers.

---

## Run it on your own computer (for tinkerers)

1. **Install Node.js** (version 20.19 or newer) from [nodejs.org](https://nodejs.org) on a computer that's usually on: a Mac mini, an old laptop, a Raspberry Pi. For the full Apple TV experience it also wants Python 3.10+ (macOS: `brew install python`); without it Apple TVs still get the remote (buttons, power, apps) from Hearth's built-in JavaScript client, just not "what's playing".
2. **Run `npm run up`** in the `hearth` folder. It installs what it needs (including Apple TV support, in its own Python environment) and starts Hearth in the background. Run it again any time; it won't start a second copy.
3. **Open the link on your phone.** Scan the QR code, or type the address it shows: `http://<your-computer>.local:8770` (or the `http://192.168…:8770` number). Your phone has to be on the same Wi-Fi.
4. **Follow the setup screens.** Turn the TV on and tap the big button. Hearth finds it and connects:
   - **Roku and Google TV:** nothing to press.
   - **Samsung:** 2016–17 sets connect by themselves; newer ones ask for _Allow_ once.
   - **LG:** pick *Show a number on the TV* and type it into your phone (no need to reach the TV's remote), or press _Allow_.
   - **Apple TV:** it shows 4 numbers; type them into your phone. Then it shows 4 more: that second code lets Hearth see what's playing (the remote already works after the first).

   Pick the room. Done. Every phone in the house can now control it, and new TVs show up as a "New TV nearby" banner. A TV you already added but is off? Tap its power button: waking doesn't need it to be connected first.

> 💡 **Get it on every phone and iPad:** in Hearth, open ⚙ → *Get Hearth on another phone or iPad* to send the link with Messages or show a QR code. On the iPad, Hearth shows the exact taps: **Share → Add to Home Screen → Add**. It then opens full-screen with its own icon.

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
- **Three looks, light or dark:** *Aurora*, *Classic* (70s hi-fi) and *8-bit*, a pocket game console with a dot-matrix screen that tells you what the TV is doing. Aurora and Classic come in Light (the default), Dark, or Auto (follows the phone). Change it under ⚙.
- **Switches on like an old TV:** every launch opens with a CRT power-on (a dot, a scan line, an ember flash). Reduced Motion skips it.
- **Set up a TV in a minute:** a step-by-step wizard (turn it on, connect, pick the room) that wakes an off TV for you, and Hearth notices new TVs on the network by itself.
- **Stays awake** while the remote is open, and works sideways too.
- **Watch on every TV:** the house screen has a row of the popular apps (YouTube, YouTube TV, Netflix, Prime Video, Disney+, Max, Hulu, Apple TV, Peacock, Paramount+, ESPN and more). **Hold** one to open it on every TV, waking the ones that are off; each TV answers ✓ or ✕ with why (not installed, can't open on that TV). In select mode it opens on just the TVs you picked. On a TV's **Apps** tab, tap one to open it there. Each TV opens its own version of the app, so you never have to know that YouTube TV is a different id on a Samsung and a Roku.
- **What you see is what the TV says:** on/asleep/off, the app on screen and the volume come from the TVs themselves and are re-checked right after every press, including older (2016-17) Samsungs.

### What works

| | LG webOS (2014+) | Samsung Tizen (2016+) | Roku (players & TVs) | Google TV / Android TV | Apple TV (tvOS 15+) |
|---|---|---|---|---|---|
| Find automatically | ✅ | ✅ | ✅ | ✅ | ✅ |
| Connect | Number on screen, or Allow | Allow once (2016–17: nothing) | Nothing to press | Nothing to press, no code | Two 4-digit codes on screen |
| D-pad, back, home, menu, media keys | ✅ | ✅ | ✅ with real press-and-hold | — needs Google's code | ✅ with press-and-hold |
| Volume / mute | ✅ with live level | ✅ with live level (UPnP) | ✅ up/down | ✅ with live level | up/down (passed to the TV); no mute |
| Power off / on | ✅ / ✅ Wake-on-LAN | ✅ / ✅ Wake-on-LAN | ✅ / ✅ from standby | — needs Google's code | ✅ / ✅ sleep and wake |
| App shelf + launch | ✅ with icons | ✅ | ✅ with icons | apps with a Cast app (YouTube, YouTube TV, Prime Video, Disney+, Paramount+, Spotify, Plex, Twitch, YouTube Kids) | ✅ every installed app |
| Open an app on every TV at once | ✅ | ✅ | ✅ | ✅ Cast apps | ✅ |
| Switch inputs | ✅ named HDMI list | ✅ Source key | Roku TVs only | — | — |
| Message on screen | ✅ | — | — | — | — |
| See what's playing | ✅ | ✅ the app on screen | ✅ | ✅ app, and asleep vs on | ✅ app and title, live |
| Typing into search | ✅ | ✅ | ✅ | — | ✅ when the keyboard is up |
| Everything off at once | ✅ | ✅ | ✅ | — | ✅ |

**About Google TV.** Hearth talks to Google TVs over Cast, which any phone on your Wi-Fi may use, so there's nothing to pair and no code. Cast covers volume, mute, asleep-or-on and launching apps that have a Cast app (Max, Hulu, Peacock, ESPN, Tubi, Pluto TV, Sling, Fubo, Crunchyroll and Apple TV don't, so Hearth says so instead of failing silently). Arrow keys and power live in Google's separate remote protocol, which always requires typing a one-time code shown on the TV. That's coming as an optional *Unlock full remote*.

**About Apple TV.** Hearth uses [pyatv](https://pyatv.dev), the open-source implementation of Apple's own remote protocols, in one small helper process. The first code pairs *Companion* (buttons, power, apps); the second pairs *AirPlay*, which tells Hearth what's playing the moment it changes. iPads, Macs and HomePods also announce themselves on the network; Hearth only lists Apple TVs. Volume buttons go to the TV over HDMI-CEC, so Hearth can't show a level unless the Apple TV plays through HomePods. Without Python, Hearth speaks Companion itself (pure JavaScript, the same code the phone app uses): one code, the full remote, no "what's playing" and no typing into search boxes.

### Commands

| | |
|---|---|
| `npm run up` | Install if needed, start in the background, print the phone link |
| `npm run down` | Stop it |
| `npm start` | Run in the foreground (see logs live) |
| `npm run scan` | List TVs on the network from the terminal |
| `npm run code` | Show the house code (the 6 digits a new phone types once) |
| `npm test` | Run the test suite (no TV needed) |

From a script on the computer running Hearth (it's always in the house): `curl -X POST -H 'content-type: application/json' -d '{"app":"youtubetv","tvs":"all","wake":true}' http://<hearth>:8770/api/launch` opens YouTube TV everywhere and returns a result per TV. `GET /api/catalog` lists the app keys.

Settings via environment: `HEARTH_PORT` (default `8770`), `HEARTH_HOME` (default `~/.hearth`, where your TVs and pairing keys are saved), `HEARTH_VENV` (default `~/.hearth/py`, the Python environment for Apple TV support), `HEARTH_ATV` (`js` or `python` to force one Apple TV client; by default pyatv when its environment exists, else the built-in one), `HEARTH_OPEN=1` (no house code: anyone on the Wi-Fi can use it).

## What your TVs cost

⚙ → **What your TVs cost** (or Health → ⚡). Add your last power bill and Hearth works out your real price per kWh, then what every TV costs a day, a month and a year. Hours come from what the TVs actually did; watts are estimated from each model's screen size and year (type your own off the sticker for exact numbers).

- **The PDF from your electric company:** read on your phone. Only the lines with prices and kWh are sent, and you see them first. Names, addresses, account and meter numbers stay on the phone.
- **A photo of a paper bill:** drag a box around just the charges; only that part is sent.
- Read by Hearth Cloud (free, Gemma on Cloudflare) or your own AI key. Hearth keeps the price per kWh and the bill's totals (`~/.hearth/energy.json`), never the bill. No AI? Tap *Type it*.
- The meter's disc spins as fast as the TVs that are on right now draw power.

## Feels like a real app

- **Pull to refresh** from the top of the house list or a remote: every TV re-reads what it's doing. Coming back to the app after half a minute does the same by itself.
- **Long-press the app icon** (Android, installed): jump to the last remote, Watch, Everything off, or Light Racer.
- The **screen stays on** while a remote is open, even on the plain-http home address (a tiny silent video stands in for the Wake Lock API there).
- **Send with Messages** works without the share sheet, the app icon shows how many TVs are on (where the phone allows badges), and pinch-zoom never kicks in while you're mashing buttons.

## A remote that knows what you're doing

The remote changes with what's on the TV:
- **Something playing:** it becomes the **Stream Center**.
  - Show name, live progress bar, and a big play/pause orb.
  - Tap anywhere to pause. Tap or swipe a side to skip, hold a side to scrub, swipe down to go back.
  - Volume, plus **Browse** for the D-pad.
- **Looking for something to watch:** the D-pad.
- **A web browser:** a trackpad and keyboard.
- **A game or console:** a gamepad.

Roku, LG and Apple TV report whether they're playing. For Samsung and Google TV, Hearth goes by what you pressed: play means watching, arrows mean browsing. You can always switch with the Remote · Watch · Trackpad · Gamepad bar.

## Away from home: Light Racer

When your phone can't reach Hearth (you've left the house, or Wi-Fi is off), the app doesn't show an error. It turns into **Light Racer**, a light-cycle game played on a field of aurora. You eat sparks to grow your wall like a snake and box the other riders in.
- **Controls:** swipe to steer, tap a side to turn, hold to boost. Arrow keys, space and gamepads work too.
- **Coming home:** when Hearth answers again, the remote comes back on its own. If you're mid-race, it waits until the race ends.
- **Any time:** you can play it from Settings → **Play Light Racer**.
- **Offline copy:** [mutaafaziz.com/hearth/racer/](https://mutaafaziz.com/hearth/racer/) is the same game on its own. Add it to your home screen once and it plays with no internet at all.

Over plain `http://` (like `http://azizfamily.local`), browsers don't let a page keep an offline copy of itself. So with the app open or in the background, leaving home switches it to the game. But opening Hearth from the home screen with no connection to home shows the phone's own "can't connect" page. For a guaranteed offline game, add the `/hearth/racer/` link above to the home screen too.

## Troubleshooting

**First, tap Fix.** Every TV has a **Fix connection** button. It's on a card that stops answering, on the remote's "Not responding" banner, in the TV's ⚙ settings, in Health, and as a bulk action. Health also has **Fix every connection**. It checks, in order:

1. Is the TV on the network?
2. If not, wake it with Wake-on-LAN.
3. Still nothing? Look for it at a new address. Routers sometimes move TVs, and Hearth follows them automatically.
4. Reconnect.
5. Check that it answers and still trusts Hearth.
6. If it doesn't trust Hearth any more, the doctor takes you straight to the right pairing step.

**Codes & pairing** in each TV's settings:

- **LG:** pair again with a number on screen (no remote needed), or with Allow.
- **Samsung:** pair again.
- **Google TV:** *Unlock full remote*. Type the 6-character code the TV shows once, and arrows, OK, back, home and power work too.
- **Roku:** nothing to pair.


- **A TV keeps switching itself off (and Hearth loses it).** If it goes dark after the same time again and again (often 15 minutes), a timer on the TV is doing it, not Hearth. Hearth spots the pattern and the remote's banner says *Turns itself off after ~15 min*; tap it for the setting to change. On a Samsung that's Settings → System (General on 2018+) → Eco Solution → **No Signal Power Off** and **Auto Power Off**: Off. A TV that just switched off stays connected: no Fix or re-pairing needed, turn it on and it's back.
- **An older Samsung (2016-17) won't turn on from the phone.** When it's off it leaves the network completely, so nothing can reach it. On the TV: Settings → General → Network → Expert Settings → **Power On with Mobile** (and Samsung Instant On, if it has it). A Roku stick plugged into the TV's USB port dies with it too: give it the wall adapter.
- **"No TVs answered".** Make sure the TV is really on, not in standby, and on the same network as the computer running Hearth. Guest Wi-Fi and some mesh "client isolation" settings block discovery. Add the TV by IP instead (Settings → Network on the TV shows it).
- **Mac: nothing found at all.** macOS may ask to let Terminal/Node "find devices on your local network". Allow it (System Settings → Privacy & Security → Local Network).
- **The pairing prompt never appeared.** On LG, check Settings → General → **LG Connect Apps** is on (or use *Show a number on the TV*). On Samsung, check Settings → General → External Device Manager → **Device Connection Manager**.
- **Roku says no.** Recent Roku OS versions can block network remotes. On the Roku: Settings → System → Advanced system settings → **Control by mobile apps** → Network access → **Default** (or Permissive).
- **Google TV not found.** It's found over Cast, so it must be on the same network as the computer running Hearth (not a guest network). Nothing needs to be switched on in the TV for this. Guest mode isn't needed either.
- **Apple TV says it "needs Python 3 and pyatv".** That's `HEARTH_ATV=python` without Python: install Python 3.10+ (`brew install python` on a Mac) and run `npm run up` again (no restart needed), or drop the setting to use the built-in client.
- **Apple TV has no "what's playing".** It's on the built-in client (no Python). Install Python 3.10+, run `npm run up`, then restart Hearth and pair the Apple TV again for the second code.
- **Apple TV never shows the numbers.** On the Apple TV: Settings → AirPlay and HomeKit → Allow Access → **Anyone on the Same Network**. Type the code within a minute; tap *Show the number again* for a fresh one.
- **Phone can't open the link.** Your phone must be on the same Wi-Fi, and the computer's firewall must allow incoming connections for Node.
- **"Unknown host" (421).** Hearth only answers to local names, which blocks a trick called DNS rebinding. Local names are an IP address on your network, `something.local`, a single word like `mac-mini`, or your friendly address. If you reach it through your own domain name (a reverse proxy, Tailscale MagicDNS), add it: `HEARTH_ALLOWED_HOSTS=hearth.example.ts.net npm run up`.
- **"Reconnecting…" at the top of the app.** The phone lost its live connection to Hearth. It retries by itself, and the buttons it shows may be stale until it's back. If it stays, check that the computer running Hearth is awake.
- **"That's a lot of requests" (429).** Scanning, the connection doctor and AI notes are limited to a few per minute per device. Wait a few seconds.
- **The saved TVs file got damaged** (power cut, disk full). Hearth starts anyway. It restores the last good copy (`~/.hearth/tvs.json.bak`), or keeps the damaged file as `tvs.json.corrupt-<time>` and starts fresh. Scenes work the same way.
- **Logs:** `~/.hearth/hearth.log`. Every line has a time and a level. The log rotates at 5 MB and keeps 3 old copies (`hearth.log.1`–`.3`), and it never contains pairing keys.

## Privacy and security

Hearth talks only to devices on your home network. TV pairing keys are stored in `~/.hearth/tvs.json` (readable only by your user) and are never sent to the browser.

**Only your household's phones can work the TVs.** Being on the Wi-Fi isn't enough: a new phone sees a number pad and types the 6-digit **house code** once, or scans an invite from a phone that's already in (⚙ → Get Hearth on another phone; an invite works for one phone, within a day). To see the code, open ⚙ → **Phones in this house** on any phone that's in, open Hearth on the computer running it (that computer is always in), or run `npm run code`. The same screen lists every phone, lets you rename one, hold to remove one (it's cut off at once), or pick a new code (phones already in stay in). Wrong codes are rate limited, and after 20 wrong codes in an hour typing a code pauses (invites still work). Commands require a JSON request, so a random website can't press buttons on your TV through your browser.

## Make your old smart TVs fast again

See **[docs/TUNEUP.md](docs/TUNEUP.md)** for a practical clean-up guide for 4+-year-old TVs: ads, tracking, bloat, and when to just turn the TV into a plain screen.

## Contributing

Adding a brand (Vizio, Sony…) is one file. See [CLAUDE.md](CLAUDE.md) for the architecture and [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.

MIT licensed.
