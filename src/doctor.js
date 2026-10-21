import net from 'node:net';
import { macFor } from './discovery.js';
import { wake as sendWake } from './wol.js';

// The connection doctor: one tap, a visible checklist, a fix where one exists.
//   1 network   is the TV answering on its control port?
//   2 wake      if not and it can be woken: Wake-on-LAN, wait up to 25 s
//   3 find      still nothing: look for it again (it may have a new address)
//   4 reconnect restart Hearth's connection to it
//   5 verify    a harmless read, plus "does it still trust our key?"
//   6 pair      if not trusted: say exactly which pairing step fixes it
// Each step reports plain words (detail) and the raw facts (nerd).

export const PORTS = { lg: [3001, 3000], samsung: [8001, 8002], roku: [8060], androidtv: [8009, 6466], appletv: [7000] };
const LABEL = {
  network: 'On the network?',
  wake: 'Wake it up',
  find: 'Look for it again',
  reconnect: 'Reconnect',
  verify: 'Check it answers',
  pair: 'Trust',
};
const HOW_TEXT = {
  'lg-pin': 'Pair again: the TV shows a number, you type it in Hearth.',
  'lg-allow': 'Pair again: press Allow on the TV.',
  'samsung-allow': 'Pair again: press Allow on the TV if it asks.',
  'googletv-code': 'Unlock the full remote again: type the code shown on the TV.',
  'appletv-pin': 'Pair again: the Apple TV shows a 4-digit code, you type it in Hearth.',
  'roku-network-access': 'On the Roku: Settings → System → Advanced system settings → Control by mobile apps → Network access → Default.',
};

function tcpProbe(ip, port, timeout = 1500) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host: ip, port, timeout });
    const done = (ok, error) => {
      sock.destroy();
      resolve({ ok, port, ms: Date.now() - t0, error });
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (err) => done(false, err.code));
  });
}

export const defaultDeps = {
  probe: async (ip, ports) => {
    const results = [];
    for (const port of ports) {
      const r = await tcpProbe(ip, port);
      results.push(r);
      if (r.ok) break;
    }
    return { up: results.some((r) => r.ok), results };
  },
  macFor,
  wake: (macs, ip) => sendWake(macs, ip),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

export async function runDoctor(hub, id, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const tv = hub.get(id);
  const startIp = tv.ip; // tv is live: relocate() changes tv.ip under us
  const steps = [];
  const report = { id, name: tv.name, brand: tv.brand, ok: false, steps, needsPairing: false, how: null, healed: null };
  const emit = (step, status, detail, nerd = null) => {
    const entry = { step, label: LABEL[step], status, detail, nerd };
    const i = steps.findIndex((s) => s.step === step);
    if (i >= 0) steps[i] = entry;
    else steps.push(entry);
    hub.emit('doctor', { id, ...entry });
  };
  const ports = PORTS[tv.brand] ?? [];

  // 1 · network
  emit('network', 'running', 'Looking for it on your Wi-Fi…');
  let net1 = await d.probe(tv.ip, ports);
  const mac = await d.macFor(tv.ip).catch(() => null);
  const nerd1 = { ip: tv.ip, ports: net1.results, arpMac: mac };
  if (net1.up) emit('network', 'ok', `Answering at ${tv.ip}`, nerd1);
  else emit('network', 'warn', `Not answering at ${tv.ip}`, nerd1);

  // 2 · wake
  if (!net1.up) {
    if (tv.macs?.length) {
      emit('wake', 'running', 'Sending the wake-up signal…');
      await d.wake(tv.macs, tv.ip).catch(() => {});
      const t0 = d.now();
      while (d.now() - t0 < 25_000 && !net1.up) {
        await d.sleep(2500);
        net1 = await d.probe(tv.ip, ports);
      }
      if (net1.up) emit('wake', 'ok', `Woke up in ${Math.round((d.now() - t0) / 1000)} s`, { macs: tv.macs, ports: net1.results });
      else emit('wake', 'warn', 'It didn’t wake up. It may be unplugged, or Wake-on-LAN is off in its settings.', { macs: tv.macs });
    } else {
      emit('wake', 'warn', 'Hearth doesn’t know how to wake this one (no network address learned yet).');
    }
  } else {
    emit('wake', 'ok', 'Not needed: it’s awake');
  }

  // 3 · find (maybe it moved)
  if (!net1.up) {
    emit('find', 'running', 'Searching the whole network…');
    await hub.scan().catch(() => []);
    const after = hub.get(id);
    if (after.ip !== startIp) {
      report.healed = { from: startIp, to: after.ip };
      emit('find', 'ok', `Found it at a new address: ${after.ip}`, report.healed);
      net1 = await d.probe(after.ip, ports);
    } else {
      emit('find', 'fail', 'Couldn’t find it. Is it plugged in, switched on at the wall, and on the same Wi-Fi?');
      emit('reconnect', 'fail', 'Skipped: the TV isn’t on the network');
      emit('verify', 'fail', 'Skipped');
      return finish(report);
    }
  } else {
    emit('find', 'ok', 'Not needed: same address as before');
  }

  // 4 · reconnect
  emit('reconnect', 'running', 'Restarting Hearth’s connection…');
  const driver = hub.driver(id);
  const cur = hub.get(id);
  try {
    await driver.stop();
    if (cur.credentials) driver.start();
    else if (cur.brand === 'roku' || cur.brand === 'androidtv') await hub.pair(id); // nothing to approve
    emit('reconnect', 'ok', cur.credentials || cur.brand === 'roku' || cur.brand === 'androidtv' ? 'Reconnected' : 'Ready to pair');
  } catch (err) {
    emit('reconnect', 'warn', err.message, { status: err.status ?? null });
  }

  // 5 · verify
  emit('verify', 'running', 'Asking it a harmless question…');
  let v;
  try {
    v = await hub.driver(id).verify();
  } catch (err) {
    v = { ok: false, auth: 'ok', detail: err.message };
  }
  emit('verify', v.ok ? 'ok' : 'fail', v.ok ? v.detail || 'It answered' : `It didn’t answer: ${v.detail}`, { auth: v.auth, raw: v.detail });

  // 6 · trust
  if (v.auth === 'missing' || v.auth === 'rejected' || v.auth === 'prompt') {
    report.needsPairing = true;
    report.how = v.how ?? defaultHow(cur.brand);
    emit('pair', 'warn', HOW_TEXT[report.how] ?? 'Pair it again.', { auth: v.auth });
  } else if (v.ok) {
    emit('pair', 'ok', 'It still trusts Hearth');
  }
  report.ok = Boolean(v.ok) && !report.needsPairing;
  return finish(report);
}

const defaultHow = (brand) => ({ lg: 'lg-pin', samsung: 'samsung-allow', androidtv: 'googletv-code', roku: 'roku-network-access', appletv: 'appletv-pin' })[brand] ?? null;

function finish(report) {
  report.summary = report.ok
    ? report.healed
      ? `Fixed: it had moved to ${report.healed.to}.`
      : 'All good: connected and answering.'
    : report.needsPairing
      ? HOW_TEXT[report.how] ?? 'Pair it again.'
      : report.steps.find((s) => s.status === 'fail')?.detail ?? 'Something is still wrong.';
  return report;
}

// "Fix everything": every TV at once, each with its own report.
export async function runDoctorAll(hub, deps = {}) {
  const results = await Promise.allSettled(hub.tvs.map((t) => runDoctor(hub, t.id, deps)));
  return results.map((r, i) => (r.status === 'fulfilled' ? r.value : { id: hub.tvs[i].id, name: hub.tvs[i].name, ok: false, summary: r.reason?.message ?? 'Failed', steps: [] }));
}
