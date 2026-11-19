// "Run it automatically with Shortcuts": a tiny guided sheet from the scene
// editor, iPhone app only. The app (hearth-app) gives Shortcuts and Siri a
// "Run Hearth scene" action that lists this house's scenes, so an iOS
// automation (a time of day, arriving home, a Focus, an alarm) can run a
// scene hands-free. Here: three plain steps with the scene's name, and a
// button that opens the Shortcuts app (HearthHost.openShortcuts()).
//
// Shown only when the host says it can (`HearthHost.native` and
// `HearthHost.shortcuts`): never on the home server, the public demo or
// Android.
import { track } from './analytics.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const shortcutsAvailable = (w = globalThis.window) => Boolean(w?.HearthHost?.native && w.HearthHost.shortcuts === true && !w.HearthDemo);

// The sheet's words for one scene. `saved`: Shortcuts only sees saved scenes.
export function guideHtml({ name, saved = true, scheduled = false } = {}) {
  const scene = esc(String(name ?? '').trim() || 'your scene');
  return `
    <div class="sheet-grip"></div>
    <h3>Run “${scene}” by itself</h3>
    <p class="sub">Your iPhone runs it for you, right on cue.</p>
    ${saved ? '' : '<p class="sc-first">Save this scene first, so Shortcuts can see it.</p>'}
    <ol class="sc-steps">
      <li><b>Open Shortcuts</b>, tap <b>Automation</b>, then <b>＋</b> (New Automation).</li>
      <li><b>Pick when</b>: a time of day, arriving home, a Focus, or when your alarm stops. Choose <b>Run Immediately</b>.</li>
      <li><b>Add the Hearth action</b> “Run Hearth scene” and pick <b>${scene}</b>.</li>
    </ol>
    <p class="sc-siri">Or just say: “Hey Siri, run ${scene} in Hearth.”</p>
    ${scheduled ? '<p class="sc-note">Using Shortcuts for the same time? Turn off “Run on a schedule” here, so you don’t get the reminder too.</p>' : ''}
    <div class="sheet-actions">
      <button type="button" class="ghost" data-press="up" data-sc="close">Not now</button>
      <button type="button" class="cta small" data-press="up" data-sc="go">Open Shortcuts</button>
    </div>`;
}

export function createShortcutsGuide({ sheet = document.querySelector('#shortcutsSheet') } = {}) {
  if (!sheet) return { open() {} };
  sheet.addEventListener('click', (e) => {
    const b = e.target.closest('[data-sc]');
    if (!b) return;
    if (b.dataset.sc === 'go') {
      track('shortcuts_guide', { step: 'go' });
      window.HearthHost?.openShortcuts?.();
    } else track('shortcuts_guide', { step: 'close' });
    sheet.close();
  });
  return {
    open(scene) {
      sheet.innerHTML = guideHtml(scene);
      if (!sheet.open) sheet.showModal();
      track('shortcuts_guide', { step: 'open', saved: Boolean(scene?.saved) });
    },
  };
}
