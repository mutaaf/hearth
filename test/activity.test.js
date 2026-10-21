import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, suggestedMode, summarize } from '../src/activity.js';

const on = (state) => ({ state: { online: true, power: 'on', ...state } });

test('off and standby', () => {
  assert.equal(classify({ state: { online: false, power: 'off' } }).kind, 'off');
  assert.equal(classify(on({ power: 'standby' })).kind, 'idle');
  assert.equal(classify(on({ power: 'screen_saver' })).kind, 'idle');
});

test('LG HDMI input named by CEC: a console is a game', () => {
  const a = classify(on({ app: 'com.webos.app.hdmi2', inputLabel: 'PlayStation 5' }));
  assert.deepEqual([a.kind, a.label, a.source], ['console', 'PlayStation 5', 'hdmi-input']);
  assert.ok(a.confidence >= 0.9);
  assert.equal(classify(on({ app: 'com.webos.app.hdmi1', inputLabel: 'Xbox Series X' })).kind, 'console');
  assert.equal(classify(on({ app: 'com.webos.app.hdmi3', inputLabel: 'Apple TV' })).kind, 'streaming');
  assert.equal(classify(on({ app: 'com.webos.app.hdmi4', inputLabel: 'Xfinity box' })).kind, 'live-tv');
  const plain = classify(on({ app: 'com.webos.app.hdmi1' }));
  assert.deepEqual([plain.kind, plain.label], ['unknown', 'HDMI 1']);
});

test('Roku TV inputs come as tvinput.hdmiN with a title', () => {
  assert.equal(classify(on({ app: 'tvinput.hdmi1', appTitle: 'Nintendo Switch' })).kind, 'console');
  assert.equal(classify(on({ app: 'tvinput.dtv', appTitle: 'Live TV' })).kind, 'live-tv');
});

test('browsers by id and by title', () => {
  for (const app of ['com.webos.app.browser', 'org.tizen.browser', 'com.android.chrome', 'org.mozilla.tv.firefox']) {
    assert.equal(classify(on({ app })).kind, 'browser', app);
  }
  assert.equal(classify(on({ app: '61322', appTitle: 'Web Browser X' })).kind, 'browser');
});

test('games and cloud gaming', () => {
  assert.equal(classify(on({ app: 'com.nvidia.geforcenow' })).kind, 'game');
  assert.equal(classify(on({ app: '123', appTitle: 'Xbox Cloud Gaming' })).kind, 'game');
  assert.equal(classify(on({ app: '99', appTitle: 'Amazon Luna' })).kind, 'game');
  assert.equal(classify(on({ app: '55', appTitle: 'Roku Games: Pac-Man' })).kind, 'game');
});

test('streaming, music, live TV, home', () => {
  assert.equal(classify(on({ app: 'netflix' })).kind, 'streaming');
  assert.equal(classify(on({ app: 'com.disney.disneyplus-prod' })).kind, 'streaming');
  assert.equal(classify(on({ app: '12', appTitle: 'Netflix' })).kind, 'streaming');
  assert.equal(classify(on({ app: 'CC32E753', appTitle: 'Spotify' })).kind, 'music');
  assert.equal(classify(on({ app: '233637DE', appTitle: 'YouTube' })).kind, 'streaming');
  assert.equal(classify(on({ app: 'x', appTitle: 'YouTube Music' })).kind, 'music');
  assert.equal(classify(on({ app: 'com.webos.app.livetv' })).kind, 'live-tv');
  assert.equal(classify(on({ app: 'com.webos.app.home' })).kind, 'home');
  assert.equal(classify(on({ app: null, appTitle: 'Roku Dynamic Menu' })).kind, 'home');
  assert.equal(classify(on({})).kind, 'home');
});

test('summary and suggested remote', () => {
  const s = summarize([{ kind: 'game' }, { kind: 'console' }, { kind: 'browser' }, { kind: 'streaming' }, { kind: 'off' }, { kind: 'home' }]);
  assert.equal(s, '2 games, 1 browser, 1 streaming');
  assert.equal(summarize([{ kind: 'off' }]), '');
  assert.equal(suggestedMode({ kind: 'browser' }), 'trackpad');
  assert.equal(suggestedMode({ kind: 'console' }), 'gamepad');
  assert.equal(suggestedMode({ kind: 'streaming' }), 'remote');
});
