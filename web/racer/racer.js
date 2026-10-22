// Light Racer: Hearth's away-from-home game. Light cycles that grow like a
// snake: eat sparks to stretch your wall, box the other riders in, and don't
// touch anything. Runs offline. The app shows it (?away=1, in a frame)
// whenever the home server is out of reach, and asks for it back by message.
import { haptic } from '../feel.js';

const $ = (s) => document.querySelector(s);
const AWAY = new URLSearchParams(location.search).has('away');
const EMBEDDED = window.parent !== window;
const BEST_KEY = 'hearth.racer.best';
const MUTE_KEY = 'hearth.racer.muted';
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

const DIRS = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
const CLOCKWISE = ['up', 'right', 'down', 'left'];
const turnOf = (d, side) => CLOCKWISE[(CLOCKWISE.indexOf(d) + (side === 'right' ? 1 : 3)) % 4];
const opposite = (a, b) => DIRS[a][0] === -DIRS[b][0] && DIRS[a][1] === -DIRS[b][1];
const PLAYER = { color: '#5cffd6', core: '#eafff9' };
const BOTS = [
  { color: '#ff4fd8', core: '#ffe3f8', name: 'Rose' },
  { color: '#ffb03b', core: '#fff1d6', name: 'Ember' },
  { color: '#9d7bff', core: '#efe9ff', name: 'Iris' },
  { color: '#4fb4ff', core: '#e4f4ff', name: 'Tide' },
  { color: '#ff5b6e', core: '#ffe4e8', name: 'Flare' },
];

// ── The sky's particle field (aurora-field), shaped like a light cycle ──
function circle(cx, cy, r) {
  const k = r * 0.5523;
  return `M${cx - r} ${cy} C${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} C${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} C${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} C${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} Z`;
}
let field = null;
function mountField() {
  const AF = window.AuroraField;
  if (!AF) return;
  try {
    window.HearthShapes?.register(AF);
    AF.register('racer-cycle', AF.fromSVG([
      'M10 60 C16 42 32 34 52 34 L76 36 C88 38 96 48 96 60 L84 54 L26 54 Z',
      'M46 40 L74 42 L68 49 L44 48 Z',
      circle(26, 66, 14), circle(26, 66, 6), circle(78, 66, 14), circle(78, 66, 6),
      'M0 74 H14 M88 74 H100',
    ], { tone: [0, 1, 0, 1, 0, 1, 1] }));
    const small = innerWidth < 600;
    field = AF.create($('#field'), {
      palette: 'aurora', shapes: ['racer-cycle', 'hearth-house'], initial: AWAY ? 'hearth-house' : 'racer-cycle',
      cycle: 0, interactive: false, stars: small ? 120 : 220, count: small ? 1800 : 3600, depth: 2.6,
      radius: (w, h) => Math.min(w * 0.42, h * 0.3, 300),
    });
    if (AWAY) setTimeout(() => field?.setShape('racer-cycle', { pin: true }), 4200);
  } catch {
    field = null;
  }
}
const pulse = (x, y) => {
  try {
    field?.pointer('pulse', x, y);
  } catch {}
};

// ── Sound: a tiny synth (engine hum, turn blips, spark chimes, derez) ──
const sfx = (() => {
  let ac = null;
  let hum = null;
  let muted = store.get(MUTE_KEY) === '1';
  const ctx = () => {
    if (muted) return null;
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  };
  function blip(freq, to, dur, vol, type = 'sine', at = 0) {
    const a = ctx();
    if (!a) return;
    const t = a.currentTime + at;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, from, to) {
    const a = ctx();
    if (!a) return;
    const buf = a.createBuffer(1, Math.floor(a.sampleRate * dur), a.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = a.createBufferSource();
    const f = a.createBiquadFilter();
    const g = a.createGain();
    src.buffer = buf;
    f.type = 'bandpass';
    f.frequency.setValueAtTime(from, a.currentTime);
    f.frequency.exponentialRampToValueAtTime(to, a.currentTime + dur);
    g.gain.value = vol;
    src.connect(f).connect(g).connect(a.destination);
    src.start();
  }
  return {
    get muted() {
      return muted;
    },
    toggle() {
      muted = !muted;
      store.set(MUTE_KEY, muted ? '1' : '0');
      if (muted) this.engine(false);
      return muted;
    },
    unlock: () => ctx(),
    turn: () => blip(620, 900, 0.05, 0.035, 'triangle'),
    spark: () => [784, 1175, 1568].forEach((f, i) => blip(f, 0, 0.12, 0.05, 'triangle', i * 0.05)),
    kill: () => {
      noise(0.5, 0.25, 2400, 200);
      blip(330, 80, 0.4, 0.06, 'sawtooth');
    },
    crash: () => {
      noise(0.9, 0.4, 3000, 120);
      blip(220, 40, 0.8, 0.09, 'sawtooth');
    },
    wave: () => [523, 659, 784, 1047].forEach((f, i) => blip(f, 0, 0.18, 0.05, 'square', i * 0.09)),
    count: (hi) => blip(hi ? 1320 : 660, 0, hi ? 0.3 : 0.12, 0.05, 'square'),
    engine(on, speed = 0) {
      const a = on ? ctx() : ac;
      if (!a) return;
      if (on && !hum) {
        const o = a.createOscillator();
        const f = a.createBiquadFilter();
        const g = a.createGain();
        o.type = 'sawtooth';
        f.type = 'lowpass';
        f.frequency.value = 420;
        g.gain.value = 0;
        o.connect(f).connect(g).connect(a.destination);
        o.start();
        hum = { o, f, g };
      }
      if (!hum) return;
      const t = a.currentTime;
      hum.g.gain.setTargetAtTime(on ? 0.022 : 0, t, 0.08);
      hum.o.frequency.setTargetAtTime(52 + speed * 46, t, 0.1);
      hum.f.frequency.setTargetAtTime(380 + speed * 900, t, 0.1);
    },
  };
})();

// ── Board geometry ──
const board = $('#board');
const g = board.getContext('2d');
let dpr = 1;
let vw = 0;
let vh = 0;
let cols = 0;
let rows = 0;
let cell = 16;
let ox = 0;
let oy = 0;
let gridCanvas = null;
const cx = (i) => ox + ((i % cols) + 0.5) * cell;
const cy = (i) => oy + (Math.floor(i / cols) + 0.5) * cell;

function measure() {
  dpr = Math.min(devicePixelRatio || 1, 2);
  vw = innerWidth;
  vh = innerHeight;
  board.width = Math.round(vw * dpr);
  board.height = Math.round(vh * dpr);
}
function pickGrid() {
  const slot = $('#slot').getBoundingClientRect();
  const target = Math.max(13, Math.min(28, Math.min(slot.width, slot.height) / 24));
  cols = Math.max(16, Math.floor(slot.width / target));
  rows = Math.max(16, Math.floor(slot.height / target));
}
function fit() {
  const slot = $('#slot').getBoundingClientRect();
  cell = Math.max(4, Math.min(slot.width / cols, slot.height / rows));
  ox = slot.left + (slot.width - cell * cols) / 2;
  oy = slot.top + (slot.height - cell * rows) / 2;
  gridCanvas = drawGrid();
}
function drawGrid() {
  const c = document.createElement('canvas');
  c.width = board.width;
  c.height = board.height;
  const x = c.getContext('2d');
  x.scale(dpr, dpr);
  const w = cols * cell;
  const h = rows * cell;
  x.fillStyle = 'rgba(3, 6, 16, 0.62)';
  x.beginPath();
  x.roundRect?.(ox - 4, oy - 4, w + 8, h + 8, 14);
  if (!x.roundRect) x.rect(ox - 4, oy - 4, w + 8, h + 8);
  x.fill();
  x.lineWidth = 1;
  for (let i = 1; i < cols; i++) {
    x.strokeStyle = i % 4 ? 'rgba(120, 220, 255, 0.045)' : 'rgba(120, 220, 255, 0.1)';
    x.beginPath();
    x.moveTo(Math.round(ox + i * cell) + 0.5, oy);
    x.lineTo(Math.round(ox + i * cell) + 0.5, oy + h);
    x.stroke();
  }
  for (let j = 1; j < rows; j++) {
    x.strokeStyle = j % 4 ? 'rgba(120, 220, 255, 0.045)' : 'rgba(120, 220, 255, 0.1)';
    x.beginPath();
    x.moveTo(ox, Math.round(oy + j * cell) + 0.5);
    x.lineTo(ox + w, Math.round(oy + j * cell) + 0.5);
    x.stroke();
  }
  // The arena wall: a glowing double line.
  x.shadowColor = '#5cffd6';
  x.shadowBlur = 18;
  x.strokeStyle = 'rgba(92, 255, 214, 0.75)';
  x.lineWidth = 2;
  x.strokeRect(ox - 1, oy - 1, w + 2, h + 2);
  x.shadowBlur = 0;
  x.strokeStyle = 'rgba(157, 123, 255, 0.35)';
  x.strokeRect(ox - 6, oy - 6, w + 12, h + 12);
  return c;
}

// ── Game state ──
let mode = 'title'; // title | ready | play | paused | over
let grid = new Int16Array(0); // 0 empty, else rider index + 1
let riders = [];
let sparks = new Map(); // cell index → { born }
let parts = [];
let floats = [];
let wave = 1;
let score = 0;
let best = Number(store.get(BEST_KEY) || 0);
let runStart = 0;
let readyAt = 0;
let stats = { sparks: 0, kills: 0 };
let shake = 0;

function rider(i, x, y, dir, look, bot) {
  return { i, x, y, dir, queue: [], trail: [], len: bot ? 12 : 16, alive: true, bot, ...look, acc: 0, energy: 1, boosting: false, dying: 0, noise: 1 };
}

function newWave(n) {
  wave = n;
  grid = new Int16Array(cols * rows);
  sparks = new Map();
  parts = [];
  const bots = Math.min(1 + n, BOTS.length);
  const midY = Math.floor(rows / 2);
  const spots = [
    [Math.floor(cols * 0.82), midY, 'left'],
    [Math.floor(cols / 2), Math.floor(rows * 0.15), 'down'],
    [Math.floor(cols / 2), Math.floor(rows * 0.85), 'up'],
    [Math.floor(cols * 0.82), Math.floor(rows * 0.2), 'left'],
    [Math.floor(cols * 0.82), Math.floor(rows * 0.8), 'left'],
  ];
  riders = [rider(0, Math.floor(cols * 0.18), midY, 'right', PLAYER, false)];
  for (let b = 0; b < bots; b++) {
    const [x, y, d] = spots[b];
    const r = rider(b + 1, x, y, d, BOTS[b], true);
    r.noise = Math.max(0.15, 1.1 - n * 0.18);
    r.hunt = Math.min(0.9, 0.15 + n * 0.12);
    riders.push(r);
  }
  for (const r of riders) occupy(r, r.y * cols + r.x);
  const want = 3 + Math.floor(cols * rows / 500);
  for (let k = 0; k < want; k++) spawnSpark();
  $('#wave').textContent = String(n);
}

function occupy(r, idx) {
  grid[idx] = r.i + 1;
  r.trail.push(idx);
}

function spawnSpark() {
  for (let tries = 0; tries < 200; tries++) {
    const x = 1 + Math.floor(Math.random() * (cols - 2));
    const y = 1 + Math.floor(Math.random() * (rows - 2));
    const idx = y * cols + x;
    if (!grid[idx] && !sparks.has(idx)) {
      sparks.set(idx, { born: performance.now() });
      return;
    }
  }
}

const periodOf = (r) => {
  const base = Math.max(78, 112 - (wave - 1) * 5);
  return r.boosting ? base * 0.56 : base;
};
const free = (x, y) => x >= 0 && y >= 0 && x < cols && y < rows && !grid[y * cols + x];

// Flood fill from (x, y), capped: how much room is down that road?
let seen = new Uint32Array(0);
let stamp = 0;
function room(x, y, cap) {
  if (seen.length !== grid.length) seen = new Uint32Array(grid.length);
  stamp++;
  const stack = [y * cols + x];
  seen[stack[0]] = stamp;
  let n = 0;
  while (stack.length && n < cap) {
    const i = stack.pop();
    n++;
    const px = i % cols;
    const py = (i - px) / cols;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = px + dx;
      const ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const j = ny * cols + nx;
      if (grid[j] || seen[j] === stamp) continue;
      seen[j] = stamp;
      stack.push(j);
    }
  }
  return n;
}

function think(b) {
  const player = riders[0];
  let bestDir = b.dir;
  let bestScore = -Infinity;
  for (const d of [b.dir, turnOf(b.dir, 'left'), turnOf(b.dir, 'right')]) {
    const nx = b.x + DIRS[d][0];
    const ny = b.y + DIRS[d][1];
    if (!free(nx, ny)) continue;
    let s = room(nx, ny, 90) * 1.2;
    // Sparks pull them in; a hungry rider is a predictable rider.
    let near = Infinity;
    for (const idx of sparks.keys()) {
      const dist = Math.abs((idx % cols) - nx) + Math.abs(Math.floor(idx / cols) - ny);
      if (dist < near) near = dist;
    }
    if (near < Infinity) s += 34 / (1 + near);
    // Hunters aim just ahead of you to cut you off.
    if (player.alive && Math.random() < b.hunt) {
      const tx = player.x + DIRS[player.dir][0] * 5;
      const ty = player.y + DIRS[player.dir][1] * 5;
      s += 26 / (1 + Math.abs(tx - nx) + Math.abs(ty - ny));
    }
    if (d === b.dir) s += 3;
    s += Math.random() * 6 * b.noise;
    if (s > bestScore) {
      bestScore = s;
      bestDir = d;
    }
  }
  b.dir = bestDir;
  // Boost down long, clear straights when there's juice.
  let clear = 0;
  for (let k = 1; k <= 8 && free(b.x + DIRS[b.dir][0] * k, b.y + DIRS[b.dir][1] * k); k++) clear++;
  b.boosting = clear >= 8 && b.energy > 0.5 && Math.random() < b.hunt * 0.25 ? true : b.boosting && clear >= 3 && b.energy > 0.05;
}

function steer(d) {
  const p = riders[0];
  if (!p?.alive || (mode !== 'play' && mode !== 'ready')) return;
  const last = p.queue.length ? p.queue[p.queue.length - 1] : p.dir;
  if (d === last || opposite(d, last) || p.queue.length >= 2) return;
  p.queue.push(d);
  haptic('tick');
  sfx.turn();
}

function move(r, now) {
  if (r.bot) think(r);
  else if (r.queue.length) r.dir = r.queue.shift();
  const nx = r.x + DIRS[r.dir][0];
  const ny = r.y + DIRS[r.dir][1];
  // Snake rule: the tail moves out of the way first.
  while (r.trail.length >= r.len) grid[r.trail.shift()] = 0;
  const out = nx < 0 || ny < 0 || nx >= cols || ny >= rows;
  const hit = out ? 0 : grid[ny * cols + nx];
  if (out || hit) return derez(r, out ? null : hit - 1, now, out ? null : [nx, ny]);
  r.x = nx;
  r.y = ny;
  const idx = ny * cols + nx;
  occupy(r, idx);
  if (sparks.has(idx)) {
    sparks.delete(idx);
    r.len += r.bot ? 4 : 5;
    r.energy = Math.min(1, r.energy + 0.35);
    burst(cx(idx), cy(idx), r.color, 14, 2.2);
    if (!r.bot) {
      stats.sparks++;
      addScore(25 + wave * 5, cx(idx), cy(idx));
      haptic('tap');
      sfx.spark();
      pulse(cx(idx), cy(idx));
    }
    spawnSpark();
  }
}

function derez(r, by, now, at) {
  r.alive = false;
  r.dying = now;
  r.boosting = false;
  const hx = at ? cx(at[1] * cols + at[0]) : ox + (r.x + 0.5 + DIRS[r.dir][0] * 0.5) * cell;
  const hy = at ? cy(at[1] * cols + at[0]) : oy + (r.y + 0.5 + DIRS[r.dir][1] * 0.5) * cell;
  burst(hx, hy, r.color, 60, 5);
  burst(hx, hy, '#ffffff', 18, 3);
  pulse(hx, hy);
  if (!r.bot) {
    shake = 14;
    haptic('error');
    sfx.crash();
    sfx.engine(false);
    setTimeout(gameOver, 1100);
    return;
  }
  sfx.kill();
  if (by === 0) {
    stats.kills++;
    addScore(100 * wave, hx, hy, 'DEREZZED');
    haptic('press');
    shake = 6;
  }
}

function addScore(n, x, y, label) {
  score += n;
  floats.push({ x, y, text: label ? `${label} +${n}` : `+${n}`, born: performance.now(), big: !!label });
}

function burst(x, y, color, n, speed) {
  for (let k = 0; k < n && parts.length < 1600; k++) {
    const a = Math.random() * Math.PI * 2;
    const v = (0.3 + Math.random()) * speed;
    parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1, decay: 0.012 + Math.random() * 0.02, color, size: 1 + Math.random() * 2.2 });
  }
}

// ── The loop ──
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(50, now - last);
  last = now;
  pollPad();
  if (mode === 'ready' && now >= readyAt) {
    mode = 'play';
    runStart = runStart || now;
    sfx.count(true);
    banner('Go');
    sfx.engine(true, 0);
  }
  if (mode === 'play') update(dt, now);
  draw(now, dt);
}

let lastHud = 0;
function update(dt, now) {
  const p = riders[0];
  for (const r of riders) {
    if (!r.alive) {
      // Dying: the wall shatters from the tail.
      const step = Math.max(1, Math.ceil(r.trail.length * dt / 380));
      for (let k = 0; k < step && r.trail.length; k++) {
        const idx = r.trail.shift();
        if (grid[idx] === r.i + 1) grid[idx] = 0;
        if (Math.random() < 0.7) burst(cx(idx), cy(idx), r.color, 2, 1.4);
      }
      continue;
    }
    if (r.boosting) {
      r.energy -= dt / 2200;
      if (r.energy <= 0) {
        r.energy = 0;
        r.boosting = false;
      }
    } else r.energy = Math.min(1, r.energy + dt / 14000);
    r.acc += dt;
    let period = periodOf(r);
    while (r.alive && r.acc >= period) {
      r.acc -= period;
      move(r, now);
      if (!r.bot && r.alive) score += 1;
      period = periodOf(r);
    }
  }
  if (p.alive && !riders.some((r) => r.bot && (r.alive || r.trail.length))) clearWave(now);
  if (now - lastHud > 90) {
    lastHud = now;
    $('#score').textContent = score.toLocaleString();
    $('#boost').style.transform = `scaleX(${p.energy.toFixed(3)})`;
    document.body.classList.toggle('boosting', p.boosting);
    sfx.engine(p.alive, p.boosting ? 1 : 0.3);
  }
}

function clearWave(now) {
  const bonus = 250 * wave;
  addScore(bonus, vw / 2, vh / 2 + 40, `WAVE ${wave}`);
  haptic('success');
  sfx.wave();
  const keep = riders[0].len;
  newWave(wave + 1);
  riders[0].len = Math.max(16, Math.round(keep * 0.7));
  mode = 'ready';
  readyAt = now + 1500;
  lastCount = 0;
}

function draw(now, dt) {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, vw, vh);
  if (mode === 'title') return;
  let sx = 0;
  let sy = 0;
  if (shake > 0.2) {
    sx = (Math.random() - 0.5) * shake;
    sy = (Math.random() - 0.5) * shake;
    shake *= 0.86;
  }
  g.save();
  g.translate(sx, sy);
  if (gridCanvas) g.drawImage(gridCanvas, 0, 0, vw, vh);
  g.globalCompositeOperation = 'lighter';

  // Sparks: breathing stars of aurora.
  for (const [idx, s] of sparks) {
    const t = Math.max(0, (now - s.born) / 1000);
    const r = cell * (0.28 + Math.sin(t * 5 + idx) * 0.06) * Math.min(1, t * 3);
    const x = cx(idx);
    const y = cy(idx);
    const grad = g.createRadialGradient(x, y, 0, x, y, r * 3.2);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.25, 'rgba(160,255,230,0.6)');
    grad.addColorStop(1, 'rgba(90,120,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(x, y, r * 3.2, 0, Math.PI * 2);
    g.fill();
  }

  // Walls: three strokes per ribbon (haze, glow, white-hot core).
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const r of riders) {
    if (!r.trail.length) continue;
    const frac = r.alive && mode === 'play' ? Math.min(1, r.acc / periodOf(r)) : 0;
    const ahead = r.alive && free(r.x + DIRS[r.dir][0], r.y + DIRS[r.dir][1]) ? frac : Math.min(frac, 0.45);
    const hx = ox + (r.x + 0.5 + DIRS[r.dir][0] * ahead) * cell;
    const hy = oy + (r.y + 0.5 + DIRS[r.dir][1] * ahead) * cell;
    const path = new Path2D();
    path.moveTo(cx(r.trail[0]), cy(r.trail[0]));
    for (let k = 1; k < r.trail.length; k++) path.lineTo(cx(r.trail[k]), cy(r.trail[k]));
    if (r.alive) path.lineTo(hx, hy);
    const fade = r.alive ? 1 : 0.6;
    g.globalAlpha = 0.16 * fade;
    g.strokeStyle = r.color;
    g.lineWidth = cell * 1.1;
    g.stroke(path);
    g.globalAlpha = 0.55 * fade;
    g.lineWidth = cell * 0.46;
    g.stroke(path);
    g.globalAlpha = 0.9 * fade;
    g.strokeStyle = r.core;
    g.lineWidth = Math.max(1.5, cell * 0.14);
    g.stroke(path);
    g.globalAlpha = 1;
    if (r.alive) drawCycle(r, hx, hy, now);
  }

  // Particles.
  for (let k = parts.length - 1; k >= 0; k--) {
    const q = parts[k];
    q.x += q.vx * dt * 0.06;
    q.y += q.vy * dt * 0.06;
    q.vx *= 0.985;
    q.vy *= 0.985;
    q.life -= q.decay * dt * 0.06;
    if (q.life <= 0) {
      parts.splice(k, 1);
      continue;
    }
    g.globalAlpha = q.life;
    g.fillStyle = q.color;
    g.fillRect(q.x - q.size / 2, q.y - q.size / 2, q.size, q.size);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  // Floating scores.
  g.textAlign = 'center';
  for (let k = floats.length - 1; k >= 0; k--) {
    const f = floats[k];
    const t = Math.max(0, (now - f.born) / 1000);
    if (t > 1.1) {
      floats.splice(k, 1);
      continue;
    }
    g.globalAlpha = 1 - t / 1.1;
    g.font = `700 ${f.big ? 15 : 11}px 'Martian Mono', ui-monospace, monospace`;
    g.fillStyle = f.big ? '#ffe9a8' : '#eafff9';
    g.shadowColor = f.big ? '#ffb03b' : '#5cffd6';
    g.shadowBlur = 12;
    g.fillText(f.text, f.x, f.y - 14 - t * 34);
  }
  g.shadowBlur = 0;
  g.globalAlpha = 1;

  if (mode === 'ready') {
    const left = Math.ceil((readyAt - now) / 500);
    if (left !== lastCount && left > 0) {
      lastCount = left;
      sfx.count(false);
      banner(String(left));
    }
  }
  g.restore();
}
let lastCount = 0;

function drawCycle(r, x, y, now) {
  const ang = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[r.dir];
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  const s = cell;
  const glow = g.createRadialGradient(0, 0, 0, 0, 0, s * (r.boosting ? 2.6 : 1.8));
  glow.addColorStop(0, 'rgba(255,255,255,0.9)');
  glow.addColorStop(0.3, r.color);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalAlpha = 0.55 + Math.sin(now / 90) * 0.1;
  g.fillStyle = glow;
  g.beginPath();
  g.arc(0, 0, s * (r.boosting ? 2.6 : 1.8), 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 1;
  // The bike: a sleek chevron with a hot nose.
  g.fillStyle = r.core;
  g.beginPath();
  g.moveTo(s * 0.75, 0);
  g.lineTo(-s * 0.35, -s * 0.38);
  g.lineTo(-s * 0.15, 0);
  g.lineTo(-s * 0.35, s * 0.38);
  g.closePath();
  g.fill();
  if (r.boosting) {
    g.strokeStyle = r.color;
    g.lineWidth = 2;
    for (let k = 0; k < 3; k++) {
      const off = (k - 1) * s * 0.22;
      g.globalAlpha = 0.6 - k * 0.12;
      g.beginPath();
      g.moveTo(-s * 0.5, off);
      g.lineTo(-s * (1.6 + Math.random() * 0.8), off);
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  g.restore();
}

// ── Flow: title → ready → play → over ──
function show(id) {
  for (const c of ['title', 'over', 'paused']) $(`#${c}`).hidden = c !== id;
  document.body.classList.toggle('playing', mode === 'play' || mode === 'ready');
  document.body.classList.toggle('paused', mode === 'paused');
}

function start() {
  sfx.unlock();
  measure();
  pickGrid();
  fit();
  score = 0;
  stats = { sparks: 0, kills: 0 };
  floats = [];
  runStart = 0;
  newWave(1);
  mode = 'ready';
  readyAt = performance.now() + 1500;
  lastCount = 0;
  show(null);
  field?.set({ autonomy: 0.6 });
  haptic('press');
}

function gameOver() {
  mode = 'over';
  const secs = runStart ? Math.round((performance.now() - runStart) / 1000) : 0;
  const isBest = score > best;
  if (isBest) {
    best = score;
    store.set(BEST_KEY, String(best));
  }
  $('#overScore').textContent = score.toLocaleString();
  $('#newBest').hidden = !isBest || score === 0;
  $('#overStats').innerHTML = [['Wave', wave], ['Sparks', stats.sparks], ['Derezzed', stats.kills], ['Time', `${secs}s`], ['Best', best.toLocaleString()], ['Length', riders[0]?.len ?? 0]]
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
  show('over');
  field?.set({ autonomy: 1 });
  if (isBest && score) haptic('success');
  if (homeReady) back();
}

function pause() {
  if (mode !== 'play' && mode !== 'ready') return;
  mode = 'paused';
  sfx.engine(false);
  show('paused');
}
function resume() {
  if (mode !== 'paused') return;
  mode = 'ready';
  readyAt = performance.now() + 900;
  last = performance.now();
  lastCount = 0;
  show(null);
}
function quit() {
  mode = 'title';
  sfx.engine(false);
  riders = [];
  renderTitle();
  show('title');
  field?.set({ autonomy: 1 });
}

let bannerTimer;
function banner(text) {
  const el = $('#banner');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 1400);
}

function renderTitle() {
  $('#bestLine').textContent = best ? `Best ${best.toLocaleString()}` : '';
}

// ── Away from home: talk to the app that framed us ──
let homeReady = false;
function back() {
  if (EMBEDDED) window.parent.postMessage({ hearth: 'back' }, '*');
}
addEventListener('message', (e) => {
  if (e.source !== window.parent || e.data?.hearth !== 'home') return;
  homeReady = true;
  // Never yank someone out mid-race: offer the way back, take it when the race ends.
  if (mode === 'play' || mode === 'ready' || mode === 'paused') $('#homePill').hidden = false;
  else back();
});
$('#closeBtn').hidden = !EMBEDDED || AWAY;
if (AWAY) {
  document.body.classList.add('away');
  $('#kicker').textContent = 'Away from home';
  $('#lede').textContent = "Hearth can't reach your TVs from here. It reconnects by itself the moment you're home. Until then, ride.";
  $('#retryBtn').hidden = !EMBEDDED;
}

// ── Input: swipe, tap a side, hold to boost; keys; gamepads ──
const touch = $('#touch');
let ptr = null;
touch.addEventListener('pointerdown', (e) => {
  if (mode !== 'play' && mode !== 'ready') return;
  sfx.unlock();
  ptr = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false, boost: false };
  try {
    touch.setPointerCapture(e.pointerId);
  } catch {}
  ptr.timer = setTimeout(() => {
    if (!ptr || ptr.moved) return;
    ptr.boost = true;
    setBoost(true);
  }, 190);
});
touch.addEventListener('pointermove', (e) => {
  if (!ptr || e.pointerId !== ptr.id) return;
  const dx = e.clientX - ptr.x;
  const dy = e.clientY - ptr.y;
  if (Math.hypot(dx, dy) < 22) return;
  ptr.moved = true;
  steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
  // Re-anchor so one finger can carve a whole zig-zag.
  ptr.x = e.clientX;
  ptr.y = e.clientY;
});
const lift = (e) => {
  if (!ptr || e.pointerId !== ptr.id) return;
  clearTimeout(ptr.timer);
  if (ptr.boost) setBoost(false);
  else if (!ptr.moved && e.type === 'pointerup') {
    const p = riders[0];
    const heading = p.queue.length ? p.queue[p.queue.length - 1] : p.dir;
    steer(turnOf(heading, e.clientX < vw / 2 ? 'left' : 'right'));
  }
  ptr = null;
};
touch.addEventListener('pointerup', lift);
touch.addEventListener('pointercancel', lift);

function setBoost(on) {
  const p = riders[0];
  if (!p?.alive) return;
  p.boosting = on && p.energy > 0.05;
  if (p.boosting) haptic('hold');
}

const KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
addEventListener('keydown', (e) => {
  sfx.unlock();
  if (KEYS[e.code]) {
    e.preventDefault();
    steer(KEYS[e.code]);
  } else if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    e.preventDefault();
    if (mode === 'title' || mode === 'over') start();
    else setBoost(true);
  } else if (e.code === 'Enter') {
    if (mode === 'title' || mode === 'over') start();
    else if (mode === 'paused') resume();
  } else if (e.code === 'KeyP' || e.code === 'Escape') {
    if (mode === 'paused') resume();
    else pause();
  } else if (e.code === 'KeyM') toggleMute();
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') setBoost(false);
});

const padWas = {};
function pollPad() {
  const pads = navigator.getGamepads?.() ?? [];
  for (const pad of pads) {
    if (!pad) continue;
    const b = (n) => !!pad.buttons[n]?.pressed;
    const ax = pad.axes[0] ?? 0;
    const ay = pad.axes[1] ?? 0;
    const dir = b(12) || ay < -0.6 ? 'up' : b(13) || ay > 0.6 ? 'down' : b(14) || ax < -0.6 ? 'left' : b(15) || ax > 0.6 ? 'right' : null;
    const was = padWas[pad.index] ?? {};
    if (dir && dir !== was.dir) steer(dir);
    const a = b(0) || b(7);
    if (a !== was.a) {
      if (a && (mode === 'title' || mode === 'over')) start();
      else setBoost(a);
    }
    if (b(9) && !was.start) mode === 'paused' ? resume() : mode === 'title' || mode === 'over' ? start() : pause();
    padWas[pad.index] = { dir, a, start: b(9) };
  }
}

const SPEAKER = (on) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/>${on ? '<path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' : '<path d="m16 9.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'}</svg>`;
function toggleMute() {
  $('#muteBtn').innerHTML = SPEAKER(!sfx.toggle());
}

document.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  haptic('tap');
  if (act === 'start') start();
  else if (act === 'resume') resume();
  else if (act === 'quit') quit();
  else if (act === 'back') back();
  else if (act === 'retry' && EMBEDDED) window.parent.postMessage({ hearth: 'retry' }, '*');
});
$('#pauseBtn').addEventListener('click', () => (mode === 'paused' ? resume() : pause()));
$('#muteBtn').addEventListener('click', toggleMute);
$('#muteBtn').innerHTML = SPEAKER(!sfx.muted);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});
addEventListener('resize', () => {
  measure();
  if (cols) fit();
  field?.resize();
});

// Installed on its own (mutaafaziz.com/hearth/racer/), it keeps itself offline.
if (!EMBEDDED && 'serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

measure();
renderTitle();
show('title');
if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mountField);
else mountField();
requestAnimationFrame(frame);
