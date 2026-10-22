import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { log } from './log.js';

// Crash-safe JSON files for everything Hearth remembers (TVs and their
// pairing keys, scenes, telemetry). A power cut mid-write, an empty file or
// hand-edited junk must never stop Hearth from starting or lose pairings.
//
//  write: temp file (unique name) → fsync → previous good copy → .bak → rename.
//  read:  the file; if it's unreadable, the .bak; if both are bad, the bad
//         file is moved aside (name.corrupt-<time>) and we start empty.

// → the parsed value accepted by `pick`, or `fallback` (missing/corrupt).
export async function readJson(file, pick, fallback = null) {
  const attempt = async (f) => {
    const text = await readFile(f, 'utf8');
    const value = pick(JSON.parse(text));
    if (value === undefined) throw new SyntaxError('unexpected shape');
    return value;
  };
  try {
    return await attempt(file);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Missing: maybe a crash between moving the old copy aside and renaming.
      try {
        return await attempt(`${file}.bak`);
      } catch {
        return fallback;
      }
    }
    log.warn(`${path.basename(file)} is unreadable (${err.message}); trying the backup`);
    try {
      const value = await attempt(`${file}.bak`);
      // Move the bad copy aside, so the next save can't back it up over the good one.
      await rename(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
      log.warn(`${path.basename(file)}: restored from ${path.basename(file)}.bak`);
      return value;
    } catch {
      const aside = `${file}.corrupt-${Date.now()}`;
      await rename(file, aside).catch(() => {});
      log.error(`${path.basename(file)} and its backup are unreadable; moved it to ${path.basename(aside)} and starting fresh`);
      return fallback;
    }
  }
}

export async function writeJson(file, data, { pretty = true, backup = true } = {}) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(data, null, pretty ? 2 : 0) + '\n';
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'w', 0o600);
  try {
    await fh.writeFile(text);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    // The copy being replaced was good (we wrote it); keep it as the backup.
    if (backup) await copyFile(file, `${file}.bak`).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

// One writer per file: saves run in order, the last one wins.
export function queue() {
  let tail = Promise.resolve();
  return (job) => {
    const run = tail.then(job);
    tail = run.catch(() => {});
    return run;
  };
}
