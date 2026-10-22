# Backlog: Hearth as a native app (works on any network)

Status: **backlogged** (2026-10-21). First, make the core resilient enough to charge for; see "Road to the App Store" in ROADMAP.md.

## Goal
Install Hearth from the App Store, join any Wi-Fi (home, a friend's house, an Airbnb), and control the TVs there: no home server, no setup beyond "Allow" on the TV the first time.

## Why the web app can't
A web page can't do any of what the house server does for it today:
- **Discovery:** it can't search the network (SSDP/mDNS) for TVs.
- **Connections:** it can't open raw TCP or TLS (Cast :8009, Google remote :6466/6467), and it can't accept a TV's self-signed certificate (LG wss:3001, Samsung wss:8002).
- **Wake:** it can't send Wake-on-LAN.

An installed app can.

## Shape
- **Shared core:** `src/hub.js` and the drivers move behind a transport interface (tcp, tls, ws, udp, http, mdns). Node implements it with net, tls, ws and dgram. The app implements it with native sockets (react-native-tcp-socket with TLS and self-signed certificates allowed, react-native-udp, Bonjour/NSD for mDNS). The same core, the same tests.
- **UI:** the existing `web/` remote inside the app (skins, haptics, launcher, Light Racer). `api()` and `EventSource` are swapped for an in-process bridge, which is the same seam the demo already uses (`window.HearthDemo`).
- **Per-network memory:** TVs and pairing keys are stored per Wi-Fi. At home the app can still use the house server, or take over from it.
- **Brand order:**
  1. Roku: plain HTTP, no pairing.
  2. Samsung 2016-17 (ws:8001).
  3. Google TV over Cast.
  4. LG (wss with a self-signed certificate, plus PIN pairing).
  5. Samsung 2018+.
  6. The Google TV full remote.
  7. Apple TV: pyatv is Python-only, so it needs a JS port of Companion pairing (later).

## iOS realities
- **Local Network permission:** `NSLocalNetworkUsageDescription` plus `NSBonjourServices` for `_googlecast._tcp`, `_androidtvremote2._tcp` and `_airplay._tcp`.
- **Multicast:** SSDP multicast and broadcast Wake-on-LAN need Apple's `com.apple.developer.networking.multicast` entitlement, which needs an application to Apple. Until it's granted:
  - Discover by Bonjour, and by a unicast sweep of the subnet (ports 8060, 8001, 3000/3001, 8009, 7000).
  - Wake-on-LAN goes by unicast to the TV's last known IP.
- **Plain HTTP:** App Transport Security needs `NSAllowsLocalNetworking` for plain HTTP to Roku/Samsung.
- **Networks that won't work:** guest and hotel Wi-Fi with client isolation blocks devices from seeing each other. The app should detect this and say so plainly, instead of showing an empty list.

## Toolchain (this Mac)
- **Starting point:** `~/Desktop/projects/mobile-starter`: Expo SDK 57 / RN 0.86, verified on the iOS simulator and an Android emulator.
- **Xcode:** export `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` per command.
- **Signing:** Apple Development identities are present.
- **App Store:** needs a paid Apple Developer account (TestFlight, review, in-app purchase).

## Monetisation notes
- **Pricing:** paid up front or a one-time "Pro" unlock (StoreKit 2 / Play Billing). Free tier: one TV. Pro: every TV, scenes, schedules, health, the launcher.
- **Privacy:** no account and no cloud. That's the selling point, and it should stay that way.
