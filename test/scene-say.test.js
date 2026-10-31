import assert from 'node:assert/strict';
import test from 'node:test';
import { restoreScene, sanitizeSceneRequest, sceneRequest, validateSceneDraft } from '../src/scene-schema.js';
import { handle } from '../src/worker/index.js';

const tvs = [
  { id: 'lg-1', brand: 'lg', name: 'Living Room', room: 'Den', state: { power: 'on' } },
  { id: 'roku-1', brand: 'roku', name: "Zara's TV", room: '' },
  { id: 'lg-2', brand: 'lg', name: 'Living Room TV', room: '' },
];

test('sceneRequest: names and rooms become tokens (longest first), junk is dropped', () => {
  const { request, refs } = sceneRequest("Movie night on the living room tv and Zara's TV in the den, call 469 555 1234 or a@b.co https://x.y", tvs);
  assert.deepEqual(refs, { TV1: 'lg-1', TV2: 'roku-1', TV3: 'lg-2' });
  assert.equal(request.text, 'Movie night on the TV3 and TV2 in the TV1, call or');
  assert.deepEqual(request.tvs[1], { ref: 'TV2', brand: 'roku', box: true, on: false });
  assert.ok(!/zara|living|den\b/i.test(JSON.stringify(request)));
  assert.equal(sanitizeSceneRequest({ text: 'hi' }), null);
});

test('validateSceneDraft: only known refs and actions, values clamped, a schedule only when whole', () => {
  const d = validateSceneDraft({
    name: 'Movie Night', emoji: '🍿', summary: 'x',
    steps: [
      { action: 'power', target: ['TV1', 'TV9'], on: true },
      { action: 'key', target: 'all' },
      { action: 'volume', target: ['TV9'], level: 400 },
      { action: 'launch', target: ['TV1'], app: 'Netflix' },
      { action: 'launch', target: ['TV1'] },
      { action: 'wait', target: ['TV1'], seconds: 0 },
    ],
    schedule: { days: [1, 9, 1], time: '25:00' },
  }, ['TV1', 'TV2']);
  assert.deepEqual(d.steps, [
    { action: 'power', target: ['TV1'], args: { on: true } },
    { action: 'volume', target: 'all', args: { level: 60 } },
    { action: 'launch', target: ['TV1'], args: { title: 'Netflix' } },
    { action: 'wait', target: 'all', args: { seconds: 1 } },
  ]);
  assert.equal(d.schedule, null);
  assert.equal(validateSceneDraft({ steps: [{ action: 'key' }] }, []), null);
  assert.equal(validateSceneDraft({ steps: [{ action: 'power', target: 'all' }], emoji: '💣' }).emoji, '✨');
});

test('restoreScene: tokens back to ids and names', () => {
  const back = restoreScene({ name: 'TV2 Bedtime', emoji: '🌙', summary: 'TV2 goes quiet.', steps: [{ action: 'say', target: ['TV2'], args: { message: 'Night TV2' } }], schedule: null }, { TV2: 'roku-1' }, tvs);
  assert.equal(back.name, "Zara's TV Bedtime");
  assert.deepEqual(back.steps[0], { action: 'say', target: ['roku-1'], args: { message: "Night Zara's TV" } });
});

test('Worker /scene: sanitises again, asks the AI, validates; never stores', async () => {
  let prompt = '';
  const env = {
    AI: {
      run: async (_m, req) => {
        prompt = JSON.stringify(req);
        return { response: JSON.stringify({ name: 'All Off', emoji: '🌙', summary: 'Turns every TV off.', steps: [{ action: 'power', target: 'all', on: false }], schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '00:00' } }) };
      },
    },
  };
  const req = (body) => new Request('https://mutaafaziz.com/hearth/api/scene', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const res = await handle(req({ request: { text: 'Everything off at midnight, mail me@x.com', tvs: [{ ref: 'TV1', brand: 'lg', name: 'Living Room' }] } }), env);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual(body.draft.steps, [{ action: 'power', target: 'all', args: { on: false } }]);
  assert.deepEqual(body.draft.schedule, { days: [0, 1, 2, 3, 4, 5, 6], time: '00:00' });
  assert.ok(!/Living Room|me@x\.com/.test(prompt), 'only the sanitised request reaches the model');
  assert.equal((await handle(req({ request: { text: '' } }), env)).status, 400);
});
