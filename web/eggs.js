// Easter eggs: small surprises for people who poke around. Each is found
// once (localStorage hearth.eggs), says which number it was, and is counted
// in analytics as `easter_egg`. Nothing here sends anything to a TV that the
// person didn't already ask for.
//
//   konami     ↑ ↑ ↓ ↓ ← → ← → on the D-pad: 8-bit mode unlocked
//   hearth     tap the flame by "hearth" 7 times
//   itcrowd    the same TV off and on 3 times in 20 s
//   eleven     volume to exactly 11
//   kenobi     Say "hello there"
//   nightowl   everything off between midnight and 4 am
//   thumb      1,000 presses
//   holiday    open Hearth on Halloween, Christmas Day or New Year's Day
import { track } from './analytics.js';

const KEY = 'hearth.eggs';
export const EGGS = ['konami', 'hearth', 'itcrowd', 'eleven', 'kenobi', 'nightowl', 'thumb', 'holiday'];
const KONAMI = ['up', 'up', 'down', 'down', 'left', 'right', 'left', 'right'];

const load = (k, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

export function confetti(colors = ['#f2541b', '#ffb27d', '#3fd36f', '#f5a524', '#9bbc0f', '#a3245b', '#fff']) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  for (let i = 0; i < 56; i++) {
    const bit = document.createElement('i');
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colors[i % colors.length];
    bit.style.setProperty('--dx', `${(Math.random() - 0.5) * 180}px`);
    bit.style.setProperty('--rot', `${(Math.random() - 0.5) * 900}deg`);
    bit.style.animationDelay = `${Math.random() * 0.4}s`;
    box.append(bit);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 2600);
}

export function createEggs({ note, feedback, savePrefs, now = () => new Date() }) {
  const found = new Set(load(KEY, []));
  let keys = [];
  let taps = [];
  const flips = new Map(); // tv id → times power was pressed

  function hatch(egg, message, colors) {
    const first = !found.has(egg);
    if (first) {
      found.add(egg);
      save(KEY, [...found]);
      track('easter_egg', { egg, found: found.size, of: EGGS.length });
    }
    feedback?.('success');
    confetti(colors);
    note(first ? `${message}  ·  Egg ${found.size} of ${EGGS.length} 🥚` : message, 'success');
    return true;
  }

  return {
    get found() {
      return [...found];
    },
    // A remote key, as sent.
    key(name) {
      keys = [...keys, name].slice(-KONAMI.length);
      if (keys.join() === KONAMI.join()) {
        keys = [];
        savePrefs?.({ skin: '8bit' });
        return hatch('konami', 'Cheat code accepted. 8-bit mode unlocked! 🎮 (Settings to switch back.)', ['#9bbc0f', '#8bac0f', '#306230', '#0f380f']);
      }
      const n = load('hearth.presses', 0) + 1;
      save('hearth.presses', n);
      if (n === 1000) return hatch('thumb', '1,000 presses. Thumb of steel. 💪');
      if (n === 10000) return hatch('thumb', '10,000 presses. You are the remote now. 🏆');
      return false;
    },
    // The flame by "hearth" in the masthead.
    logo() {
      const t = Date.now();
      taps = [...taps.filter((x) => t - x < 3000), t];
      if (taps.length < 7) return false;
      taps = [];
      return hatch('hearth', 'You found the hearth. Pull up a chair. 🔥', ['#ff6a2b', '#ffb27d', '#f5a524', '#ffd166', '#fff']);
    },
    power(tvId) {
      const t = Date.now();
      const list = [...(flips.get(tvId) ?? []).filter((x) => t - x < 20_000), t];
      flips.set(tvId, list);
      if (list.length < 6) return false; // off-on, off-on, off-on
      flips.delete(tvId);
      return hatch('itcrowd', 'Have you tried turning it off and on again? 🤓');
    },
    volume(level) {
      return level === 11 && hatch('eleven', 'This one goes to eleven. 🎸');
    },
    said(message) {
      return /^\s*hello,? there[.!]*\s*$/i.test(message) && hatch('kenobi', 'General Kenobi. 🤖');
    },
    allOff() {
      const h = now().getHours();
      return h < 4 && hatch('nightowl', 'Night owl spotted. Every screen is off. Sweet dreams. 🦉', ['#6c5ce7', '#a29bfe', '#fff', '#ffeaa7']);
    },
    // Once a day, on the day.
    opened() {
      const d = now();
      const day = `${d.getMonth() + 1}-${d.getDate()}`;
      const msg = { '10-31': 'Happy Halloween! Spooky-season remote activated. 🎃', '12-25': 'Merry Christmas! The best seat in the house is yours. 🎄', '1-1': 'Happy New Year! New year, same great remote. 🎆' }[day];
      const stamp = `${d.getFullYear()}-${day}`;
      if (!msg || load('hearth.egg.day', '') === stamp) return false;
      save('hearth.egg.day', stamp);
      const colors = { '10-31': ['#ff7518', '#6a0dad', '#111', '#fff'], '12-25': ['#c0392b', '#27ae60', '#f1c40f', '#fff'], '1-1': ['#f1c40f', '#fff', '#3498db', '#e84393'] }[day];
      return hatch('holiday', msg, colors);
    },
  };
}
