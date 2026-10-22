// Getting Hearth onto a home screen, for people who've never heard of a PWA.
// Works out which device and browser this is, then shows the exact taps with
// a little picture of where to tap. Also: "Share Hearth" (link + QR) so one
// person can send it to the whole family.
import { canShare, copy as copyText, isPhone, smsHref } from './native.js';
import { feedback, haptic } from './feel.js';

const ua = navigator.userAgent;
const iPad = /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const iPhone = /iPhone|iPod/.test(ua);
const ios = iPad || iPhone;
const android = /Android/.test(ua);
const inApp = /FBAN|FBAV|Instagram|Line\/|GSA\/|Snapchat|TikTok/.test(ua);
const iosOtherBrowser = ios && /CriOS|FxiOS|EdgiOS/.test(ua);
const DISMISS_KEY = 'hearth.install.dismissed';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The App Store app (window.HearthHost) is already "installed".
export const isStandalone = () => Boolean(window.HearthHost) || navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

const SHARE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ADD_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const DOTS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>';

function steps() {
  if (inApp) {
    return {
      device: 'this app’s browser',
      art: 'inapp',
      list: [
        ['↗️', 'Open this page in <b>Safari</b> (or Chrome)', 'Tap ••• or the compass, then “Open in browser”. Apps like Facebook can’t install Hearth.'],
        ['📲', 'Then follow the steps there', 'It takes 10 seconds.'],
      ],
    };
  }
  if (ios && iosOtherBrowser) {
    return {
      device: iPad ? 'iPad' : 'iPhone',
      art: iPad ? 'ipad' : 'iphone',
      list: [
        [SHARE_ICON, 'Tap the <b>Share</b> button', iPad ? 'At the top right, next to the address.' : 'At the bottom or in the address bar.'],
        [ADD_ICON, 'Tap <b>Add to Home Screen</b>', 'Scroll down the list if you don’t see it.'],
        ['✅', 'Tap <b>Add</b>', 'Hearth appears on your home screen, like any app.'],
      ],
    };
  }
  if (ios) {
    return {
      device: iPad ? 'iPad' : 'iPhone',
      art: iPad ? 'ipad' : 'iphone',
      list: [
        [SHARE_ICON, 'Tap the <b>Share</b> button', iPad ? 'At the top right of Safari.' : 'At the bottom of Safari (the square with an arrow).'],
        [ADD_ICON, 'Tap <b>Add to Home Screen</b>', 'Scroll down the list if you don’t see it.'],
        ['✅', 'Tap <b>Add</b>', 'Hearth appears on your home screen and opens full-screen.'],
      ],
    };
  }
  if (android) {
    return {
      device: 'phone',
      art: 'android',
      list: [
        [DOTS_ICON, 'Tap the <b>⋮ menu</b>', 'At the top right of Chrome.'],
        [ADD_ICON, 'Tap <b>Add to Home screen</b> (or <b>Install app</b>)', ''],
        ['✅', 'Tap <b>Add</b>', 'Hearth appears with your other apps.'],
      ],
    };
  }
  return {
    device: 'computer',
    art: 'desktop',
    list: [
      ['⊕', 'Chrome or Edge: click the <b>install</b> icon in the address bar', 'Or ⋮ menu → Cast, save and share → Install page as app.'],
      ['🧭', 'Safari on a Mac: <b>File → Add to Dock</b>', ''],
      ['⌨️', 'Tip: on a computer, press <b>?</b> for keyboard shortcuts', ''],
    ],
  };
}

function art(kind) {
  if (kind === 'ipad') {
    return `<div class="inst-art ipad"><div class="dev"><div class="bar"><span class="url"></span><span class="hot">${SHARE_ICON}</span></div><div class="scr"><i class="appicon"></i></div></div></div>`;
  }
  if (kind === 'iphone') {
    return `<div class="inst-art iphone"><div class="dev"><div class="scr"><i class="appicon"></i></div><div class="bar bottom"><span class="hot">${SHARE_ICON}</span></div></div></div>`;
  }
  if (kind === 'android') {
    return `<div class="inst-art android"><div class="dev"><div class="bar"><span class="url"></span><span class="hot">${DOTS_ICON}</span></div><div class="scr"><i class="appicon"></i></div></div></div>`;
  }
  return '';
}

const SHARE_TEXT = 'Our TV remote 📺 Open this on the home Wi-Fi, then tap Share → Add to Home Screen.';

export function createInstall({ api, note, isDemo = false, invite = async () => null }) {
  let deferred = null; // Android/desktop Chrome's own install prompt, when offered (HTTPS only)
  let link = isDemo ? location.href.split('#')[0].replace(/[?&]skin=[^&]*/, '') : `${location.origin}/`;

  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
  });

  let info = null;
  const loadInfo = () =>
    (info ??= api('GET', '/info')
      .then((i) => {
        if (i?.friendlyUrl) link = i.friendlyUrl;
      })
      .catch(() => {
        info = null; // e.g. before this phone joined the house: try again later
      }));
  let shareLink = link; // the link being shared: an invite when the house is locked

  const sheet = document.createElement('dialog');
  sheet.className = 'sheet install-sheet';
  sheet.id = 'installSheet';
  document.body.append(sheet);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close();
  });

  function open() {
    haptic('tap');
    const s = steps();
    sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <div class="inst-head"><img src="icons/icon-180.png" alt="" width="64" height="64"><div><h3>Put Hearth on your ${esc(s.device)}</h3><p class="sub left">It opens full-screen, like a real app. No App Store.</p></div></div>
      ${art(s.art)}
      ${deferred ? '<button type="button" class="cta big wide" data-press="up" data-install="prompt">Install Hearth</button>' : ''}
      <ol class="inst-steps">${s.list
        .map(([icon, title, sub], i) => `<li style="--i:${i}"><span class="inst-ico">${icon}</span><span><b class="t">${title}</b>${sub ? `<small>${sub}</small>` : ''}</span></li>`)
        .join('')}</ol>
      <div class="sheet-actions"><button type="button" class="ghost" data-press="up" data-install="share">Send to family</button><button type="button" class="cta small" data-close>Got it</button></div>`;
    if (!sheet.open) sheet.showModal();
  }

  async function prompt() {
    if (!deferred) return open();
    deferred.prompt();
    const choice = await deferred.userChoice.catch(() => null);
    deferred = null;
    if (choice?.outcome === 'accepted') feedback('success');
    sheet.close();
  }

  // "Send to family": the iOS/Android share sheet (Messages, WhatsApp, Mail),
  // a QR code to scan from another phone, and a copy button.
  // When the house is locked the link is a one-time invite: it lets one phone
  // in without typing the house code.
  async function share() {
    haptic('tap');
    await loadInfo();
    const inv = await invite(link).catch(() => null);
    shareLink = inv ?? link;
    const qr = isDemo ? '' : `<img class="inst-qr" alt="QR code to open Hearth" src="api/qr.svg?u=${encodeURIComponent(shareLink)}">`;
    sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <h3>Get Hearth on another phone or iPad</h3>
      <p class="sub">${inv ? 'Scan this with the new phone, or send it the link. It lets <b>one</b> phone into the house, once, within a day, on the home Wi-Fi.' : 'Send this link to your family. They open it on the home Wi-Fi, then tap Add to Home Screen.'}</p>
      ${qr}
      <p class="inst-link mono">${esc(inv ? link : shareLink)}${inv ? ' · invite' : ''}</p>
      <div class="inst-share-btns">
        ${canShare() ? '<button type="button" class="cta wide" data-press="up" data-install="native-share">Send with Messages…</button>'
          : isPhone() ? `<a class="cta wide" href="${esc(smsHref(`${SHARE_TEXT} ${shareLink}`))}">Send with Messages…</a>` : ''}
        <button type="button" class="ghost wide" data-press="up" data-install="copy">Copy link</button>
      </div>
      <div class="sheet-actions"><button type="button" class="ghost" data-press="up" data-install="open">How to install</button><button type="button" class="cta small" data-close>Done</button></div>`;
    if (!sheet.open) sheet.showModal();
  }

  async function nativeShare() {
    try {
      await navigator.share({
        title: 'Hearth',
        text: SHARE_TEXT,
        url: shareLink,
      });
      feedback('success');
    } catch {}
  }

  async function copy() {
    if (await copyText(shareLink)) {
      feedback('success');
      note('Link copied');
    } else note(shareLink);
  }

  // A gentle banner on phones and iPads that haven't installed it yet.
  function banner() {
    if (isStandalone() || !(ios || android || inApp)) return;
    try {
      const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
      if (Date.now() - at < 14 * 864e5) return;
    } catch {}
    const el = document.createElement('div');
    el.className = 'install-banner';
    el.innerHTML = `<img src="icons/icon-180.png" alt="" width="44" height="44">
      <span><b>Add Hearth to your ${iPad ? 'iPad' : ios ? 'iPhone' : 'home screen'}</b><small class="mono">Opens like a real app · 10 seconds</small></span>
      <button type="button" class="cta small" data-press="up" data-install="open">How</button>
      <button type="button" class="x" data-press="up" data-install="dismiss" aria-label="Not now">✕</button>`;
    document.querySelector('#house .hero')?.after(el);
  }

  function welcome() {
    if (!isStandalone()) return;
    try {
      if (localStorage.getItem('hearth.installed')) return;
      localStorage.setItem('hearth.installed', String(Date.now()));
    } catch {}
    setTimeout(() => {
      feedback('success');
      note('Hearth is on your home screen 🎉');
    }, 900);
  }

  return {
    mount() {
      banner();
      welcome();
    },
    open,
    share,
    handle(el) {
      const a = el.dataset.install;
      if (a === 'open') return open();
      if (a === 'prompt') return prompt();
      if (a === 'share') return share();
      if (a === 'native-share') return nativeShare();
      if (a === 'copy') return copy();
      if (a === 'dismiss') {
        try {
          localStorage.setItem(DISMISS_KEY, String(Date.now()));
        } catch {}
        el.closest('.install-banner')?.remove();
      }
    },
  };
}
