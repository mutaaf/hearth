#!/usr/bin/env node
import os from 'node:os';
import qrcode from 'qrcode-terminal';
import { discover } from '../src/discovery.js';
import { Hub } from '../src/hub.js';
import { Scenes } from '../src/scenes.js';
import { createServer } from '../src/server.js';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { log, startLogRotation } from '../src/log.js';
import { hearthHome, Store } from '../src/store.js';
import { Household } from '../src/household.js';

const PORT = Number(process.env.HEARTH_PORT) || 8770;
const HOST = process.env.HEARTH_HOST || '0.0.0.0';

export function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

async function scan() {
  console.log('Looking for TVs on your network…');
  const tvs = await discover();
  if (!tvs.length) {
    console.log('No TVs answered. Make sure they are on and on the same Wi-Fi as this computer.');
    return;
  }
  console.table(tvs.map(({ brand, name, model, ip }) => ({ brand, name, model, ip })));
}

// One bad TV, socket or frame must never take every TV down: log it and
// carry on. Only the HTTP server failing for good exits (launchd restarts it).
function safetyNet() {
  process.on('uncaughtException', (err) => log.error('[hearth] uncaught:', err?.stack ?? err));
  process.on('unhandledRejection', (err) => log.error('[hearth] unhandled rejection:', err?.stack ?? err));
}

async function serve() {
  safetyNet();
  const home = hearthHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700).catch(() => {}); // pairing keys live here
  startLogRotation(path.join(home, 'hearth.log'));
  const hub = await new Hub({ store: new Store() }).init();
  hub.startAutoDiscovery();
  hub.scenes = await new Scenes({ hub }).init();
  hub.scenes.start();
  // Only phones that joined the house may work the TVs (HEARTH_OPEN=1: anyone on the LAN).
  const household = process.env.HEARTH_OPEN === '1' ? null : await new Household().init();
  const server = createServer(hub, { household });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Is Hearth already running? Try: npm run down`);
    else log.error('[hearth] server failed:', err?.stack ?? err);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const [ip] = lanAddresses();
    const url = `http://${ip ?? 'localhost'}:${PORT}`;
    console.log(`\n  🔥 Hearth is running\n\n  On this computer:   http://localhost:${PORT}`);
    console.log(`  On your phone:      ${url}   (same Wi-Fi)`);
    if (process.env.HEARTH_FRIENDLY_URL) console.log(`  Friendly address:   ${process.env.HEARTH_FRIENDLY_URL}`);
    console.log('');
    if (ip) qrcode.generate(url, { small: true }, (qr) => console.log(qr.replace(/^/gm, '  ')));
    // (Never the code itself: this output ends up in log files.)
    if (household) console.log(`  New phones join with the house code: open http://localhost:${PORT} here → ⚙ → Phones in this house, or run: npm run code\n`);
    else console.log('  HEARTH_OPEN=1: anyone on this network can use Hearth.\n');
    console.log(`  ${hub.tvs.length} TV${hub.tvs.length === 1 ? '' : 's'} remembered. Ctrl+C to stop.\n`);
  });
  // A hung driver stop() can't block exit: 5 s, then out anyway.
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(0), 5000).unref();
    hub.scenes?.stop();
    server.close();
    server.closeAllConnections?.();
    await hub.close().catch((err) => log.error('[hearth] shutdown:', err?.message ?? err));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// The house code, for the person at this computer (their terminal only).
async function showCode() {
  const household = await new Household().init();
  console.log(`\n  House code: ${household.code.replace(/(\d{3})(\d{3})/, '$1 $2')}\n\n  Type it on a new phone when Hearth asks. ${household.devices().length} phone(s) in the house.\n`);
}

const command = process.argv[2];
if (command === 'scan') await scan().then(() => process.exit(0));
else if (command === 'code') await showCode().then(() => process.exit(0));
else if (!command || command === 'serve') await serve();
else {
  console.log('Usage: hearth [serve|scan|code]');
  process.exit(1);
}
