// npm run down — stops the background Hearth started by `npm run up`.
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PID = path.join(process.env.HEARTH_HOME || path.join(os.homedir(), '.hearth'), 'hearth.pid');

let pid;
try {
  pid = Number(readFileSync(PID, 'utf8'));
} catch {
  console.log('  Hearth is not running (no pid file).');
  process.exit(0);
}
try {
  process.kill(pid, 'SIGTERM');
  console.log(`  Stopped Hearth (pid ${pid}).`);
} catch (err) {
  console.log(err.code === 'ESRCH' ? '  Hearth was already stopped.' : `  Could not stop pid ${pid}: ${err.message}`);
}
rmSync(PID, { force: true });
