import os from 'node:os';
import path from 'node:path';
import { queue, readJson, writeJson } from './jsonfile.js';

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

  // A corrupt or half-written file falls back to tvs.json.bak (the previous
  // good copy), else starts empty with the bad file kept aside. Never throws.
  load() {
    return readJson(this.file, (d) => (Array.isArray(d?.tvs) ? d.tvs : undefined), []);
  }

  // Saves are queued: a pairing key and a rename can land in the same tick,
  // and overlapping temp-file renames would lose one of them.
  #enqueue = queue();

  save(tvs) {
    // Pairing keys are in here; writeJson keeps the file readable by this user only.
    const snapshot = { version: 1, tvs: JSON.parse(JSON.stringify(tvs)) };
    return this.#enqueue(() => writeJson(this.file, snapshot));
  }
}
