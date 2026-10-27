import assert from 'node:assert/strict';
import test from 'node:test';
import { tvText } from '../src/drivers/lg.js';

test('on-screen messages: emoji out (webOS has no glyphs for them), plain quotes, trimmed', () => {
  assert.equal(tvText('Dinner’s ready! 🍽️'), "Dinner's ready!");
  assert.equal(tvText('👋🏽 Come “downstairs”  now'), 'Come "downstairs" now');
  assert.equal(tvText('🌙'), '');
  assert.equal(tvText('x'.repeat(200)).length, 120);
});
