// The link: how Hearth is getting on with reaching your TVs, shown the same
// way on every screen. A night-glass capsule at the top, with a live
// aurora-field inside it, that drops in while the hub looks for a TV that
// went quiet (hub 'looking': routers hand TVs new addresses overnight) and
// says how it ended: found at a new address, or probably just off.
//
// It also keeps who's being looked for and who just moved, so the house
// cards and the remote's header can say "Looking…" / "New address" too.

const LOOKING_LINES = ['Checking the Wi-Fi…', 'Routers sometimes give TVs a new address overnight.', 'Following it to wherever it went…'];
const MOVED_FOR = 8000; // how long a card says "New address"
const SHOWN_AT_LEAST = 1400; // a look that ends at once still reads

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function names(ids, getTv) {
  const list = ids.map((id) => getTv(id)?.name).filter(Boolean);
  if (!list.length) return 'your TV';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.length} TVs`;
}

export function createLink({ getTv, current = () => null, onFix = () => {}, onWakeVia = () => {}, onChange = () => {}, feedback = () => {}, track = () => {} }) {
  const seeking = new Set();
  const moved = new Map(); // id → when
  let el = null;
  let field = null;
  let hideTimer = null;
  let lineTimer = null;
  let swapTimer = null;
  const stopLines = () => (clearInterval(lineTimer), clearTimeout(swapTimer));
  let shownAt = 0;
  let state = null;

  function mount() {
    if (el) return el;
    el = document.createElement('section');
    el.className = 'netlink';
    el.id = 'link';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('popover', 'manual');
    el.innerHTML = `
      <div class="netlink-sky" aria-hidden="true"><canvas class="netlink-field"></canvas></div>
      <div class="netlink-glyph" aria-hidden="true"><i></i><i></i><i></i><b></b></div>
      <div class="netlink-body"><p class="netlink-title"></p><p class="netlink-sub mono"></p></div>
      <div class="netlink-actions"></div>`;
    document.body.append(el);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-link]');
      if (!b) return;
      if (b.dataset.link === 'fix') onFix(b.dataset.tv);
      if (b.dataset.link === 'wake-via') onWakeVia(b.dataset.tv, b.dataset.via);
      hide(0);
    });
    return el;
  }

  // The aurora inside the capsule: particles that gather into a signal while
  // it looks, a TV when it finds one, an ember when it gives up.
  function sky(shape, palette, autonomy = 1) {
    const AF = window.AuroraField;
    if (!AF || reduced()) return;
    if (!field) {
      try {
        window.HearthShapes?.register(AF);
        const canvas = el.querySelector('.netlink-field');
        field = AF.create(canvas, {
          palette, shapes: ['hearth-signal', 'hearth-tv', 'hearth-flame'], initial: shape, cycle: 0, interactive: false,
          count: 900, stars: 40, depth: 1.6, container: canvas, maxDpr: 2, fpsFloor: 24, radius: (w, h) => Math.min(w, h * 3.2) * 0.42,
        });
      } catch {
        field = null;
        return;
      }
    }
    field?.setShape(shape, { pin: true });
    field?.set({ palette, autonomy });
  }

  function show(next) {
    mount();
    clearTimeout(hideTimer);
    stopLines();
    state = next;
    el.dataset.kind = next.kind;
    el.querySelector('.netlink-title').textContent = next.title;
    const sub = el.querySelector('.netlink-sub');
    sub.textContent = next.sub;
    sub.classList.remove('swap');
    el.querySelector('.netlink-actions').innerHTML = next.actions ?? '';
    if (next.lines) {
      let i = 0;
      lineTimer = setInterval(() => {
        i = (i + 1) % next.lines.length;
        sub.classList.add('swap');
        swapTimer = setTimeout(() => {
          sub.textContent = next.lines[i];
          sub.classList.remove('swap');
        }, 220);
      }, 2600);
    }
    try {
      if (!el.matches(':popover-open')) el.showPopover?.();
    } catch {}
    requestAnimationFrame(() => {
      el.classList.add('show');
      field?.resize?.();
    });
    sky(...next.sky);
    if (next.for) hide(next.for);
  }

  function hide(after = 0) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      stopLines();
      state = null;
      el?.classList.remove('show');
      setTimeout(() => {
        if (state || !el) return;
        try {
          el.hidePopover?.();
        } catch {}
        field?.destroy();
        field = null;
      }, 500);
    }, after);
  }

  // After a look that ended at once, let "Looking…" read before the answer.
  const later = (fn) => setTimeout(fn, Math.max(0, SHOWN_AT_LEAST - (Date.now() - shownAt)));

  return {
    isSeeking: (id) => seeking.has(id),
    justMoved: (id) => Date.now() - (moved.get(id) ?? 0) < MOVED_FOR,

    // hub 'looking': { on: true, tvs } then { on: false, tvs, found, missing }
    looking(e) {
      const ids = (e?.tvs ?? []).filter((id) => getTv(id)?.paired);
      if (e?.on) {
        if (!ids.length) return;
        for (const id of ids) seeking.add(id);
        shownAt = Date.now();
        track('link_looking', { tvs: ids.length });
        show({ kind: 'looking', title: `Looking for ${names(ids, getTv)}`, sub: LOOKING_LINES[0], lines: LOOKING_LINES, sky: ['hearth-signal', 'ice', 1] });
        onChange();
        return;
      }
      later(() => {
        for (const id of e?.tvs ?? []) seeking.delete(id);
        const found = (e?.found ?? []).filter((id) => getTv(id));
        const missing = (e?.missing ?? []).filter((id) => getTv(id));
        track('link_result', { found: found.length, missing: missing.length });
        onChange();
        if (found.length) return; // healed() tells that story
        if (!missing.length) return hide(0);
        // Most quiet TVs are simply off: say so softly, and only offer Fix
        // for the one you're trying to use.
        const here = missing.includes(current()) ? current() : null;
        show({
          kind: 'missing',
          title: missing.length === 1 ? `${names(missing, getTv)} isn’t on the Wi-Fi` : `${names(missing, getTv)} aren’t on the Wi-Fi`,
          sub: 'Probably just off. Switch it on once with its own remote.',
          actions: here ? `<button type="button" class="netlink-btn" data-link="fix" data-tv="${esc(here)}">Fix</button>` : '',
          sky: ['hearth-flame', 'ember', 0.35],
          for: here ? 7000 : 3600,
        });
      });
    },

    // hub 'wake-via': a quiet TV came on right after Hearth woke a box, so the
    // box is probably on its HDMI. Offer to wake the TV through it.
    wakeVia(info) {
      const tv = getTv(info?.id);
      const box = getTv(info?.via);
      if (!tv || !box || tv.wakeVia) return;
      track('wake_via_offer', { brand: tv.brand, box: box.brand });
      show({
        kind: 'found',
        title: `${tv.name} came on with ${box.name}`,
        sub: `Wake it through ${box.name} from now on? Handy when it won’t wake on its own.`,
        actions: `<button type="button" class="netlink-btn" data-link="wake-via" data-tv="${esc(tv.id)}" data-via="${esc(box.id)}">Yes</button>`,
        sky: ['hearth-tv', 'ember', 0.6],
        for: 12000,
      });
    },

    // hub 'healed': a TV the router moved, followed to its new address.
    healed(info) {
      if (!info?.id) return;
      moved.set(info.id, Date.now());
      later(() => {
        seeking.delete(info.id);
        feedback('success');
        show({ kind: 'found', title: `Found ${info.name || 'your TV'}`, sub: 'Your router gave it a new address. Reconnected.', sky: ['hearth-tv', 'ember', 0.6], for: 4200 });
        onChange();
        setTimeout(onChange, MOVED_FOR + 50);
      });
    },
  };
}
