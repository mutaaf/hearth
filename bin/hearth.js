#!/usr/bin/env node
import os from 'node:os';
import qrcode from 'qrcode-terminal';
import { discover } from '../src/discovery.js';
import { Hub } from '../src/hub.js';
import { createServer } from '../src/server.js';
import { Store } from '../src/store.js';

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

async function serve() {
  const hub = await new Hub({ store: new Store() }).init();
  const server = createServer(hub);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Is Hearth already running? Try: npm run down`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const [ip] = lanAddresses();
    const url = `http://${ip ?? 'localhost'}:${PORT}`;
    console.log(`\n  🔥 Hearth is running\n\n  On this computer:   http://localhost:${PORT}`);
    console.log(`  On your phone:      ${url}   (same Wi-Fi)\n`);
    if (ip) qrcode.generate(url, { small: true }, (qr) => console.log(qr.replace(/^/gm, '  ')));
    console.log(`  ${hub.tvs.length} TV${hub.tvs.length === 1 ? '' : 's'} remembered. Ctrl+C to stop.\n`);
  });
  const shutdown = async () => {
    server.close();
    await hub.close();
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
