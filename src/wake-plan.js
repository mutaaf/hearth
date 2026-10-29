// "Turn on from your phone": how this TV can be woken, in plain words, with
// the exact settings for this model. The wake coach (web/wake.js) walks a
// person through it and tests it live; nobody has to know what Wake-on-LAN
// or HDMI-CEC are.
//
//   network: the TV wakes itself over the Wi-Fi (Wake-on-LAN / standby)
//   box:     a Roku or Apple TV on one of its HDMI ports turns it on (CEC)
//   remote:  nothing can; its own remote it is

import { deviceGuide } from './devices.js';
import { canBroadcast } from './wol.js';

export const WAKE_BOXES = new Set(['roku', 'appletv']);

// What each TV brand calls HDMI-CEC, and where it lives.
const CEC_ON_TV = {
  samsung: (year) => ({
    title: 'Anynet+ (HDMI-CEC)',
    path: `${year >= 2022 ? 'Settings → All Settings → Connection' : 'Settings → General'} → External Device Manager → Anynet+ (HDMI-CEC): On`,
  }),
  lg: (year) => ({
    title: 'SIMPLINK (HDMI-CEC)',
    path: year >= 2021 ? 'Settings → General → Devices → HDMI Settings → SIMPLINK (HDMI-CEC): On' : 'Settings → General → SIMPLINK (HDMI-CEC): On',
  }),
  androidtv: () => ({ title: 'HDMI-CEC', path: 'Settings → Channels & Inputs (or Display & Sound) → HDMI-CEC: On. Sony calls it BRAVIA Sync; TCL calls it T-Link.' }),
};
const CEC_ON_BOX = {
  roku: [
    { title: '1-touch play', path: 'On the Roku: Settings → System → Control other devices (CEC) → 1-touch play: On' },
    { title: 'Wall power', path: 'Plug the Roku’s power into a wall socket, not the TV’s USB port, so it’s awake when the TV is off.' },
  ],
  appletv: [{ title: 'Control TVs', path: 'On the Apple TV: Settings → Remotes and Devices → Control TVs and Receivers: On' }],
};

const cut = (s) => String(s ?? '').replace(/: On$/, '');

// view: hub.view(tv); all: hub.list(). → the plan the coach shows.
// broadcast: can this machine send Wake-on-LAN at all (wol.js).
export function wakePlan(view, all = [], { broadcast = canBroadcast() } = {}) {
  const guide = deviceGuide({ brand: view.brand, model: view.model });
  const name = view.name || 'This TV';
  const boxes = all.filter((b) => b.id !== view.id && b.paired && WAKE_BOXES.has(b.brand)).map((b) => ({ id: b.id, name: b.name, brand: b.brand, room: b.room ?? '' }));
  const isBox = WAKE_BOXES.has(view.brand);
  const noNetwork = (guide.keepReachable ?? []).some((k) => k.wake === false);

  // ── over the Wi-Fi ──
  let network;
  if (view.brand === 'androidtv') {
    network = { possible: false, why: 'Google TVs only turn on from their own remote or Google Home, not from other apps.' };
  } else if (noNetwork) {
    network = { possible: false, why: `${guide.year ? `Samsungs from ${guide.year}` : 'This TV'} leave the Wi-Fi about a minute after switching off, so nothing on the network can reach them.` };
  } else if (broadcast === false && (view.brand === 'lg' || view.brand === 'samsung')) {
    network = { possible: false, blocked: true, why: 'Your iPhone can’t send the wake-up signal over the Wi-Fi yet: Apple has to allow it for Hearth, and an update will switch it on.' };
  } else if (view.brand === 'appletv') {
    network = { possible: Boolean(view.paired), auto: true, why: 'A connected Apple TV wakes over the network by itself.', steps: [] };
  } else if (!view.canWake && view.brand !== 'roku') {
    network = { possible: false, why: 'Hearth hasn’t learnt its network address yet. Turn it on once with its own remote while Hearth is open.' };
  } else {
    const steps = (guide.keepReachable ?? []).filter((k) => k.wake !== false).map((k) => ({ title: k.title, path: k.path }));
    const auto = view.brand === 'lg' && view.state?.wakeOnLan === true;
    network = {
      possible: true,
      auto,
      why: auto ? 'Hearth already switched on its “Turn on via Wi-Fi” setting.' : 'One setting on the TV lets your phone wake it.',
      steps: auto ? steps.filter((s) => !/wi-?fi|mobile/i.test(s.title)) : steps,
    };
  }

  // ── through a box on its HDMI ──
  const cec = CEC_ON_TV[view.brand]?.(guide.year ?? 2022) ?? { title: 'HDMI-CEC', path: 'Turn on HDMI-CEC in the TV’s settings (every brand names it differently).' };
  const box = isBox
    ? { possible: false, why: 'This is the box itself.' }
    : {
        possible: boxes.length > 0,
        why: boxes.length ? 'A box plugged into the TV turns it on when the box wakes.' : 'Plug a Roku or Apple TV into the TV and add it to Hearth, and it can turn the TV on.',
        boxes,
        tvStep: { title: cec.title, path: cec.path },
        boxSteps: Object.fromEntries(Object.entries(CEC_ON_BOX).map(([b, s]) => [b, s])),
        via: view.wakeVia ?? null,
        note: 'Waking through a box switches the TV to that box’s input.',
      };

  // ── what to suggest ──
  let way;
  if (view.wakeVia) way = 'box';
  else if (network.possible) way = 'network';
  else if (box.possible) way = 'box';
  else way = 'remote';
  const year = guide.year ? `${guide.year} ` : '';
  const brand = { samsung: 'Samsung', lg: 'LG', roku: 'Roku', androidtv: 'Google TV', appletv: 'Apple TV' }[view.brand] ?? 'TV';
  const headline = {
    network: network.auto ? `${name} is ready to wake from your phone` : `${name} can wake from your phone`,
    box: `${name} can turn on through a box`,
    remote: `${name} only turns on with its own remote`,
  }[way];
  const why = way === 'network' ? network.why : way === 'box' ? (network.possible ? box.why : `${network.why} ${box.why}`) : `${network.why} ${box.possible ? '' : box.why}`.trim();

  return {
    id: view.id,
    name,
    family: `${year}${brand}`,
    model: view.model || '',
    way,
    headline,
    why,
    network,
    box,
    // A short line for TV settings ("Turning on: …").
    summary: view.wakeVia
      ? `Through ${boxes.find((b) => b.id === view.wakeVia)?.name ?? 'a box'}`
      : way === 'network'
        ? network.auto ? 'From your phone' : `From your phone, after ${cut(network.steps?.[0]?.title) || 'one setting'}`
        : way === 'box' ? 'Needs a box: tap to set up' : 'Its own remote only',
  };
}
