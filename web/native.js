// The phone's own powers, used where they help a remote — with fallbacks,
// because the home server is plain http:// (azizfamily.local) and browsers
// keep many APIs (Wake Lock, Web Share, Clipboard, Badging, persistent
// storage) for https only. Each helper uses the real API when it's there and
// a sensible stand-in when it isn't; nothing here ever throws.
//
//  awake(on)      keep the screen on while a remote is open (Wake Lock, else a
//                 tiny muted looping video — the only thing iOS honours on http)
//  badge(n)       the app icon's badge = TVs that are on (installed apps, https)
//  share({…})     the share sheet, else Messages (sms:), else copy
//  copy(text)     clipboard, else the old execCommand route
//  onResume(fn)   back to the app after a while away (or from bfcache): fn()
//  launch()       ?go=… / ?do=… from home-screen shortcuts (manifest)
//  persist()      ask the browser not to evict saved settings
//  noZoom()       no accidental pinch/double-tap zoom while mashing buttons

const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

// ── Screen stays on ──
// 2 s of black 16×16 H.264, inline: Safari won't play video from a server
// without Range support or a video/ type, and this needs neither.
const AWAKE_MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMqbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAB9AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAlV0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAB9AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAfQAAAAAAABAAAAAAHNbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAgABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABeG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAThzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4xMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZHsBEAAADAAQAAAMACDxImSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAApAAAAAAAAAABhzdHRzAAAAAAAAAAEAAAACAABAAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAACAAAAAQAAABxzdHN6AAAAAAAAAAAAAAACAAAChgAAAAoAAAAUc3RjbwAAAAAAAAABAAADWgAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDAAAAAIZnJlZQAAAphtZGF0AAACcAYF//9s3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MToweDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdodHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MSBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAAA5liIQFv///D0UAAU9/gAAAAAZBmjgK+oA=';
let lock = null;
let video = null;
let wantAwake = false;
function awakeVideo() {
  if (video) return video;
  video = document.createElement('video');
  video.src = AWAKE_MP4;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  video.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0.01;pointer-events:none;';
  document.body.append(video);
  return video;
}
export async function awake(on) {
  wantAwake = on;
  try {
    if (on && 'wakeLock' in navigator && window.isSecureContext) {
      if (!lock && document.visibilityState === 'visible') {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => (lock = null));
      }
      return;
    }
    if (!on) {
      await lock?.release();
      lock = null;
      video?.pause();
      return;
    }
    // http: the muted video. Playing needs a user gesture the first time, so
    // it's retried on the next touch (see below).
    await awakeVideo().play();
  } catch {
    lock = null;
  }
}
// A touch is a user gesture: (re)start the video if we still want the screen on.
addEventListener('touchend', () => {
  if (wantAwake && !lock && (!video || video.paused) && !(window.isSecureContext && 'wakeLock' in navigator)) awake(true);
}, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantAwake) awake(true);
});

// ── App icon badge ──
export function badge(n) {
  try {
    if (!('setAppBadge' in navigator)) return;
    if (n > 0) navigator.setAppBadge(n).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
  } catch {}
}

// ── Copy, share ──
export async function copy(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // http: a hidden textarea + execCommand still works on every phone browser.
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;'; // 16px: no iOS zoom
  document.body.append(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  ta.remove();
  return ok;
}

export const canShare = () => typeof navigator.share === 'function';
// A Messages link for when there's no share sheet (http): iOS and Android
// both open Messages with the text filled in, recipient still to pick.
export const smsHref = (text) => `sms:${ios ? '&' : '?'}body=${encodeURIComponent(text)}`;
export const isPhone = () => ios || /Android/.test(navigator.userAgent);

// ── Coming back to the app ──
// iOS freezes a home-screen app in the background and its live stream goes
// quiet without an error; after a while away, refresh everything.
export function onResume(fn, { afterMs = 30_000 } = {}) {
  let hiddenAt = document.visibilityState === 'hidden' ? Date.now() : null;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt >= afterMs) {
      hiddenAt = null;
      fn('resume');
    } else hiddenAt = null;
  });
  addEventListener('pageshow', (e) => {
    if (e.persisted) fn('bfcache');
  });
}

// ── Home-screen shortcuts (manifest "shortcuts") ──
// → { go: 'last'|null, mode: 'stream'|…|null, action: 'all-off'|null }, and the
// params are taken off the address so a reload doesn't repeat them.
export function launch() {
  const q = new URLSearchParams(location.search);
  const out = { go: q.get('go'), mode: q.get('mode'), action: q.get('do') };
  if (out.go || out.mode || out.action) {
    for (const k of ['go', 'mode', 'do']) q.delete(k);
    const rest = q.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  }
  return out;
}

export function persist() {
  try {
    if (window.isSecureContext) navigator.storage?.persist?.().catch(() => {});
  } catch {}
}

// iOS ignores user-scalable=no; a pinch while mashing the remote is never
// wanted. (Double-tap zoom is off via touch-action: manipulation in pull.css.)
export function noZoom() {
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
}
