import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Everything Hearth remembers (TVs, pairing keys) lives in one JSON file in
// ~/.hearth, outside the repo, so a git pull never touches your setup.
export function hearthHome() {
  return process.env.HEARTH_HOME || path.join(os.homedir(), '.hearth');
}

export class Store {
  constructor(dir = hearthHome()) {
    this.dir = dir;
    this.file = path.join(dir, 'tvs.json');
  }

  async load() {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      return Array.isArray(data.tvs) ? data.tvs : [];
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // Saves are queued: a pairing key and a rename can land in the same tick,
  // and overlapping temp-file renames would lose one of them.
  #queue = Promise.resolve();

  save(tvs) {
    const snapshot = JSON.stringify({ version: 1, tvs }, null, 2) + '\n';
    const run = this.#queue.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      // Pairing keys are in here; keep the file readable by this user only.
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    this.#queue = run.catch(() => {});
    return run;
  }
}
