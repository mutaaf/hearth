// Scenes: one tap runs a whole routine ("Movie night"), or let it run itself
// on a schedule. The strip lives on the house view; the editor is a
// full-screen sheet built from big buttons — no typing required.
// A new scene starts with "Just say it": one sentence, the AI turns it into
// steps (hub POST /scenes/draft; TV names never leave the house), the person
// checks them, tries the draft for real (POST /scenes/try) and saves it. An
// aurora sky tells the story: the remote while it thinks, the house when the
// scene is ready, a flame when the AI couldn't.
import { feedback, haptic } from './feel.js';
import { track } from './analytics.js';
import { quip } from './quips.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const EMOJI = ['🌙', '🍿', '📚', '☀️', '🎮', '🏈', '🧸', '🎉', '🛋️', '🍽️', '🎬', '✨'];
const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const APP_SUGGESTIONS = ['Netflix', 'YouTube', 'YouTube TV', 'Disney+', 'Prime Video', 'Hulu', 'Max', 'Peacock', 'Paramount+', 'ESPN', 'Apple TV', 'Spotify', 'Plex', 'YouTube Kids'];
// The step builder's "What?" buttons → stored step.
const WHAT = {
  on: { label: 'Turn on', icon: '⏻', action: 'power', args: { on: true } },
  off: { label: 'Turn off', icon: '⏼', action: 'power', args: { on: false } },
  volume: { label: 'Volume', icon: '🎚️', action: 'volume', args: { level: 20 } },
  mute: { label: 'Mute', icon: '🔇', action: 'mute', args: { on: true } },
  unmute: { label: 'Unmute', icon: '🔈', action: 'mute', args: { on: false } },
  launch: { label: 'Open app', icon: '▦', action: 'launch', args: { title: 'Netflix' } },
  say: { label: 'Say', icon: '💬', action: 'say', args: { message: 'Bedtime 🌙' } },
  wait: { label: 'Wait', icon: '⏳', action: 'wait', args: { seconds: 5 } },
};
const STEP_ACTIONS = ['power', 'volume', 'mute', 'launch', 'input', 'say', 'key', 'wait'];

export function createScenes({ api, getTvs, note }) {
  const strip = document.querySelector('#scenes');
  const editor = document.querySelector('#sceneEditor');
  let scenes = [];
  const progress = new Map(); // id → { step, total, done, ok }
  let draft = null; // scene being edited
  let builder = null; // step being built: { what, target: Set|'all', args }
  let say = null; // "Just say it": { text, phase: 'ask'|'thinking'|'error'|'made', error, summary }
  let trying = null; // a draft being tried: { step, total, done, ok, failed }
  let field = null;
  let asked = 0;

  const tvName = (id) => getTvs().find((t) => t.id === id)?.name ?? 'a TV';
  const targetLabel = (target) =>
    target === 'all' ? 'All TVs' : target.length === 1 ? tvName(target[0]) : `${target.length} TVs`;

  function describe(step) {
    const who = step.action === 'wait' ? '' : ` · ${targetLabel(step.target)}`;
    switch (step.action) {
      case 'power': return `${step.args?.on === false ? 'Turn off' : 'Turn on'}${who}`;
      case 'volume': return `Volume ${step.args?.level ?? (step.args?.delta > 0 ? `+${step.args.delta}` : step.args?.delta)}${who}`;
      case 'mute': return `${step.args?.on === false ? 'Unmute' : 'Mute'}${who}`;
      case 'launch': return `Open ${step.args?.title ?? 'app'}${who}`;
      case 'say': return `Say “${step.args?.message ?? ''}”${who}`;
      case 'wait': return `Wait ${step.args?.seconds ?? 5}s`;
      case 'input': return `Input ${step.args?.id ?? ''}${who}`;
      case 'key': return `Press ${step.args?.key ?? ''}${who}`;
      default: return step.action;
    }
  }

  function when(scene) {
    if (!scene.nextRun) return scene.schedule?.enabled === false && scene.schedule?.days?.length ? 'Schedule off' : `${scene.steps.length} step${scene.steps.length === 1 ? '' : 's'}`;
    const d = new Date(scene.nextRun);
    const today = new Date();
    const day = d.toDateString() === today.toDateString() ? 'Today' : DAY_NAMES[d.getDay()];
    return `${day} ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  }

  function render() {
    if (!strip) return;
    strip.innerHTML = `
      <div class="scenes-head"><h3 class="mono">Scenes</h3><small class="mono">tap to run · hold to edit</small></div>
      <div class="scenes-row">
        ${scenes
          .map((s) => {
            const p = progress.get(s.id);
            const pct = p ? Math.round((p.step / Math.max(1, p.total)) * 100) : 0;
            const state = p ? (p.done ? (p.ok ? 'done' : 'failed') : 'running') : '';
            return `<button type="button" class="scene-card ${state}" data-press="long" data-scene="${esc(s.id)}" style="--p:${pct}%">
              <span class="scene-emoji">${esc(s.emoji)}</span>
              <b>${esc(s.name)}</b>
              <small class="mono">${p && !p.done ? `Step ${p.step} of ${p.total}…` : p?.done ? (p.ok ? 'Done ✓' : 'Some TVs missed it') : esc(when(s))}</small>
              <i class="scene-bar" aria-hidden="true"></i>
            </button>`;
          })
          .join('')}
        <button type="button" class="scene-card add" data-press="up" data-scene-new="1"><span class="scene-emoji">＋</span><b>New scene</b><small class="mono">your routine</small></button>
      </div>`;
  }

  async function load() {
    try {
      scenes = await api('GET', '/scenes');
      render();
    } catch {
      if (strip) strip.hidden = true;
    }
  }

  async function run(id) {
    const scene = scenes.find((s) => s.id === id);
    if (!scene) return;
    haptic('press');
    progress.set(id, { step: 0, total: scene.steps.length, done: false });
    render();
    try {
      await api('POST', `/scenes/${id}/run`);
      track('scene_run', { steps: scene.steps.length, scheduled: Boolean(scene.schedule?.enabled) });
    } catch (err) {
      progress.delete(id);
      feedback('error');
      note(err.message, true);
      render();
    }
  }

  function onEvent(type, data) {
    if (type === 'scenes') {
      scenes = data;
      return render();
    }
    if (type === 'scene' && data.id === 'draft') {
      if (!draft) return;
      trying = { ...trying, ...data, failed: [...(trying?.failed ?? []), ...(data.results ?? []).filter((r) => !r.ok).map((r) => tvName(r.id))] };
      if (data.done) {
        feedback(data.ok ? 'success' : 'error');
        track('scene_say', { step: 'tried', ok: Boolean(data.ok), steps: data.total });
      } else if (data.step > 0) haptic('tick');
      return drawEditor();
    }
    if (type === 'scene') {
      progress.set(data.id, data);
      if (data.done) {
        feedback(data.ok ? 'success' : 'error');
        note(data.ok ? quip('scene', { scene: data.name }) : `${data.name}: some TVs didn’t follow`, data.ok ? 'success' : true);
        setTimeout(() => {
          progress.delete(data.id);
          render();
        }, 3500);
      } else if (data.step > 0) haptic('tick');
      render();
    }
  }

  // ── Editor ───────────────────────────────────────────
  function openEditor(scene = null, prefill = null) {
    draft = scene
      ? JSON.parse(JSON.stringify(scene))
      : { name: 'My scene', emoji: '✨', steps: [], schedule: { days: [], time: '21:00', enabled: false }, ...(prefill ?? {}) };
    draft.steps = (draft.steps ?? []).filter((s) => STEP_ACTIONS.includes(s.action));
    draft.schedule ??= { days: [], time: '21:00', enabled: false };
    builder = null;
    trying = null;
    say = scene || prefill ? null : { text: '', phase: 'ask' };
    editor.hidden = false;
    document.body.style.overflow = 'hidden';
    if (say) track('scene_say', { step: 'open', tvs: getTvs().length });
    drawEditor();
  }

  function closeEditor() {
    editor.hidden = true;
    editor.innerHTML = '';
    document.body.style.overflow = '';
    draft = null;
    builder = null;
    say = null;
    trying = null;
    asked++;
    field?.destroy();
    field = null;
  }

  // ── "Just say it" ────────────────────────────────────
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function sky(shape, palette) {
    const box = editor.querySelector('.say-sky');
    if (!box) return;
    box.closest('.wake-sheet').dataset.mood = palette === 'ice' ? 'ice' : shape === 'hearth-flame' ? 'ember-low' : 'ember';
    const AF = window.AuroraField;
    if (!AF || reduced()) return;
    const canvas = box.querySelector('canvas');
    // The editor redraws its HTML; a field on a canvas that's gone starts over.
    if (field && field.canvas !== canvas) {
      field.destroy();
      field = null;
    }
    if (!field) {
      try {
        window.HearthShapes?.register(AF);
        field = AF.create(canvas, {
          palette, shapes: ['hearth-remote', 'hearth-house', 'hearth-flame'], initial: shape, cycle: 0, interactive: false,
          count: innerWidth < 500 ? 1000 : 1500, stars: 40, depth: 1.6, container: canvas, maxDpr: 2, fpsFloor: 24,
          radius: (w, h) => Math.min(w, h * 1.9) * 0.34,
        });
        field.canvas = canvas;
      } catch {
        field = null;
        return;
      }
    }
    field.setShape(shape, { pin: true });
    field.set({ palette, autonomy: shape === 'hearth-remote' ? 1 : 0.7 });
  }

  // Examples in this house's own words.
  function examples() {
    const names = getTvs().filter((t) => t.paired !== false).map((t) => t.name).filter(Boolean);
    const a = names[0] ?? 'the TV';
    const b = names[1] ?? a;
    return [
      `Movie night: ${a} on, Netflix, volume 20`,
      `Bedtime on school nights at 8:30: ${b} quiet, say goodnight, then off`,
      'Everything off at midnight, every day',
      `Weekend mornings at 8: ${a} on with YouTube`,
    ];
  }

  function drawSay() {
    const thinking = say.phase === 'thinking';
    const failed = say.phase === 'error';
    return `
      <div class="setup-top">
        <button type="button" class="icon-btn" data-press="up" data-ed="close" aria-label="Close">✕</button><span></span>
      </div>
      <div class="ed-body wake-sheet say">
        <div class="wake-sky say-sky" aria-hidden="true"><canvas></canvas><div class="wake-glow"></div></div>
        <p class="wake-kicker mono">New scene · just say it</p>
        <h2>${thinking ? 'Making your scene…' : failed ? 'That didn’t work' : 'What should it do?'}</h2>
        <p class="wake-say">${thinking ? 'Turning what you said into steps. Your TVs’ names stay on this phone.' : 'Say it like you’d tell someone: which TVs, what happens, and when. You’ll see every step and can try it before saving.'}</p>
        <textarea id="sayText" class="say-text" rows="3" maxlength="240" placeholder="${esc(examples()[1])}" ${thinking ? 'disabled' : ''}>${esc(say.text)}</textarea>
        ${failed ? `<div class="wake-ai"><p class="wake-ai-head mono">The AI couldn’t make it</p><p class="say-err">${esc(say.error)}</p></div>` : ''}
        ${thinking ? '<p class="wake-wait mono"><span class="wake-dot"></span> Thinking…</p>' : `<div class="chips say-ex">${examples().map((e) => `<button type="button" class="chip" data-press="up" data-ed="example" data-v="${esc(e)}">${esc(e)}</button>`).join('')}</div>`}
      </div>
      <div class="ed-save say-actions">
        <button type="button" class="ghost" data-press="up" data-ed="buttons" ${thinking ? 'disabled' : ''}>Build it with buttons</button>
        <button type="button" class="cta big" data-press="up" data-ed="make" ${thinking ? 'disabled' : ''}>✨ Make it</button>
      </div>`;
  }

  async function make() {
    const text = (editor.querySelector('#sayText')?.value ?? say.text).trim();
    say.text = text;
    if (text.length < 3) {
      feedback('error');
      return note('Say what the scene should do first', true);
    }
    say.phase = 'thinking';
    const mine = ++asked;
    track('scene_say', { step: 'make', len: text.length });
    drawEditor();
    try {
      const { draft: made } = await api('POST', '/scenes/draft', { text });
      if (mine !== asked || !draft) return;
      Object.assign(draft, {
        name: made.name,
        emoji: made.emoji,
        steps: made.steps.filter((st) => STEP_ACTIONS.includes(st.action)),
        schedule: made.schedule ? { ...made.schedule, enabled: true } : { days: [], time: '21:00', enabled: false },
      });
      say = { text, phase: 'made', summary: made.summary };
      feedback('success');
      track('scene_say', { step: 'made', steps: draft.steps.length, scheduled: Boolean(made.schedule) });
    } catch (err) {
      if (mine !== asked || !draft) return;
      say.phase = 'error';
      say.error = err.message;
      feedback('error');
      track('scene_say', { step: 'failed', status: err.status ?? 0 });
    }
    drawEditor();
  }

  async function tryIt() {
    if (!draft.steps.length) return note('Add a step first', true);
    trying = { step: 0, total: draft.steps.length, done: false, failed: [] };
    track('scene_say', { step: 'try', steps: draft.steps.length, made: say?.phase === 'made' });
    drawEditor();
    try {
      await api('POST', '/scenes/try', { name: draft.name, emoji: draft.emoji, steps: draft.steps });
    } catch (err) {
      trying = null;
      feedback('error');
      note(err.message, true);
      drawEditor();
    }
  }

  function tryLine() {
    if (!trying) return '';
    if (!trying.done) return `<p class="wake-wait mono say-try"><span class="wake-dot"></span> Trying it · step ${trying.step} of ${trying.total}</p>`;
    if (trying.ok) return '<p class="mono say-try say-ok">✓ It worked. Save it to keep it.</p>';
    const who = [...new Set(trying.failed)];
    return `<p class="mono say-try say-bad">✕ ${who.length ? `${esc(who.join(', '))} didn’t follow.` : 'Some steps didn’t work.'} Check the steps, then try again.</p>`;
  }

  function drawEditor() {
    if (say && say.phase !== 'made') {
      editor.innerHTML = drawSay();
      editor.querySelector('#sayText')?.addEventListener('input', (e) => (say.text = e.target.value));
      sky(say.phase === 'thinking' ? 'hearth-remote' : say.phase === 'error' ? 'hearth-flame' : 'hearth-house', say.phase === 'thinking' ? 'ice' : 'ember');
      return;
    }
    if (field) {
      field.destroy();
      field = null;
    }
    const tvs = getTvs();
    const sch = draft.schedule;
    editor.innerHTML = `
      <div class="setup-top">
        <button type="button" class="icon-btn" data-press="up" data-ed="close" aria-label="Close">✕</button>
        ${draft.id ? '<button type="button" class="danger hold" data-press="confirm" data-ed="delete"><span class="charge" aria-hidden="true"></span>Hold to delete</button>' : '<span></span>'}
      </div>
      <div class="ed-body">
        <h2>${draft.id ? 'Edit scene' : 'New scene'}</h2>
        ${say?.phase === 'made' ? `<div class="wake-ai wake-sheet say-made"><p class="wake-ai-head mono">✨ Made from what you said</p><p>${esc(say.summary || 'Here are the steps.')}</p><button type="button" class="ghost small" data-press="up" data-ed="again">Say it differently</button></div>` : ''}
        <div class="ed-name">
          <span class="ed-emoji-now">${esc(draft.emoji)}</span>
          <input id="edName" maxlength="40" value="${esc(draft.name)}" aria-label="Scene name" autocomplete="off">
        </div>
        <div class="ed-emojis">${EMOJI.map((e) => `<button type="button" class="${e === draft.emoji ? 'active' : ''}" data-press="up" data-ed="emoji" data-v="${e}">${e}</button>`).join('')}</div>

        <h3 class="mono ed-label">Steps</h3>
        <ol class="ed-steps">
          ${draft.steps
            .map(
              (st, i) => `<li><span>${esc(describe(st))}</span>
                <button type="button" data-press="up" data-ed="up" data-i="${i}" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" data-press="up" data-ed="down" data-i="${i}" aria-label="Move down" ${i === draft.steps.length - 1 ? 'disabled' : ''}>↓</button>
                <button type="button" data-press="up" data-ed="del" data-i="${i}" aria-label="Remove">✕</button></li>`,
            )
            .join('') || '<li class="empty-step">No steps yet. Add one below.</li>'}
        </ol>
        ${builder ? drawBuilder(tvs) : '<button type="button" class="chip big ed-add" data-press="up" data-ed="add">＋ Add a step</button>'}

        <h3 class="mono ed-label">When</h3>
        <label class="toggle"><span><b>Run on a schedule</b><small class="mono">${sch.enabled && sch.days.length ? `${sch.days.map((d) => DAY_NAMES[d]).join(', ')} at ${sch.time}` : 'Only when you tap it'}</small></span><input type="checkbox" id="edSched" ${sch.enabled ? 'checked' : ''}></label>
        <div class="ed-days ${sch.enabled ? '' : 'off'}">
          ${DAYS.map((d, i) => `<button type="button" class="${sch.days.includes(i) ? 'active' : ''}" data-press="up" data-ed="day" data-v="${i}" aria-label="${DAY_NAMES[i]}">${d}</button>`).join('')}
          <input type="time" id="edTime" value="${esc(sch.time)}" aria-label="Time">
        </div>
      </div>
      <div class="ed-save">
        ${tryLine()}
        <div class="say-actions">
          ${draft.steps.length ? `<button type="button" class="ghost" data-press="up" data-ed="try" ${trying && !trying.done ? 'disabled' : ''}>▶ Try it now</button>` : ''}
          <button type="button" class="cta big" data-press="up" data-ed="save">Save scene</button>
        </div>
      </div>`;
    editor.querySelector('#edName').addEventListener('input', (e) => (draft.name = e.target.value));
    editor.querySelector('#edSched').addEventListener('change', (e) => {
      draft.schedule.enabled = e.target.checked;
      if (e.target.checked && !draft.schedule.days.length) draft.schedule.days = [0, 1, 2, 3, 4];
      drawEditor();
    });
    editor.querySelector('#edTime').addEventListener('change', (e) => (draft.schedule.time = e.target.value || '21:00'));
    editor.querySelector('#bVal')?.addEventListener('input', (e) => {
      const key = builder.what === 'volume' ? 'level' : builder.what === 'wait' ? 'seconds' : builder.what === 'launch' ? 'title' : 'message';
      builder.args[key] = e.target.type === 'range' ? Number(e.target.value) : e.target.value;
      const out = editor.querySelector('#bOut');
      if (out) out.textContent = e.target.value;
    });
  }

  function drawBuilder(tvs) {
    const b = builder;
    const def = WHAT[b.what];
    const tvChips = `<div class="chips ed-tvs">
        <button type="button" class="chip ${b.target === 'all' ? 'active' : ''}" data-press="up" data-ed="tv" data-v="all">All TVs</button>
        ${tvs.map((t) => `<button type="button" class="chip ${b.target !== 'all' && b.target.has(t.id) ? 'active' : ''}" data-press="up" data-ed="tv" data-v="${esc(t.id)}">${esc(t.name)}</button>`).join('')}
      </div>`;
    let detail = '';
    if (b.what === 'volume') detail = `<label class="vol-pick"><output id="bOut">${b.args.level}</output><input id="bVal" type="range" min="0" max="60" value="${b.args.level}"></label>`;
    if (b.what === 'wait') detail = `<label class="vol-pick"><output id="bOut">${b.args.seconds}</output><input id="bVal" type="range" min="1" max="60" value="${b.args.seconds}"><small class="mono">seconds</small></label>`;
    if (b.what === 'launch') detail = `<input id="bVal" list="edApps" value="${esc(b.args.title)}" placeholder="Netflix" autocomplete="off"><datalist id="edApps">${APP_SUGGESTIONS.map((a) => `<option value="${a}">`).join('')}</datalist>`;
    if (b.what === 'say') detail = `<input id="bVal" maxlength="120" value="${esc(b.args.message)}" autocomplete="off">`;
    return `<div class="ed-builder">
      <p class="mono ed-q">1 · What?</p>
      <div class="ed-what">${Object.entries(WHAT).map(([k, w]) => `<button type="button" class="${k === b.what ? 'active' : ''}" data-press="up" data-ed="what" data-v="${k}"><span>${w.icon}</span><small>${w.label}</small></button>`).join('')}</div>
      ${def.action === 'wait' ? '' : `<p class="mono ed-q">2 · Which TVs?</p>${tvChips}`}
      ${detail ? `<p class="mono ed-q">${def.action === 'wait' ? '2' : '3'} · ${def.label}</p>${detail}` : ''}
      <div class="sheet-actions"><button type="button" class="ghost" data-press="up" data-ed="cancel">Cancel</button><button type="button" class="cta small" data-press="up" data-ed="addstep">Add step</button></div>
    </div>`;
  }

  async function save() {
    const body = { name: draft.name, emoji: draft.emoji, steps: draft.steps, schedule: draft.schedule.days.length ? draft.schedule : null };
    try {
      if (draft.id) await api('PATCH', `/scenes/${draft.id}`, body);
      else await api('POST', '/scenes', body);
      feedback('success');
      if (say?.phase === 'made') track('scene_say', { step: 'saved', steps: draft.steps.length, tried: Boolean(trying?.done) });
      note(`${draft.name || 'Scene'} saved`);
      closeEditor();
      await load();
    } catch (err) {
      feedback('error');
      note(err.message, true);
    }
  }

  function handleEditor(el) {
    const what = el.dataset.ed;
    const i = Number(el.dataset.i);
    switch (what) {
      case 'close': return closeEditor();
      case 'save': return save();
      case 'make': return make();
      case 'try': return tryIt();
      case 'example':
        say.text = el.dataset.v;
        break;
      case 'buttons':
        say = null;
        track('scene_say', { step: 'buttons' });
        break;
      case 'again':
        say = { text: say?.text ?? '', phase: 'ask' };
        trying = null;
        break;
      case 'delete':
        return api('DELETE', `/scenes/${draft.id}`).then(() => {
          feedback('success');
          closeEditor();
          load();
        });
      case 'emoji':
        draft.emoji = el.dataset.v;
        break;
      case 'up':
        [draft.steps[i - 1], draft.steps[i]] = [draft.steps[i], draft.steps[i - 1]];
        break;
      case 'down':
        [draft.steps[i + 1], draft.steps[i]] = [draft.steps[i], draft.steps[i + 1]];
        break;
      case 'del':
        draft.steps.splice(i, 1);
        break;
      case 'add':
        builder = { what: 'on', target: 'all', args: { ...WHAT.on.args } };
        break;
      case 'cancel':
        builder = null;
        break;
      case 'what':
        builder.what = el.dataset.v;
        builder.args = { ...WHAT[el.dataset.v].args };
        break;
      case 'tv': {
        const v = el.dataset.v;
        if (v === 'all') builder.target = 'all';
        else {
          const set = builder.target === 'all' ? new Set() : builder.target;
          if (set.has(v)) set.delete(v);
          else set.add(v);
          builder.target = set.size ? set : 'all';
        }
        break;
      }
      case 'addstep': {
        const def = WHAT[builder.what];
        draft.steps.push({ target: builder.target === 'all' ? 'all' : [...builder.target], action: def.action, args: { ...builder.args } });
        builder = null;
        break;
      }
      case 'day': {
        const d = Number(el.dataset.v);
        const days = new Set(draft.schedule.days);
        if (days.has(d)) days.delete(d);
        else days.add(d);
        draft.schedule.days = [...days].sort();
        draft.schedule.enabled = days.size > 0;
        break;
      }
    }
    if (['up', 'down', 'del', 'addstep'].includes(what) && trying?.done) trying = null;
    haptic('tick');
    drawEditor();
  }

  return {
    load,
    render,
    onEvent,
    openEditor,
    get editing() {
      return !editor.hidden;
    },
    handle(el, info) {
      if (el.dataset.ed !== undefined) return handleEditor(el);
      if (el.dataset.sceneNew) return openEditor();
      const scene = scenes.find((s) => s.id === el.dataset.scene);
      if (!scene) return;
      if (info.long) return openEditor(scene);
      return run(scene.id);
    },
  };
}
