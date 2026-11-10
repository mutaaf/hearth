import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from '../src/worker/ai/providers.js';

test("a used-up shared allowance gets a plain message", () => {
  const err = new Error("Prompter: today's shared AI allowance for hearth is used up. It resets at 00:00 UTC.");
  assert.match(describeError('edge', err), /resting until 00:00 UTC/);
});
