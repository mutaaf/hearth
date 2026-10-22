import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clock, fromAppleTv, keyMemory, livePosition, parseLgMedia, parseRokuPlayer, phaseOf } from '../web/playback.js';

test('Roku player states map to playing/paused/buffering/stopped; live has no duration', () => {
  assert.equal(parseRokuPlayer('<player state="pause"><position>10 ms</position></player>', 5).state, 'paused');
  assert.equal(parseRokuPlayer('<player state="buffer"/>').state, 'buffering');
  assert.equal(parseRokuPlayer('<player state="close"/>').state, 'stopped');
  const live = parseRokuPlayer('<player state="play"><position>9 ms</position><duration>100 ms</duration><is_live>true</is_live></player>');
  assert.equal(live.live, true);
  assert.equal(live.duration, null);
  assert.equal(parseRokuPlayer('garbage'), null);
  assert.equal(parseRokuPlayer('<player state="weird"/>'), null);
});

test('LG media pipeline and Apple TV map to the same shape', () => {
  assert.equal(parseLgMedia({ foregroundAppInfo: [{ appId: 'netflix', playState: 'paused' }] }).state, 'paused');
  assert.equal(parseLgMedia({ foregroundAppInfo: [] }).state, 'stopped');
  assert.equal(parseLgMedia({}), null);
  assert.deepEqual(fromAppleTv({ playing: 'playing', position: 12.4, duration: 60 }, 1), { state: 'playing', position: 12400, duration: 60000, live: false, at: 1, source: 'appletv' });
  assert.equal(fromAppleTv({ playing: null }), null);
});

test('position ticks forward while playing and stops at the end', () => {
  const m = { state: 'playing', position: 1000, duration: 3000, at: 0 };
  assert.equal(livePosition(m, 1500), 2500);
  assert.equal(livePosition(m, 9000), 3000);
  assert.equal(livePosition({ ...m, state: 'paused' }, 1500), 1000);
  assert.equal(clock(3_725_000), '1:02:05');
  assert.equal(clock(65_000), '1:05');
  assert.equal(clock(null), '–:––');
});

test('phase: the TV wins, then the person, then time', () => {
  const now = 1_000_000;
  const streaming = { kind: 'streaming', since: now - 5000 };
  const tv = (media) => ({ state: { media } });
  assert.equal(phaseOf(tv({ state: 'paused', source: 'roku' }), streaming, undefined, now).phase, 'playback');
  assert.equal(phaseOf(tv({ state: 'stopped', source: 'roku' }), streaming, undefined, now).phase, 'browse');
  assert.equal(phaseOf(tv(null), { kind: 'home' }, undefined, now).phase, 'browse');
  assert.equal(phaseOf(tv(null), { kind: 'game' }, undefined, now).phase, 'other');
  assert.equal(phaseOf(tv(null), { kind: 'live-tv' }, undefined, now).phase, 'playback');
  // No signal: just opened → browse; pressed play → playback; arrows → browse; left alone → playback.
  assert.equal(phaseOf(tv(null), streaming, undefined, now).phase, 'browse');
  const keys = keyMemory();
  keys.note('a', 'right', now - 20_000);
  keys.note('a', 'play', now - 10_000);
  assert.equal(phaseOf(tv(null), streaming, keys.get('a'), now).phase, 'playback');
  keys.note('a', 'down', now - 1000);
  assert.equal(phaseOf(tv(null), streaming, keys.get('a'), now).phase, 'browse');
  assert.equal(phaseOf(tv(null), { kind: 'streaming', since: now - 120_000 }, { nav: now - 60_000, play: 0 }, now).phase, 'playback');
});
