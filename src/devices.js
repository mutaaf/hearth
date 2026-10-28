// Device knowledge: brand + model code (+ firmware) → a plain-words guide to
// connecting this exact TV and keeping it reachable. Pure data, no I/O. The
// setup wizard, the connection doctor, the AI fallback and the support queue
// all read the same answer, so wording lives here once.
//
// Menu paths are in the TV's own words and change by year; where a maker
// moved a menu, each era gets its own path. Paths marked "inferred" below
// weren't on a maker's page; keep them conservative.

import { appleTvModel } from './drivers/appletv-models.js';

const WHENS = ['refused', 'no-prompt', 'not-found', 'drops', 'wont-wake', 'auto-off'];
const clean = (s) => String(s ?? '').trim();
const up = (s) => clean(s).toUpperCase().replace(/[\s-]+/g, '');

// ── Samsung ──────────────────────────────────
// Year letter after the size (UN55KU6290, UN43TU7000) or after the QLED/Neo
// series number (QN55Q60A, QN65QN90B). E/F/H were 2012-14 TVs before Tizen.
const SAMSUNG_LETTER = { J: 2015, K: 2016, M: 2017, N: 2018, R: 2019, T: 2020, A: 2021, B: 2022, C: 2023, D: 2024, F: 2025 };
const SAMSUNG_PRE_TIZEN = { E: 2012, F: 2013, H: 2014 };
const TIZEN = { 2015: '2.3', 2016: '2.4', 2017: '3.0', 2018: '4.0', 2019: '5.0', 2020: '5.5', 2021: '6.0', 2022: '6.5', 2023: '7.0', 2024: '8.0', 2025: '9.0' };
// Firmware family names, only used when the model code doesn't decode.
const SAMSUNG_FIRMWARE = [[/T-JZM/, 2016], [/T-KTM2/, 2018], [/T-KTM/, 2017], [/T-MSM/, 2019]];

function decodeSamsung(raw, firmware) {
  const m = up(raw);
  let year = null;
  let line = 'smart TV';
  let series = null;
  let x;
  if ((x = m.match(/^(?:UN|UE|UA|GU|HG)\d{2}([EFH])\d/))) {
    year = SAMSUNG_PRE_TIZEN[x[1]];
    series = `${x[1]} series`;
  } else if ((x = m.match(/^(?:UN|UE|UA|GU)\d{2}U\d{4}([A-Z])/)) && x[1] === 'F') {
    // 2025 Crystal UHD moved the letter to the end: UN55U8000F.
    year = 2025;
    series = `U${m.slice(5, 9)}F`;
    line = 'Crystal UHD';
  } else if ((x = m.match(/^(?:QN|QE|GQ|QA)\d{2}(LS\d{2})([A-Z])/))) {
    year = SAMSUNG_LETTER[x[2]] ?? null;
    line = 'The Frame / Lifestyle TV';
    series = x[1] + x[2];
  } else if ((x = m.match(/^(?:QN|QE|GQ|QA)\d{2}(S9\d)([A-Z])/))) {
    year = SAMSUNG_LETTER[x[2]] ?? null;
    line = 'OLED';
    series = x[1] + x[2];
  } else if ((x = m.match(/^(?:QN|QE|GQ|QA)\d{2}(QN\d{2,3})([A-Z])/))) {
    year = SAMSUNG_LETTER[x[2]] ?? null;
    line = 'Neo QLED';
    series = x[1] + x[2];
  } else if ((x = m.match(/^(?:QN|QE|GQ|QA)\d{2}(Q\d{2,3})([A-Z])/))) {
    year = SAMSUNG_LETTER[x[2]] ?? null;
    line = 'QLED';
    series = x[1] + x[2];
  } else if ((x = m.match(/^(?:QN|QE|GQ|QA)\d{2}(Q\d)([FC]?)(A?)([A-Z]?)/))) {
    // One-digit QLEDs: Q7FAM = 2017, Q7FN = 2018, Q7F (no year letter) = 2025.
    line = 'QLED';
    year = x[3] && x[4] === 'M' ? 2017 : x[4] === 'N' ? 2018 : x[2] === 'F' ? 2025 : null;
    series = x[1] + x[2];
  } else if ((x = m.match(/^(?:UN|UE|UA|GU|HG)\d{2}([A-Z])([A-Z]{0,2}\d{3,4})/))) {
    year = SAMSUNG_LETTER[x[1]] ?? null;
    series = x[1] + x[2];
    line = /^[A-Z]U/.test(x[1] + x[2]) && year >= 2020 ? 'Crystal UHD' : /^[A-Z]S/.test(x[1] + x[2]) ? 'SUHD' : 'smart TV';
  } else if ((x = m.match(/^(1[5-9]|2\d)_[A-Z]/))) {
    // REST's internal model name, e.g. 16_JAZZM_UHD.
    year = 2000 + Number(x[1]);
  }
  if (!year) {
    const fw = SAMSUNG_FIRMWARE.find(([re]) => re.test(up(firmware)));
    if (fw) year = fw[1];
  }
  if (!year) return { known: false, family: 'Samsung smart TV', year: null, os: osFromFirmware('samsung', firmware) ?? 'Tizen' };
  const tizen = year >= 2015 ? `Tizen${TIZEN[year] ? ` ${TIZEN[year]}` : ''}` : 'Orsay (pre-Tizen)';
  const letter = Object.entries(SAMSUNG_LETTER).find(([, y]) => y === year)?.[0];
  const label = series && line !== 'smart TV' ? series : letter && year >= 2015 ? `${letter} series` : series ?? 'model';
  const family = `Samsung ${year} ${line} (${label}, ${year >= 2015 ? 'Tizen' : 'not Tizen'})`;
  return { known: true, family, year, os: osFromFirmware('samsung', firmware) ?? tizen };
}

// Samsung menus moved twice: 2018 (Eco Solution under General) and 2022
// (Network and External Device Manager under a top-level Connection menu).
function samsungMenus(year) {
  const y = year ?? 2022;
  const top = y >= 2022 ? 'Settings → All Settings → Connection' : 'Settings → General';
  return {
    powerOnMobile: `${top} → Network → Expert Settings → Power On with Mobile: On`,
    ipRemote: `${top} → Network → Expert Settings → IP Remote: Enable`,
    dcm: `${top} → External Device Manager → Device Connection Manager`,
    anynet: `${top} → External Device Manager → Anynet+ (HDMI-CEC): On`,
    status: `${top} → Network → Network Status`,
    autoOff:
      y >= 2023 ? 'Settings → All Settings → General & Privacy → Power and Energy Saving → Auto Power Off: Off'
      : y >= 2022 ? 'Settings → All Settings → General → Power and Energy Saving → Auto Power Off: Off'
      : y >= 2018 ? 'Settings → General → Eco Solution → Auto Power Off: Off, and No Signal Power Off: Off'
      : 'Settings → System → Eco Solution → Auto Power Off: Off, and No Signal Power Off: Off',
  };
}

function samsungGuide({ known, year }) {
  const menu = samsungMenus(year);
  const legacy = year === 2016 || year === 2017; // ws:8001, no token, no prompt
  const preTizen = year != null && year < 2016;
  const quirks = [];
  let connect;
  if (preTizen) {
    connect = {
      how: 'pin',
      summary: 'Hearth can’t control this TV: Samsungs from before 2016 use an older, locked remote system.',
      before: [],
      onTv: 'Nothing that Hearth can use. A streaming stick in an HDMI port is the easy fix.',
    };
    quirks.push('Hearth works with Samsung TVs from 2016 on. Older sets use a different remote protocol (some show a PIN) that Hearth doesn’t speak.');
  } else if (legacy) {
    connect = {
      how: 'none',
      summary: 'This TV connects by itself: no Allow box, nothing to press.',
      before: [],
      onTv: null,
    };
    quirks.push('2016-17 Samsungs have no power-state API: Hearth guesses on or standby from which of its doors are open.');
    quirks.push('2016-17 Samsungs give no pairing key, so there is nothing to forget or re-pair.');
    quirks.push('About a minute after you switch it off, it drops off the network and stays silent until switched on.');
    quirks.push('Power is a toggle: tap it once, like the TV’s own remote.');
  } else if (!known) {
    connect = {
      how: 'allow',
      summary: 'Most Samsungs ask once: press Allow with the TV remote. 2016-17 models connect with nothing to press.',
      before: [],
      onTv: 'A box saying a device wants to connect, with Allow and Deny. Press Allow.',
    };
  } else {
    connect = {
      how: 'allow',
      summary: 'The TV asks once: press Allow with the TV remote.',
      before: [],
      onTv: 'A box saying a device wants to connect, with Allow and Deny. Press Allow.',
    };
    quirks.push('2018 and newer Samsungs hand Hearth a key after you press Allow; the TV remembers it.');
  }
  if (!preTizen) quirks.push('Samsung over the network can’t say what’s playing, only which app is open.');

  // 2016 sets have no Power On with Mobile and leave the network ~45 s after
  // switching off (probed on the UN55KU6290, 2026-10-21): nothing on the
  // network can wake them. A box on HDMI with CEC can.
  const noWake = year === 2016;
  const keepReachable = noWake
    ? [{ title: 'Anynet+ (HDMI-CEC)', wake: false, path: `2016 Samsungs don’t have Power On with Mobile, and they leave the Wi-Fi about a minute after switching off, so no phone can turn them on. Plug a Roku or Apple TV into it, turn on ${menu.anynet}, and then in Hearth open TV settings → Turn on from your phone: the TV comes on with the box.` }]
    : [{ title: 'Power On with Mobile', path: menu.powerOnMobile + (legacy ? ' (if your TV has it)' : '') }];
  if (year == null || year >= 2020) keepReachable.push({ title: 'IP Remote', path: `${menu.ipRemote} (if your TV has it)` });
  if (legacy && !noWake) keepReachable.push({ title: 'Network cable', path: 'Plug in a network cable if you can: 2016-17 sets wake from the phone far more reliably on a cable than on Wi-Fi.' });

  const troubleshoot = [
    legacy
      ? { when: 'refused', fix: `Open ${menu.dcm} → Device List. If Hearth is there as Deny, change it to Allow. Then switch the TV off and on at the wall.` }
      : { when: 'refused', fix: `Someone pressed Deny, so the TV now blocks Hearth. Open ${menu.dcm} → Device List, pick Hearth and change it to Allow (or delete it and connect again).` },
    legacy
      ? { when: 'no-prompt', fix: 'This TV never shows an Allow box; it should just connect. Make sure it’s on and showing a picture, then try again.' }
      : { when: 'no-prompt', fix: `Turn the TV on and leave it on a normal screen, then try again. If still nothing, open ${menu.dcm} → Access Notification and set it to First Time Only.` },
    { when: 'not-found', fix: `Turn the TV on with its own remote and check it’s on the same Wi-Fi as your phone: ${menu.status}.` },
    { when: 'drops', fix: 'Give the TV a fixed address in your router (a DHCP reservation), or plug in a network cable.' },
    noWake
      ? { when: 'wont-wake', fix: `2016 Samsungs can’t be woken over the network: they leave it about a minute after switching off. Use the TV remote, or a streaming box on HDMI with ${menu.anynet} (then TV settings → Turn on from your phone, in Hearth).` }
      : legacy
      ? { when: 'wont-wake', fix: `This set leaves the network about a minute after it’s switched off, so the phone often can’t reach it. Try ${menu.powerOnMobile} if it’s listed, and a network cable; otherwise use the TV remote to switch it on.` }
      : { when: 'wont-wake', fix: `Switch on ${menu.powerOnMobile}. A network cable makes waking more reliable than Wi-Fi.` },
    { when: 'auto-off', fix: `${menu.autoOff}. Also check the Sleep Timer is off.` },
  ];
  return { connect, keepReachable, troubleshoot, quirks };
}

// ── LG ───────────────────────────────────────
// OLED: OLED55C2PUA → the digit (or X) after the series letter. LCD: the
// two-letter series after the size (55UP7000PUA), or after NANO/QNED.
const LG_SERIES = { UH: 2016, UJ: 2017, SJ: 2017, UK: 2018, SK: 2018, UM: 2019, SM: 2019, UN: 2020, UP: 2021, UQ: 2022, UR: 2023, UT: 2024, UA: 2025 };
const LG_OLED = { 6: 2016, 7: 2017, 8: 2018, 9: 2019, X: 2020, 1: 2021, 2: 2022, 3: 2023, 4: 2024, 5: 2025 };
const WEBOS = { 2014: 'webOS 1.0', 2015: 'webOS 2.0', 2016: 'webOS 3.0', 2017: 'webOS 3.5', 2018: 'webOS 4.0', 2019: 'webOS 4.5', 2020: 'webOS 5.0', 2021: 'webOS 6.0' };
const webosFor = (year) => WEBOS[year] ?? (year >= 2022 ? `webOS ${year - 2000}` : null);

// Firmware → year. Accepts "webOS 6.0", "webOSTV 23" or the platform number
// (webOS 22 reports 7.x, 23 → 8.x, 24 → 9.x, 25 → 10.x).
function webosYear(firmware) {
  const x = clean(firmware).match(/web\s?os(?:\s?tv)?\s*(\d+(?:\.\d+)?)/i);
  if (!x) return null;
  const v = Number(x[1]);
  if (v >= 22) return 2000 + Math.floor(v);
  if (v >= 7 && v < 11) return 2015 + Math.floor(v);
  return { 1: 2014, 2: 2015, 3: 2016, 3.5: 2017, 4: 2018, 4.5: 2019, 5: 2020, 6: 2021 }[v] ?? null;
}

function decodeLg(raw, firmware) {
  const m = up(raw);
  let year = null;
  let family = null;
  let x;
  if ((x = m.match(/^OLED(\d{2,3})([A-Z]{1,2})([0-9X])([A-Z0-9]*)/))) {
    year = LG_OLED[x[3]] ?? null;
    // '6' is both 2016 (OLED55C6P, one-letter suffix) and 2026 (longer suffix).
    if (x[3] === '6' && x[4].length > 1) year = 2026;
    family = year && ((y) => `LG ${y} OLED (${x[2]}${x[3]}, ${webosFor(y)})`);
  } else if ((x = m.match(/^\d{2}(NANO|QNED)(\d{2,3})([A-Z])([A-Z])/))) {
    const kind = x[1] === 'NANO' ? 'NanoCell' : 'QNED';
    // 2020-23 put U first (UN/UP/UQ/UR); 2024-25 moved the year letter first (TU, AU).
    year = x[3] === 'U' ? LG_SERIES[`U${x[4]}`] ?? null : x[4] === 'U' ? { T: 2024, A: 2025 }[x[3]] ?? null : null;
    family = year && ((y) => `LG ${y} ${kind} (${x[1]}${x[2]}, ${webosFor(y)})`);
  } else if ((x = m.match(/^\d{2}([US][A-Z])(\d{3,4})/))) {
    year = LG_SERIES[x[1]] ?? null;
    const kind = x[1] === 'SM' ? 'NanoCell' : x[1][0] === 'S' ? 'Super UHD' : '4K UHD';
    family = year && ((y) => `LG ${y} ${kind} (${x[1]}${x[2]}, ${webosFor(y)})`);
  }
  const fwYear = webosYear(firmware);
  if (!year && fwYear) {
    year = fwYear;
    family = (y) => `LG ${y} smart TV (${webosFor(y)})`;
  }
  if (!year) return { known: false, family: 'LG smart TV (webOS)', year: null, os: fwYear ? webosFor(fwYear) : 'webOS' };
  return { known: true, family: family(year), year, os: webosFor(year) };
}

// LG paths from LG's help library, per webOS version. 2024+ follow webOS 23.
function lgMenus(year) {
  const y = year ?? 2023;
  const wifiOn =
    y >= 2023 ? 'Settings → All Settings → General → External Devices → TV On With Mobile → Turn on via Wi-Fi: On'
    : y >= 2021 ? 'Settings → All Settings → General → Devices → External Devices → TV On With Mobile → Turn on via Wi-Fi: On'
    : y === 2020 ? 'Settings → All Settings → Connection → Mobile Connection Management → TV On With Mobile → Turn on via Wi-Fi: On'
    : y === 2019 ? 'Settings → All Settings → Connection → Mobile TV On → Turn on via Wi-Fi: On'
    : 'Settings → All Settings → General → Mobile TV On → Turn on via Wi-Fi: On';
  const quickStart =
    y >= 2023 ? 'Settings → All Settings → General → System → Additional Settings → Quick Start+: On'
    : y >= 2021 ? 'Settings → All Settings → General → Devices → TV Management → Quick Start+: On'
    : y >= 2019 ? 'Settings → All Settings → General → Additional Settings → Quick Start+: On'
    : 'Settings → All Settings → General → Quick Start+: On';
  // LG Connect Apps was a switch until webOS 4.x; later sets have no switch.
  const connectApps = y <= 2018 ? 'Settings → All Settings → Network → LG Connect Apps: On' : y === 2019 ? 'Settings → All Settings → Connection → LG Connect Apps: On' : null;
  const network = y >= 2021 ? 'Settings → All Settings → General → Network' : y === 2020 ? 'Settings → All Settings → Connection → Network Connection Settings' : y === 2019 ? 'Settings → All Settings → Connection' : 'Settings → All Settings → Network';
  return { wifiOn, quickStart, connectApps, network };
}

function lgGuide({ year }) {
  const menu = lgMenus(year);
  const before = year && menu.connectApps ? [menu.connectApps] : [];
  const connect = {
    how: 'allow-or-pin',
    summary: 'The TV asks once: press Allow with the TV remote, or choose “Show a number” and type the number the TV shows.',
    before,
    onTv: 'A box asking to allow a connection (press Allow), or a number to type into Hearth.',
  };
  const keepReachable = [
    { title: 'Turn on via Wi-Fi', path: menu.wifiOn },
    { title: 'Quick Start+', path: menu.quickStart },
  ];
  const quirks = [
    'Once connected, Hearth switches on “Turn on via Wi-Fi” by itself if it was off.',
    'The number option is handy when nobody can reach the TV remote to press Allow.',
  ];
  if (year == null || year >= 2023) quirks.push('LG TVs from 2023 on only take secure connections; Hearth handles that.');
  if (year != null && year <= 2018) quirks.push('Without LG Connect Apps switched on, this TV ignores phones.');
  const noPrompt = menu.connectApps && year
    ? `Check ${menu.connectApps}. Then turn the TV on, leave it on a normal screen and try again, or choose “Show a number” instead.`
    : 'Turn the TV on and leave it on a normal screen, then try again. Or choose “Show a number” and type the number the TV shows.';
  const troubleshoot = [
    { when: 'refused', fix: 'Someone pressed Decline, or the TV forgot Hearth. Connect again and press Allow, or choose “Show a number” and type it in.' },
    { when: 'no-prompt', fix: noPrompt },
    { when: 'not-found', fix: `Turn the TV on and check it’s on the same Wi-Fi as your phone: ${menu.network}. Quick Start+ keeps it findable while it sleeps: ${menu.quickStart}.` },
    { when: 'drops', fix: `Switch on ${menu.quickStart}, and give the TV a fixed address in your router (a DHCP reservation).` },
    { when: 'wont-wake', fix: `Switch on ${menu.wifiOn}, and ${menu.quickStart}. Waking needs the TV plugged in and on the same network.` },
    { when: 'auto-off', fix: 'Settings → All Settings → General → Eco Mode (Energy Saving on older TVs) → Auto Power Off: Off. Also check Time & Timer → Sleep Timer: Off.' },
  ];
  return { connect, keepReachable, troubleshoot, quirks };
}

// ── Roku ─────────────────────────────────────
// Player model numbers from Roku's developer hardware table. R/X/EU and a
// trailing 2 are regional or revision variants of the same box.
const ROKU_PLAYERS = {
  3600: ['Roku Streaming Stick', 2016], 3700: ['Roku Express', 2016], 3710: ['Roku Express+', 2016],
  3800: ['Roku Streaming Stick', 2017], 3810: ['Roku Streaming Stick+', 2019], 3811: ['Roku Streaming Stick+', 2019],
  3820: ['Roku Streaming Stick 4K', 2021], 3821: ['Roku Streaming Stick 4K+', 2021],
  3830: ['Roku Streaming Stick Plus', 2025], 3840: ['Roku Streaming Stick', 2025],
  3900: ['Roku Express', 2019], 3910: ['Roku Express+', 2019], 3920: ['Roku Premiere', 2019], 3921: ['Roku Premiere+', 2019],
  3930: ['Roku Express', 2019], 3931: ['Roku Express+', 2019], 3940: ['Roku Express 4K', 2021], 3941: ['Roku Express 4K+', 2021],
  3942: ['Roku Express 4K+', 2022], 3960: ['Roku Express', 2022],
  4620: ['Roku Premiere', 2016], 4630: ['Roku Premiere+', 2016], 4640: ['Roku Ultra', 2016], 4660: ['Roku Ultra', 2017],
  4662: ['Roku Ultra LT', 2017], 4670: ['Roku Ultra', 2019], 4800: ['Roku Ultra', 2021], 4850: ['Roku Ultra', 2024],
  9100: ['Roku Smart Soundbar', 2019], 9102: ['Roku Streambar', 2020], 9104: ['Roku Streambar SE', 2024],
};
const ROKU_TV_MAKERS = ['TCL', 'Hisense', 'onn', 'Sharp', 'Insignia', 'Element', 'Philips', 'Westinghouse', 'JVC', 'RCA', 'Hitachi', 'Sanyo', 'Pioneer', 'Magnavox', 'Polaroid', 'Haier', 'Roku'];

function decodeRoku(raw, firmware) {
  const s = clean(raw);
  const os = osFromFirmware('roku', firmware) ?? 'Roku OS';
  const num = s.match(/\b(\d{4})(?:X\d?|R|EU|X?2)?\b/)?.[1];
  const player = num && ROKU_PLAYERS[num];
  if (player) return { known: true, family: player[0], year: player[1], os, tv: false };
  // Roku TVs: "TCL•Roku TV 7105X", or a model number in a TV family (5xxx-8xxx, or a letter + digits).
  const isTv = /roku\s*tv/i.test(s) || /\b[5-8]\d{3}X\b/i.test(s) || /\b[A-HJ-PT]\d{3}X\b/.test(s);
  if (isTv) {
    const maker = ROKU_TV_MAKERS.find((mk) => new RegExp(`\\b${mk}\\b`, 'i').test(s.replace(/[•·]/g, ' ')));
    return { known: true, family: maker && maker !== 'Roku' ? `${maker} Roku TV` : 'Roku TV', year: null, os, tv: true };
  }
  return { known: false, family: 'Roku', year: null, os, tv: null };
}

const ROKU_MOBILE = 'Settings → System → Advanced system settings → Control by mobile apps: Enabled (older Rokus: Network access → Default)';

function rokuGuide({ tv }) {
  const connect = {
    how: 'none',
    summary: 'Nothing to press: a Roku lets apps on your Wi-Fi control it.',
    before: [],
    onTv: null,
  };
  const keepReachable = [{ title: 'Control by mobile apps', path: ROKU_MOBILE }];
  if (tv !== false) keepReachable.push({ title: 'Fast TV start', path: 'Settings → System → Power → Fast TV start: On (Roku TVs only)' });
  if (tv !== true) {
    keepReachable.push({ title: 'Wall power', path: 'Plug the Roku’s power into a wall socket, not the TV’s USB port, so it stays awake when the TV sleeps.' });
    keepReachable.push({ title: '1-touch play', path: 'Settings → System → Control other devices (CEC) → 1-touch play: On, so waking the Roku turns the TV on too.' });
  }
  const wake = tv === true
    ? 'Switch on Settings → System → Power → Fast TV start. Without it, a Roku TV fully sleeps and can’t hear the phone.'
    : tv === false
      ? 'Plug the Roku into a wall socket, not the TV’s USB port. Then switch on Settings → System → Control other devices (CEC) → 1-touch play so the TV turns on with it.'
      : 'Roku TV: switch on Settings → System → Power → Fast TV start. Roku stick or box: power it from a wall socket, not the TV’s USB port.';
  const troubleshoot = [
    { when: 'refused', fix: `The Roku is set to block apps. On the Roku: ${ROKU_MOBILE}. Avoid Limited and Disabled.` },
    { when: 'no-prompt', fix: 'A Roku never shows a box; there’s nothing to press. If Hearth says it’s blocked, follow the fix for “said no”.' },
    { when: 'not-found', fix: 'Turn the Roku on and check it’s on the same Wi-Fi as your phone: Settings → Network → About.' },
    { when: 'drops', fix: 'Check the signal in Settings → Network → Check connection. Give the Roku a fixed address in your router, or use a network cable if it has a port.' },
    { when: 'wont-wake', fix: wake },
    {
      when: 'auto-off',
      fix: tv === false
        ? 'A Roku stick or box doesn’t switch the TV off itself. Look in the TV’s own settings for Auto Power Off or a Sleep Timer.'
        : 'Settings → System → Power → Auto power savings: Off. Also check Settings → System → Time → Sleep timer: Off.',
    },
  ];
  const quirks = [
    'Rokus need no pairing: any app on the same Wi-Fi may send buttons, unless Control by mobile apps is limited.',
    'A Roku can say what’s playing, how far in, and which app is open.',
  ];
  if (tv !== true) quirks.push('A Roku stick can’t be woken over Wi-Fi when it has no power; from standby it wakes fine.');
  return { connect, keepReachable, troubleshoot, quirks };
}

// ── Google TV / Android TV ───────────────────
const GOOGLE_MAKERS = ['TCL', 'Hisense', 'Sony', 'Philips', 'Sharp', 'Toshiba', 'Xiaomi', 'Skyworth', 'Panasonic', 'Vizio', 'Onn', 'Walmart', 'Thomson', 'Nokia'];

function decodeGoogle(raw, firmware) {
  const s = clean(raw);
  const fwOs = osFromFirmware('androidtv', firmware);
  if (/streamer/i.test(s)) return { known: true, family: 'Google TV Streamer', year: 2024, os: 'Google TV' };
  if (/chromecast/i.test(s)) {
    return /\bHD\b/i.test(s)
      ? { known: true, family: 'Chromecast with Google TV (HD)', year: 2022, os: 'Google TV' }
      : { known: true, family: 'Chromecast with Google TV (4K)', year: 2020, os: 'Google TV' };
  }
  if (/shield/i.test(s)) return { known: true, family: 'NVIDIA SHIELD (Android TV)', year: null, os: fwOs ?? 'Android TV' };
  const maker = GOOGLE_MAKERS.find((mk) => new RegExp(`\\b${mk}\\b`, 'i').test(s)) ?? (/\bBRAVIA\b/i.test(s) ? 'Sony' : null);
  if (maker) return { known: true, family: `${maker} Google TV`, year: null, os: fwOs ?? 'Google TV' };
  return { known: false, family: /android/i.test(s) ? 'Android TV' : 'Google TV', year: null, os: fwOs ?? (/android/i.test(s) ? 'Android TV' : 'Google TV') };
}

function googleGuide({ family }) {
  const stick = /Chromecast|Streamer|SHIELD/.test(family);
  const energy = 'Settings → System → Power & energy → Energy mode: Optimized or Increased (not Low), so the TV still answers while it sleeps.';
  const connect = {
    how: 'code',
    summary: 'Volume, mute and apps work straight away; for the arrow keys, the TV shows a code once and you type it into Hearth.',
    before: [],
    onTv: 'A short code of letters and numbers. Type it into Hearth.',
  };
  const keepReachable = [{ title: 'Energy mode', path: energy }];
  if (stick) keepReachable.push({ title: 'Wall power', path: 'Power it from a wall socket with its own plug, not the TV’s USB port.' });
  const troubleshoot = [
    { when: 'refused', fix: 'The code was wrong or too old, or the TV forgot Hearth. Tap “Show a new code” and type the new one.' },
    { when: 'no-prompt', fix: 'The code only shows while the TV is on. Wake it, press Home on its remote, then ask Hearth for a new code.' },
    { when: 'not-found', fix: `Turn it on and check it’s on the same Wi-Fi as your phone (Settings → Network & Internet). If it vanishes when asleep: ${energy}` },
    { when: 'drops', fix: 'Give it a fixed address in your router (a DHCP reservation), or use a network cable. If it vanishes at night, set the energy mode above.' },
    { when: 'wont-wake', fix: 'Google TVs can’t be switched on over the local network. Use its own remote; Hearth can turn the volume, open apps and more once it’s on.' },
    { when: 'auto-off', fix: 'Settings → System → Power & energy → When inactive (or Turn off display): Never.' },
  ];
  const quirks = [
    'Google TVs can’t be switched on from the phone, only off-and-on from their own remote.',
    'Hearth’s volume moves the TV’s own volume.',
    'A few streaming apps use their own system on Google TV, so Hearth may not be able to open them directly.',
    'A sleeping Google TV still answers on the network and says it’s in standby.',
  ];
  return { connect, keepReachable, troubleshoot, quirks };
}

// ── Apple TV ─────────────────────────────────
const APPLE_TV = { 'AppleTV2,1': 2010, 'AppleTV3,1': 2012, 'AppleTV3,2': 2013, 'AppleTV5,3': 2015, 'AppleTV6,2': 2017, 'AppleTV11,1': 2021, 'AppleTV14,1': 2022 };

function decodeApple(raw, firmware) {
  const s = clean(raw);
  const norm = (x) => x.toLowerCase().replace(/^apple\s*tv\s*/, '').replace(/generation/, 'gen').replace(/[^a-z0-9]/g, '');
  const id = Object.keys(APPLE_TV).find((k) => k.toLowerCase() === s.toLowerCase().replace(/\s+/g, '')) ??
    Object.keys(APPLE_TV).find((k) => norm(appleTvModel(k)) === norm(s));
  const fw = osFromFirmware('appletv', firmware);
  if (!id) return { known: false, family: 'Apple TV', year: null, os: fw ?? 'tvOS', old: false };
  const old = APPLE_TV[id] < 2015;
  return { known: true, family: `Apple TV ${appleTvModel(id)}`, year: APPLE_TV[id], os: old ? 'Apple TV Software' : fw ?? 'tvOS', old };
}

function appleGuide({ old }) {
  const allow = 'Settings → AirPlay and HomeKit → Allow Access: Everyone on the Same Network';
  const connect = old
    ? { how: 'pin', summary: 'Hearth can’t control this Apple TV: models before the Apple TV HD don’t run tvOS.', before: [], onTv: 'Nothing that Hearth can use.' }
    : { how: 'pin', summary: 'The Apple TV shows a 4-digit code twice; type each one into Hearth.', before: [], onTv: 'A 4-digit code, then a second 4-digit code. Type each into Hearth.' };
  const keepReachable = [
    { title: 'Control TVs and Receivers', path: 'Settings → Remotes and Devices → Control TVs and Receivers: On, so waking the Apple TV turns the TV on too.' },
    { title: 'AirPlay access', path: allow },
  ];
  const troubleshoot = [
    { when: 'refused', fix: 'The code was wrong or too old. Ask Hearth for the code again and type the new one. If it keeps failing, remove Hearth in Settings → Remotes and Devices → Remote App and Devices, then connect again.' },
    { when: 'no-prompt', fix: `Wake the Apple TV with its remote and stay on the Home screen, then ask again. If the second code never shows: ${allow}.` },
    { when: 'not-found', fix: 'Wake it with its remote and check it’s on the same Wi-Fi as your phone: Settings → Network.' },
    { when: 'drops', fix: 'Use a network cable if you can, or give it a fixed address in your router (a DHCP reservation).' },
    { when: 'wont-wake', fix: 'Connect it in Hearth with both codes: a connected Apple TV wakes over the network. For the TV to come on with it: Settings → Remotes and Devices → Control TVs and Receivers: On.' },
    { when: 'auto-off', fix: 'Settings → General → Sleep After: Never (or a longer time).' },
  ];
  const quirks = old
    ? ['Apple TV 2nd and 3rd gen run older software that Hearth’s remote system doesn’t support.']
    : [
        'The first code unlocks the remote; the second shows what’s playing. The remote works after the first.',
        'Apple TVs wake over the network once connected, not with Wake-on-LAN.',
        'Hearth needs Python on the computer that runs it to talk to Apple TVs.',
      ];
  return { connect, keepReachable, troubleshoot, quirks };
}

// ── Firmware → OS label ──────────────────────
function osFromFirmware(brand, firmware) {
  const f = clean(firmware);
  if (!f) return null;
  let x;
  if (brand === 'samsung' && (x = f.match(/tizen\s*(\d+(?:\.\d+)?)/i))) return `Tizen ${x[1]}`;
  if (brand === 'roku' && (x = f.match(/^(?:roku\s*os\s*)?(\d+\.\d+)/i))) return `Roku OS ${x[1]}`;
  if (brand === 'appletv' && (x = f.match(/^(?:tvos\s*)?(\d+(?:\.\d+)*)/i))) return `tvOS ${x[1]}`;
  if (brand === 'androidtv' && (x = f.match(/android\s*(?:tv\s*)?(\d+)/i))) return `Android TV ${x[1]}`;
  return null;
}

// ── Public ───────────────────────────────────
const ALIASES = { lg: 'lg', samsung: 'samsung', roku: 'roku', androidtv: 'androidtv', googletv: 'androidtv', google: 'androidtv', android: 'androidtv', appletv: 'appletv', apple: 'appletv' };
const BRANDS = {
  samsung: [decodeSamsung, samsungGuide],
  lg: [decodeLg, lgGuide],
  roku: [decodeRoku, rokuGuide],
  androidtv: [decodeGoogle, googleGuide],
  appletv: [decodeApple, appleGuide],
};

export function deviceGuide({ brand, model = '', firmware = '' } = {}) {
  const b = ALIASES[String(brand ?? '').toLowerCase().replace(/[\s_-]+/g, '')];
  if (!b) throw new TypeError(`Unknown brand: ${brand}`);
  const [decode, guide] = BRANDS[b];
  const info = decode(model, firmware);
  const g = guide(info);
  const order = (list) => [...list].sort((p, q) => WHENS.indexOf(p.when) - WHENS.indexOf(q.when));
  return {
    brand: b,
    model: clean(model),
    known: info.known,
    family: info.family,
    year: info.year,
    os: info.os,
    connect: g.connect,
    keepReachable: g.keepReachable,
    troubleshoot: order(g.troubleshoot),
    quirks: g.quirks,
  };
}
