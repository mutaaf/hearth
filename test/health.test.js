import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anonymise, controls, grade, modelYear, rate } from '../src/health.js';
import { detectProvider, extractJson, sanitizePayload, validateInsight } from '../src/insight-schema.js';
import { Insights } from '../src/llm.js';
import { fractionTrue, instrument, percentile, Telemetry } from '../src/telemetry.js';
import { checkInsightRequest, handle } from '../src/worker/index.js';

// ── telemetry math ──
test('percentiles and time-on fractions', () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(xs, 50), 50);
  assert.equal(percentile(xs, 95), 100);
  assert.equal(percentile([], 50), null);
  // on 0–25, off 25–75, on 75–100 → half the time
  const tl = [{ t: 0, v: true }, { t: 25, v: false }, { t: 75, v: true }];
  assert.equal(fractionTrue(tl, 0, 100, false), 0.5);
  assert.equal(fractionTrue([], 0, 100, true), 1);
});

test('telemetry: commands, availability, wakes, screen time, volume', async () => {
  let now = 1_000_000;
  const tel = new Telemetry({ now: () => now });
  const id = 'tv1';
  tel.state(id, { online: false, power: 'off' });
  // wake attempt that succeeds after 6 s
  tel.wakeStart(id);
  now += 6000;
  tel.state(id, { online: true, power: 'on', app: 'netflix', appTitle: 'Netflix', volume: 20, muted: false });
  for (const ms of [30, 40, 50, 60, 900]) tel.command(id, 'key:up', true, ms);
  tel.command(id, 'key:up', false, 5000, 'TV is off or not reachable');
  tel.command(id, 'key:source', false, 3, 'The "source" button isn\'t supported on this TV');
  now += 3_600_000;
  tel.state(id, { online: true, power: 'on', app: 'youtube', appTitle: 'YouTube', volume: 70, muted: false });
  now += 1_800_000;
  const s = tel.summary(id);
  assert.equal(s.commands.count, 7);
  assert.equal(s.commands.successPct, 83.3, 'unsupported answers don’t count as failures');
  assert.equal(s.commands.p50, 50);
  assert.equal(s.wake.attempts, 1);
  assert.equal(s.wake.successPct, 100);
  assert.equal(s.wake.avgMs, 6000);
  assert.deepEqual(s.screenTime.map((a) => a.app), ['Netflix', 'YouTube']);
  assert.equal(Math.round(s.screenTime[0].ms / 60000), 60);
  assert.equal(s.volume.highPct, 50);
  assert.ok(s.availability.h24 > 0.99);
});

test('instrument() times every driver call and records failures', async () => {
  const tel = new Telemetry();
  const driver = {
    async key(name) {
      if (name === 'bad') throw new Error('nope');
    },
    async launch() {},
  };
  instrument(driver, 'x', tel);
  await driver.key('ok');
  await driver.launch('netflix');
  await assert.rejects(driver.key('bad'));
  const s = tel.summary('x');
  assert.equal(s.commands.count, 3);
  assert.deepEqual(Object.keys(s.commands.byAction).sort(), ['key:bad', 'key:ok', 'launch']);
  assert.equal(s.commands.errors[0].message, 'nope');
});

// ── rating ──
test('model years: only where the code is certain', () => {
  assert.deepEqual(modelYear('samsung', 'UN55KU6290'), { year: 2016, source: 'model code' });
  assert.equal(modelYear('samsung', 'UN43TU7000').year, 2020);
  assert.equal(modelYear('samsung', 'QN55Q60AAF').year, 2021);
  assert.equal(modelYear('lg', '55UP7000PUA').year, 2021);
  assert.equal(modelYear('lg', 'OLED65C1PUB').year, 2021);
  assert.equal(modelYear('lg', 'OLED55CXPUA').year, 2020);
  assert.equal(modelYear('lg', '55NANO75UPA').year, 2021);
  assert.equal(modelYear('androidtv', 'TCL 65A300W'), null);
  assert.equal(modelYear('roku', 'Streaming Stick 3840R'), null);
});

const view = (over = {}) => ({
  id: 'lg-1', brand: 'lg', name: 'Den', model: '55UP7000PUA', paired: true, canWake: true, powerToggles: false,
  capabilities: { volumeLevel: true, inputs: true, toast: true, appIcons: true }, state: { online: true, power: 'on' }, ...over,
});
const telemetryFixture = {
  commands: { count: 120, successPct: 99, p50: 45, p95: 160, samples: 118 },
  connections: { unexpectedDrops24h: 0, sessions: 4 },
  wake: { attempts: 4, ok: 4, successPct: 100, avgMs: 4200 },
  volume: { samples: 20, highPct: 5 },
  availability: { h24: 0.98 },
  screenTime: [{ app: 'Netflix', ms: 7_200_000 }],
};
const diagFixture = {
  identity: { model: '55UP7000PUA', serial: 'SECRET123' },
  software: { os: 'webOS TV 6.0', version: '3.30', updateAvailable: false },
  network: { type: 'wifi', ssid: 'HomeNet', signalDbm: -58, rtt: { ok: 5, avg: 12, jitter: 4, lossPct: 0 } },
  signals: { 'Power state': 'Active', 'SSAP endpoint': 'wss://192.168.1.45:3001', 'Wi-Fi SSID': 'HomeNet' },
};

test('a healthy 2021 LG scores well and every sub-score explains itself', () => {
  const r = rate(view(), telemetryFixture, diagFixture);
  assert.ok(r.overall >= 80 && r.overall <= 100, `overall ${r.overall}`);
  assert.equal(grade(r.overall), r.grade);
  for (const s of Object.values(r.sub)) assert.ok(s.evidence.length, 'evidence present');
  assert.equal(r.year.year, 2021);
  assert.ok(r.findings.some((f) => f.severity === 'tip'), 'privacy tip offered');
});

test('problems surface as plain findings, worst first', () => {
  const bad = rate(
    view({ canWake: false, brand: 'samsung', model: 'UN55KU6290', powerToggles: true }),
    { ...telemetryFixture, commands: { count: 50, successPct: 80, p50: 400, p95: 1500, samples: 40 }, connections: { unexpectedDrops24h: 4, sessions: 6 }, volume: { samples: 10, highPct: 60 }, wake: { attempts: 0 } },
    { ...diagFixture, identity: { model: 'UN55KU6290' }, software: { updateAvailable: true }, network: { type: 'wifi', signalDbm: -80, rtt: { ok: 3, avg: 90, jitter: 80, lossPct: 40 } } },
  );
  assert.ok(bad.overall < 70, `overall ${bad.overall}`);
  const titles = bad.findings.map((f) => f.title);
  for (const t of ['Can’t be turned on from your phone', 'A software update is waiting', 'Slow to respond', 'Weak Wi-Fi', 'Keeps dropping off the network', 'Volume is often 60 or higher', 'This TV is from 2016', 'Power works as a toggle']) {
    assert.ok(titles.includes(t), `missing: ${t}`);
  }
  const order = { high: 0, medium: 1, low: 2, tip: 3, good: 4 };
  for (let i = 1; i < bad.findings.length; i++) assert.ok(order[bad.findings[i - 1].severity] <= order[bad.findings[i].severity]);
});

test('no data yet: no crash, honest "not enough" answers', () => {
  const r = rate(view({ state: { online: false } }), null, null);
  assert.equal(r.sub.responsiveness.score, null);
  assert.ok(r.overall != null, 'coverage and wake still score');
});

test('AI adjustment is bounded and AI years are marked as estimates', () => {
  const r = rate(view({ brand: 'androidtv', model: 'TCL 65A300W', capabilities: { volumeLevel: true, remote: false } }), telemetryFixture, null, { aiYear: 2023, aiAdjust: { points: -40, reason: 'x' } });
  assert.equal(r.aiAdjustment.points, -10);
  assert.equal(r.year.source, 'ai');
  assert.equal(controls(view({ brand: 'androidtv', capabilities: { remote: false } }))['Arrow keys & OK'], false);
});

test('what leaves the house has no names, IPs, MACs, serials or SSIDs', () => {
  const v = view({ name: 'Kids Room', ip: '192.168.1.45', macs: ['aa:bb:cc:dd:ee:ff'] });
  const r = rate(v, telemetryFixture, diagFixture);
  const payload = anonymise(v, telemetryFixture, diagFixture, r);
  const text = JSON.stringify(payload);
  for (const secret of ['Kids Room', '192.168', 'aa:bb', 'SECRET123', 'HomeNet']) assert.ok(!text.includes(secret), `leaked ${secret}`);
  assert.equal(payload.model, '55UP7000PUA');
  assert.equal(payload.scores.grade, r.grade);
});

// ── JSON repair + validation ──
test('extractJson repairs fenced, chatty, trailing-comma answers', () => {
  const raw = 'Sure! Here it is:\n```json\n{"headline":"Fine", "top_actions":[{"action":"x","why":"y"},],}\n```';
  assert.deepEqual(extractJson(raw), { headline: 'Fine', top_actions: [{ action: 'x', why: 'y' }] });
  assert.equal(extractJson('no json here'), null);
});

test('validateInsight coerces shape, clamps numbers and lengths', () => {
  const v = validateInsight({
    headline: 'A'.repeat(500),
    verdict_for_everyone: 'Good TV.',
    top_actions: ['Do a thing', { action: 'B', why: 'C' }, { action: 'D' }, { action: 'E' }],
    nerd_notes: ['n1', 2, null],
    model_profile: { year: 1800, platform: 'webOS' },
    ai_grade_adjustment: { points: 99, reason: 'r' },
  });
  assert.equal(v.headline.length, 80);
  assert.equal(v.top_actions.length, 3);
  assert.equal(v.top_actions[0].action, 'Do a thing');
  assert.deepEqual(v.nerd_notes, ['n1'], 'non-strings dropped');
  assert.equal(v.model_profile.year, null);
  assert.equal(v.ai_grade_adjustment.points, 5);
  assert.equal(validateInsight({}), null);
});

test('sanitizePayload drops identifying keys and scrubs addresses in values', () => {
  const clean = sanitizePayload({ v: 1, name: 'Den', ip: '10.0.0.5', macs: ['x'], serial: 's', model: 'X', note: 'at 10.0.0.5 / aa:bb:cc:dd:ee:ff', deep: { a: { b: { c: { d: { e: 1 } } } } } });
  assert.equal(clean.name, undefined);
  assert.equal(clean.ip, undefined);
  assert.equal(clean.serial, undefined);
  assert.equal(clean.model, 'X');
  assert.equal(clean.note, 'at [ip] / [mac]');
  assert.equal(clean.deep.a.b.c.d, null, 'depth is bounded');
});

test('key detection matches COLD GAS', () => {
  assert.equal(detectProvider('sk-ant-api03-abcdefghijklmnopqrstuvwxyz').provider, 'anthropic');
  assert.equal(detectProvider('xai-abcdefghijklmnopqrstuvwxyz').provider, 'xai');
  assert.equal(detectProvider(`AIza${'x'.repeat(35)}`).provider, 'gemini');
  assert.equal(detectProvider('sk-proj-abcdefghijklmnopqrstuvwxyz').provider, 'openai');
  assert.equal(detectProvider('gsk_abc').provider, null);
});

// ── hub → Worker relay ──
test('relay passes the key header through, caches 6 h, never caches across providers', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ insight: { headline: 'Hi', verdict_for_everyone: 'Fine.' }, provider: JSON.parse(init.body).provider, model: 'm' }), { status: 200 });
  };
  const ins = new Insights({ cloud: 'https://example.test/hearth/api', fetchFn });
  const a = await ins.run('tv', { v: 1, model: 'X', name: 'secret' }, { provider: 'anthropic', key: 'sk-ant-1234567890', model: 'claude-opus-5-5' });
  assert.equal(a.cached, false);
  assert.equal(calls[0].url, 'https://example.test/hearth/api/insights');
  assert.equal(calls[0].headers['x-hearth-key'], 'sk-ant-1234567890');
  assert.equal(calls[0].body.payload.name, undefined, 'payload re-sanitised on the hub');
  assert.equal((await ins.run('tv', { v: 1 }, { provider: 'anthropic', key: 'k', model: 'claude-opus-5-5' })).cached, true);
  await ins.run('tv', { v: 1 }, { provider: 'edge', key: 'should-not-be-sent' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers['x-hearth-key'], undefined, 'the free brain never gets a key');
});

// ── Worker ──
test('Worker validates requests', () => {
  assert.equal(checkInsightRequest(null, '').error, 'Bad request.');
  assert.match(checkInsightRequest({ provider: 'openai', payload: { v: 1 } }, '').error, /complete key/);
  assert.match(checkInsightRequest({ payload: { v: 2 } }, '').error, /Missing/);
  assert.match(checkInsightRequest({ payload: { v: 1 }, model: 'bad model!' }, '').error, /model/);
  const ok = checkInsightRequest({ payload: { v: 1, name: 'x', model: 'Y' } }, '');
  assert.equal(ok.provider, 'edge');
  assert.equal(ok.payload.name, undefined);
});

test('Worker: edge insight end to end with a mocked Workers AI (Gemma 4, thinking off)', async () => {
  let seen;
  const env = {
    AI: {
      run: async (model, body) => {
        seen = { model, body };
        return { response: '```json\n{"headline":"Solid set","verdict_for_everyone":"Works well.","top_actions":[],"nerd_notes":["p50 45 ms"],"model_profile":{"year":2021,"platform":"webOS 6"},"ai_grade_adjustment":{"points":0,"reason":""}}\n```', usage: { prompt_tokens: 900, completion_tokens: 120 } };
      },
    },
  };
  const req = new Request('https://mutaafaziz.com/hearth/api/insights', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: { v: 1, brand: 'lg', model: '55UP7000PUA', name: 'Den' } }),
  });
  const res = await handle(req, env);
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  assert.equal(seen.model, '@cf/google/gemma-4-26b-a4b-it');
  assert.deepEqual(seen.body.chat_template_kwargs, { enable_thinking: false });
  assert.ok(!JSON.stringify(seen.body.messages).includes('Den'), 'names never reach the model');
  assert.equal(data.insight.headline, 'Solid set');
  assert.equal(data.provider, 'edge');
  assert.equal(data.billedTo, 'Hearth (free allowance)');
});

test('Worker: falls back to the second edge model when the first fails', async () => {
  const tried = [];
  const env = {
    AI: {
      run: async (model) => {
        tried.push(model);
        if (tried.length === 1) throw new Error('capacity');
        return { response: '{"headline":"OK","verdict_for_everyone":"Fine."}' };
      },
    },
  };
  const res = await handle(
    new Request('https://x/hearth/api/insights', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ payload: { v: 1 } }) }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(tried.length, 2);
  assert.equal((await res.json()).model, '@cf/meta/llama-3.1-8b-instruct-fp8');
});

test('Worker rejects non-JSON and oversized bodies, passes other paths to assets', async () => {
  const env = { ASSETS: { fetch: async () => new Response('asset') } };
  assert.equal((await handle(new Request('https://x/hearth/api/insights', { method: 'POST', body: 'x' }), env)).status, 415);
  const big = JSON.stringify({ payload: { v: 1, pad: 'x'.repeat(20_000) } });
  assert.equal((await handle(new Request('https://x/hearth/api/insights', { method: 'POST', headers: { 'content-type': 'application/json' }, body: big }), env)).status, 413);
  assert.equal(await (await handle(new Request('https://x/hearth/demo/'), env)).text(), 'asset');
});

test('telemetry: a TV that keeps switching itself off after ~15 min', () => {
  let now = 10_000_000;
  const tel = new Telemetry({ now: () => now });
  const min = 60_000;
  const session = (id, mins, { asked = false, other = null, lost = false } = {}) => {
    tel.state(id, { online: true, power: 'on' });
    now += mins * min;
    if (asked) tel.command(id, 'powerOff', true, 5);
    if (other) tel.command(other, 'powerOff', true, 5); // a Roku's off reaches its TV over CEC
    if (lost) tel.state(id, { online: false, power: 'off' });
    else {
      tel.state(id, { online: true, power: 'standby' });
      now += 15_000;
      tel.state(id, { online: false, power: 'off' });
    }
    now += 30 * min;
  };
  session('tv', 19, { other: 'roku' });
  session('tv', 15);
  assert.equal(tel.offPattern('tv').autoOff, null, 'once is not a pattern');
  assert.equal(tel.offPattern('tv').last, 'off', 'powered down, then left the network: a normal off');
  session('tv', 14.5);
  session('tv', 40, { asked: true });
  const p = tel.offPattern('tv');
  assert.deepEqual([p.autoOff.minutes, p.autoOff.count], [15, 2]);
  const r = rate({ id: 'tv', brand: 'samsung', paired: true, canWake: true, state: { online: false } }, tel.summary('tv'), null);
  const f = r.findings.find((x) => /Turns itself off/.test(x.title));
  assert.equal(f.severity, 'high');
  assert.match(f.fix, /No Signal Power Off/);
  // Vanished while on (unplugged): not a timer, and the doctor is the right call.
  session('plug', 15, { lost: true });
  session('plug', 15, { lost: true });
  assert.deepEqual(tel.offPattern('plug'), { last: 'lost', autoOff: null });
});

test('telemetry: switching a TV on by hand long after a wake isn’t a working wake', () => {
  let now = 1_000_000;
  const tel = new Telemetry({ now: () => now });
  tel.state('tv', { online: false, power: 'off' });
  tel.wakeStart('tv');
  now += 20 * 60_000; // nothing happened; someone found the remote
  tel.state('tv', { online: true, power: 'on' });
  const s = tel.summary('tv');
  assert.equal(s.wake.ok, 0);
  assert.equal(s.wake.successPct, 0);
});
