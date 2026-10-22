import { chmod, copyFile, rename, stat, truncate } from 'node:fs/promises';

// One log line format: "2026-10-21T20:49:52.427Z WARN [hearth] message".
// Lines go to stdout/stderr; launchd and `npm run up` append those to
// ~/.hearth/hearth.log. Never pass credentials (tokens, keys, certs) in.
const stamp = () => new Date().toISOString();
const line = (level, args) => [`${stamp()} ${level}`, ...args];
export const log = {
  quiet: process.env.HEARTH_LOG === 'off' || process.env.NODE_TEST_CONTEXT != null,
  info(...args) {
    if (!this.quiet) console.log(...line('INFO', args));
  },
  warn(...args) {
    if (!this.quiet) console.error(...line('WARN', args));
  },
  error(...args) {
    if (!this.quiet) console.error(...line('ERROR', args));
  },
};

// Size-based rotation that works for a file someone else holds open in
// append mode (launchd's StandardOutPath, up.mjs's 'a' fd): copy it to .1,
// then truncate it in place, so the writers carry on at offset 0.
//   hearth.log (live) → hearth.log.1 → .2 → .3 (dropped)
export async function rotate(file, { maxBytes = 5 * 1024 * 1024, keep = 3 } = {}) {
  let size;
  try {
    size = (await stat(file)).size;
  } catch {
    return false;
  }
  await chmod(file, 0o600).catch(() => {});
  if (size < maxBytes) return false;
  for (let i = keep - 1; i >= 1; i--) await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(() => {});
  await copyFile(file, `${file}.1`);
  await chmod(`${file}.1`, 0o600).catch(() => {});
  await truncate(file, 0);
  return true;
}

export function startLogRotation(file, opts = {}) {
  const check = () => rotate(file, opts).catch((err) => log.warn('[hearth] log rotation failed:', err.message));
  check();
  const timer = setInterval(check, opts.everyMs ?? 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
