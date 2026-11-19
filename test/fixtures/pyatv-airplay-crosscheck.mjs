// By hand, not part of npm test (needs pyatv): pyatv's own AirPlay client
// against test/fixtures/fake-airplay.js, both ways.
//   node test/fixtures/pyatv-airplay-crosscheck.mjs   (uses ~/.hearth/py, or HEARTH_VENV)
// 1. Hearth (JS) pairs; pyatv connects with that credential, tunnels MRP and
//    reads what's playing. 2. pyatv pairs; Hearth connects with pyatv's
//    credential and reads the same. Exits non-zero if either side fails.
// pyatv logs "failed to process data frame" for every empty "rply" frame;
// that is pyatv reading replies, and happens with real Apple TVs too.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { venvPython } from '../../src/atv-bridge.js';
import { AirPlaySession, beginAirPlayPairing } from '../../src/atv/airplay.js';
import { MrpClient } from '../../src/atv/mrp.js';
import { FakeAirPlay } from './fake-airplay.js';

const v = JSON.parse(readFileSync(new URL('./pyatv-airplay-vectors.json', import.meta.url), 'utf8'));
const fake = await new FakeAirPlay().listen();
const pushes = setInterval(() => fake.push(Buffer.from(v.setNowPlayingClient, 'hex'), Buffer.from(v.setState, 'hex')), 300);
let ok = true;
try {
  const pairing = await beginAirPlayPairing({ host: '127.0.0.1', port: fake.port });
  const credsJs = await pairing.finish(fake.pin);
  const script = new URL('./pyatv-airplay-crosscheck.py', import.meta.url).pathname;
  // Async spawn so this process keeps serving the fake meanwhile.
  const out = await new Promise((resolve) => {
    const child = spawn(venvPython(), ['-I', script, String(fake.port), credsJs, fake.pin], { stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', (d) => (text += d));
    child.on('close', (code) => resolve({ code, text }));
  });
  process.stdout.write(out.text);
  if (out.code !== 0) ok = false;
  const credsPy = out.text.match(/^CREDS (\S+)$/m)?.[1];
  if (credsPy) {
    const s = new AirPlaySession({ host: '127.0.0.1', port: fake.port, credentials: credsPy });
    await s.connect();
    const mrp = await new MrpClient(s.dataChannel).start();
    await new Promise((r) => setTimeout(r, 800));
    const snap = mrp.snapshot();
    console.log('Hearth with pyatv’s credential:', JSON.stringify(snap));
    if (snap.title !== 'Porch Lights: The Long Night In') ok = false;
    s.close();
  } else ok = false;
} finally {
  clearInterval(pushes);
  await fake.close();
}
console.log(ok ? 'cross-check OK' : 'cross-check FAILED');
process.exit(ok ? 0 : 1);
