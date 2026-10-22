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
  const server = createServer(hub);
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

const command = process.argv[2];
if (command === 'scan') await scan().then(() => process.exit(0));
else if (!command || command === 'serve') await serve();
else {
  console.log('Usage: hearth [serve|scan]');
  process.exit(1);
}
