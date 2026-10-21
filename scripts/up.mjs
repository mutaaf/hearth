// npm run up — idempotent: installs what's missing, starts Hearth in the
// background if it isn't already running, prints the phone URL + QR code.
// Safe to run any number of times; on a warm machine it just confirms health.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HEARTH_HOME || path.join(os.homedir(), '.hearth');
const PORT = Number(process.env.HEARTH_PORT) || 8770;
const LOG = path.join(HOME, 'hearth.log');
const PID = path.join(HOME, 'hearth.pid');
const step = (msg) => console.log(`  • ${msg}`);

// 1. Node version. Prevents: lgtv2 failing to load on Node < 20.19 with a
//    cryptic ESM/require error.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 19) || (major === 22 && minor < 12)) {
  console.error(`Hearth needs Node.js 20.19+, 22.12+ or 24+. You have ${process.versions.node}. Get it at https://nodejs.org`);
  process.exit(1);
}
step(`Node ${process.versions.node}`);

// 2. Dependencies. Prevents: "Cannot find package 'lgtv2'" after a fresh
//    clone or a pull that added a dependency.
const lock = path.join(ROOT, 'node_modules', '.package-lock.json');
const stale = !existsSync(lock) || statSync(path.join(ROOT, 'package.json')).mtimeMs > statSync(lock).mtimeMs;
if (stale) {
  step('Installing dependencies…');
  const npm = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (npm.status !== 0) process.exit(npm.status ?? 1);
} else step('Dependencies up to date');

// 2b. Apple TV support: a private Python venv with a pinned pyatv. Optional:
//     without python3 Hearth still runs, and Apple TVs say how to fix it.
//     Prevents: "pyatv is not installed", a venv broken by `brew upgrade
//     python` (its interpreter symlink dangles), and drifting pyatv versions.
const { PYATV_VERSION, venvDir, venvPython } = await import('../src/atv-bridge.js');
appleTvSetup();

function appleTvSetup() {
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, ...opts });
  const VENV = venvDir();
  const PY = venvPython();
  const pyatvVersion = () => {
    const r = run(PY, ['-c', 'from importlib.metadata import version; print(version("pyatv"))']);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  if (existsSync(PY) && pyatvVersion() === PYATV_VERSION) return step(`Apple TV support ready (pyatv ${PYATV_VERSION})`);

  const python = ['python3', 'python'].find((p) => {
    const r = run(p, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)']);
    return r.status === 0;
  });
  if (!python) {
    return step('Apple TV support skipped: needs Python 3.10+ (macOS: `brew install python`). Everything else works.');
  }
  // A venv whose interpreter no longer runs (Python upgraded underneath it)
  // is rebuilt from scratch.
  const broken = existsSync(PY) && run(PY, ['-c', 'pass']).status !== 0;
  if (!existsSync(PY) || broken) {
    step(`${broken ? 'Rebuilding' : 'Creating'} the Apple TV Python environment (${VENV})…`);
    mkdirSync(path.dirname(VENV), { recursive: true });
    const made = run(python, ['-m', 'venv', ...(broken ? ['--clear'] : []), VENV]);
    if (made.status !== 0) return step(`Apple TV support skipped: couldn't create a venv (${(made.stderr || '').trim().split('\n').pop()})`);
  }
  step(`Installing pyatv ${PYATV_VERSION} for Apple TV…`);
  const pip = run(PY, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', `pyatv==${PYATV_VERSION}`]);
  if (pip.status !== 0 || pyatvVersion() !== PYATV_VERSION) {
    return step(`Apple TV support skipped: pip couldn't install pyatv (${(pip.stderr || '').trim().split('\n').pop() || 'unknown error'})`);
  }
  step(`Apple TV support ready (pyatv ${PYATV_VERSION})`);
}

const health = () =>
  fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(1000) })
    .then((r) => r.json())
    .then((j) => j.name === 'hearth')
    .catch(() => false);

// 3. Start, unless it's already up. Prevents: EADDRINUSE from a second copy.
if (await health()) {
  step(`Already running on port ${PORT}`);
} else {
  mkdirSync(HOME, { recursive: true });
  const out = openSync(LOG, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'hearth.js')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  writeFileSync(PID, String(child.pid));
  child.unref();
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await health();
  }
  if (!up) {
    console.error(`Hearth didn't start. Last lines of ${LOG}:`);
    spawnSync('tail', ['-n', '20', LOG], { stdio: 'inherit' });
    process.exit(1);
  }
  step(`Started in the background (logs: ${LOG})`);
}

const ip = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
const url = `http://${ip ?? 'localhost'}:${PORT}`;
console.log(`\n  🔥 Hearth is ready\n\n  This computer:  http://localhost:${PORT}\n  Your phone:     ${url}  (same Wi-Fi — scan below)\n`);
if (ip) {
  const { default: qrcode } = await import('qrcode-terminal');
  qrcode.generate(url, { small: true }, (qr) => console.log(qr.replace(/^/gm, '  ')));
}
console.log('  Stop it any time with: npm run down\n');
