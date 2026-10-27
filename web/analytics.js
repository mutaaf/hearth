// Product analytics, for the phone app only: events go to the native side
// (window.HearthHost.track), which whitelists the properties again and sends
// them to PostHog (hearth-app src/telemetry.js). The home server and the
// public demo have no HearthHost, so nothing here leaves the page there.
//
// Never pass a TV's name, IP, MAC, serial or the Wi-Fi name: brands, counts,
// steps and durations only.

const host = () => (window.HearthHost?.native && !window.HearthDemo ? window.HearthHost : null);

export function track(event, props = {}) {
  try {
    host()?.track?.(event, props);
  } catch {}
}

// Screens: one `screen` event per change, with how long the last one was up.
let current = null;
let since = 0;
export function screen(name, props = {}) {
  if (name === current) return;
  const now = Date.now();
  track('screen', { screen: name, from: current ?? 'launch', prev_s: current ? Math.round((now - since) / 1000) : 0, ...props });
  current = name;
  since = now;
}
export const currentScreen = () => current;

// How far down a scroller people get: reported once, when they leave it.
export function scrollDepth(el, name) {
  let max = 0;
  const read = () => {
    const box = el === window ? document.scrollingElement : el;
    const room = box.scrollHeight - box.clientHeight;
    if (room > 0) max = Math.max(max, Math.round((box.scrollTop / room) * 100));
  };
  (el === window ? window : el).addEventListener('scroll', read, { passive: true });
  return {
    report(props = {}) {
      if (max > 0) track('scrolled', { where: name, depth: Math.min(100, Math.ceil(max / 25) * 25), ...props });
      max = 0;
    },
  };
}
