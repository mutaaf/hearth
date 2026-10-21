# Tune-up: making a 4-year-old smart TV fast again

Smart TVs slow down for three reasons: **ads and "content discovery" running in the background, tracking (ACR) watching every frame, and apps piling up** on a weak processor. You can fix most of that in 20 minutes per TV. Below that, the best "custom OS" is often a $40 streaming box with the TV used as a plain screen.

Work through the levels in order and stop when the TV feels fast.

---

## Level 1: Settings clean-up (everyone, 10 minutes, fully reversible)

### LG (webOS)
- **Turn off Live Plus / ACR:** Settings → General → System → Additional Settings → *Live Plus* → Off. Also *Home Promotion*, *Content Recommendation* and *Home Auto Launch* → Off.
- **Opt out of viewing information:** Settings → Support → Privacy & Terms → User Agreements → uncheck *Viewing Information*, *Voice Information* and *Interest-Based Recommendations*.
- **Delete apps you never use:** Home → hold an app → *Delete*.
- **Turn off Quick Start+ if the TV is sluggish after waking.** (Trade-off: Wake-on-LAN may need it on.)
- **Clear the cache:** fully power off from the wall for 60 seconds.

### Samsung (Tizen)
- **Turn off Viewing Information Services (ACR):** Settings → Support → Terms & Privacy → Privacy Choices → *Viewing Information Services* → Off. Also *Interest-Based Advertisement* → Off.
- **Turn off autorun:** Settings → General → Smart Features → *Autorun Smart Hub* and *Autorun Last App* → Off.
- **Delete apps:** Home → Apps → ⚙ → select → *Delete*.
- **Self Diagnosis → Reset Smart Hub** (Settings → Support → Device Care) clears years of app clutter. You'll sign into apps again.
- **Device Care → Start Device Care**, then a full power cycle.

## Level 2: Block ads and tracking for the whole house (30 minutes, one time)

Point the TVs' DNS at an ad and tracker blocker. This also speeds up the home screen, because the TV stops waiting on ad servers.

- **Easiest:** [NextDNS](https://nextdns.io) free tier. Set it as DNS on your router, or per TV under Network → Advanced → DNS.
- **Self-hosted:** [Pi-hole](https://pi-hole.net) or AdGuard Home on any always-on machine. It can run next to Hearth.
- Useful blocklists: the "Smart-TV" list from Perflyst/PiHoleBlocklist.

⚠️ Blocking too much can break the TV's app store and firmware updates. Allowlist them when you need them.

## Level 3: Factory reset (when it's still slow)

A reset removes years of cruft. Do Level 1 again straight after, *before* signing into anything.

- LG: Settings → General → System → Reset to Initial Settings.
- Samsung: Settings → General → Reset (PIN `0000`).

Hearth pairing has to be redone after a reset. Use **Pair** on that TV's card.

## Level 4: Homebrew (advanced, LG only, at your own risk)

**LG webOS can often be rooted** with community exploits ([RootMyTV](https://rootmy.tv), and newer ones listed at [webosbrew.org](https://www.webosbrew.org)). That depends entirely on the TV's exact firmware version, and newer updates patch them. Root gives you:
- **Homebrew Channel:** install apps outside LG's store, such as ad-free YouTube (*YouTube AdFree*) or a Jellyfin/Kodi client.
- Startup scripts that disable telemetry and the ad services at the source.
- SSH access, so a future Hearth "Tune-up" button can apply all of the above automatically.

Before trying: Settings → Support → TV Information shows the webOS and firmware version. Check it against webosbrew.org. **Turn off automatic updates first**, or the TV may patch the hole overnight.

**Samsung Tizen cannot be rooted** on 2016+ models. The closest equivalent is Developer Mode plus **TizenBrew**, which sideloads modded apps like **TizenTube** (ad-free YouTube with SponsorBlock).

## Level 5: The "custom OS" that actually works

Neither Samsung nor LG lets you flash your own operating system: the bootloaders are locked and the firmware is signed. The reliable alternative:

1. **Take the TV off the network** (forget the Wi-Fi). It can never update, show ads or track again.
2. **Plug in a cheap box** and make *that* the TV's brain: Google TV Streamer, Onn 4K box, Fire TV Stick, Apple TV, or a Raspberry Pi 5 running [LibreELEC](https://libreelec.tv).
3. **Give the box your own home screen.** On Android/Google TV, install a custom launcher (Projectivy, FLauncher), or the future Hearth launcher (see the roadmap), so every TV in the house looks and works the same.

The TV becomes a fast, dumb panel, and a $30–50 box replaces a processor from 2020.
