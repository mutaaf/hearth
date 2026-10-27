// Away from home: when this phone can't reach the home server (out of the
// house, Wi-Fi off), Hearth turns into Light Racer instead of an error page,
// and hands the remote back by itself the moment home answers again.
// Also "Play Light Racer" from settings, any time.
import { feedback } from './feel.js';

const MISSES_TO_AWAY = 3; // ~6 s of silence: a server restart (npm run up) stays invisible

export function createAway({ isDemo = false } = {}) {
  let overlay = null;
  let frame = null;
  let away = false;
  let timer = null;
  let misses = 0;

  const ping = () =>
    fetch('api/health', { cache: 'no-store', signal: AbortSignal.timeout?.(2500) })
      .then((r) => r.ok)
      .catch(() => false);

  async function check() {
    timer = null;
    const ok = navigator.onLine !== false && (await ping());
    if (ok) {
      misses = 0;
      if (away) frame?.contentWindow?.postMessage({ hearth: 'home' }, '*');
      return;
    }
    if (++misses >= MISSES_TO_AWAY && !away) open(true);
    schedule(away ? 5000 : 2000);
  }
  function schedule(ms) {
    if (isDemo || timer) return;
    timer = setTimeout(check, ms);
  }

  function open(isAway) {
    close(false);
    away = isAway;
    overlay = document.createElement('div');
    overlay.className = 'away-overlay';
    frame = document.createElement('iframe');
    frame.src = isAway ? 'racer/index.html?away=1' : 'racer/index.html'; // index.html by name: the app serves these from file://
    frame.title = 'Light Racer';
    frame.allow = 'gamepad; fullscreen';
    overlay.append(frame);
    document.body.append(overlay);
    document.documentElement.classList.add('is-racing');
    frame.addEventListener('load', () => frame.focus());
  }

  function close(reload) {
    overlay?.remove();
    overlay = frame = null;
    document.documentElement.classList.remove('is-racing');
    if (away && reload) {
      // Back home: start clean, so every TV's state is fresh.
      feedback('success');
      location.reload();
    }
    away = false;
  }

  addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow) return;
    if (e.data?.hearth === 'back') close(true);
    if (e.data?.hearth === 'retry') {
      clearTimeout(timer);
      timer = null;
      check();
    }
  });
  addEventListener('offline', () => schedule(300));
  addEventListener('online', () => {
    clearTimeout(timer);
    timer = null;
    check();
  });

  return {
    // The live connection: a dropped stream is the first sign we've left home.
    watch(es) {
      if (isDemo || !es) return;
      es.addEventListener('error', () => schedule(800));
      es.addEventListener('hello', () => {
        misses = 0;
      });
      // A cold start away from home may never even error; check after a beat.
      setTimeout(() => {
        if (es.readyState !== 1) schedule(0);
      }, 4000);
    },
    play: () => open(false),
    get isAway() {
      return away;
    },
  };
}

// Where HTTPS allows it (localhost, the public demo), a service worker keeps
// the app and the game on the device, so opening Hearth with no network at
// all still lands on Light Racer. Plain http://azizfamily.local can't have one.
export function keepOffline() {
  if (!('serviceWorker' in navigator) || !isSecureContext) return;
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
