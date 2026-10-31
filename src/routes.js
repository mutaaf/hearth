// Every API call, as data: [method, path pattern, handler(params, body, url,
// req)]. Handlers return JSON or throw HearthError. The home server
// (src/server.js) serves them over HTTP; the phone app (hearth-app) calls them
// in-process from its WebView bridge, with a stand-in req ({ headers }).
import { bulk } from './bulk.js';
import { catalogView } from './catalog.js';
import { runDoctor, runDoctorAll } from './doctor.js';
import { badRequest, HearthError } from './errors.js';
import { catalogStatus, launchOn } from './launch.js';
import { deviceGuide } from './devices.js';
import { wakePlan } from './wake-plan.js';
import { daysFromText, restoreScene, sceneRequest } from './scene-schema.js';
import { iconData } from './icons.js';
import { log } from './log.js';

const scenesOf = (hub) => {
  if (!hub.scenes) throw new HearthError(503, 'Scenes aren’t available');
  return hub.scenes;
};

// The built-in guide is the truth about how Hearth's drivers connect (how,
// ports); the AI adds what it knows about this exact model: its family and
// year when the table doesn't know them, its menus, and fixes for what went wrong.
export function mergeGuide(local, ai) {
  if (!ai) return local;
  const uniq = (xs, key) => [...new Map(xs.map((x) => [key(x), x])).values()];
  const known = local.known;
  return {
    ...local,
    family: known ? local.family : ai.family || local.family,
    year: local.year ?? ai.year,
    os: local.os ?? ai.os,
    connect: {
      how: local.connect.how,
      summary: known ? local.connect.summary : ai.connect.summary || local.connect.summary,
      before: uniq([...(known ? local.connect.before : ai.connect.before), ...(known ? ai.connect.before : local.connect.before)], (s) => s.toLowerCase()).slice(0, 6),
      onTv: local.connect.onTv ?? ai.connect.onTv,
    },
    keepReachable: uniq([...local.keepReachable, ...ai.keepReachable], (k) => k.title.toLowerCase().replace(/^(enable|turn on|turn off|disable|switch on|switch off|set)\s+/, '')).slice(0, 6),
    troubleshoot: [...ai.troubleshoot, ...local.troubleshoot].slice(0, 12),
    quirks: uniq([...local.quirks, ...ai.quirks], (q) => q.toLowerCase()).slice(0, 8),
    source: known ? 'built-in + AI' : 'AI',
  };
}

// [method, path pattern, handler(params, body, url)] — handlers return JSON.
export function routes(hub, { version = '0.0.0', friendlyUrl = null } = {}) {
  const id = '([\\w-]+)';
  // After a command, re-read the TV so live state reflects what happened.
  const settled = (tv) => {
    hub.settle(tv);
    return { ok: true };
  };
  const r = (method, pattern, fn) => [method, new RegExp(`^/api${pattern}$`), fn];
  return [
    r('GET', '/health', () => ({ ok: true, name: 'hearth', version })),
    // The address to hand family members (e.g. a home portal's /tv), for the
    // app's "Share Hearth" and install screens.
    r('GET', '/info', (_, __, url) => ({ name: 'hearth', version, friendlyUrl })),
    r('GET', '/tvs', () => hub.list()),
    r('GET', '/nearby', () => hub.nearby),
    r('POST', '/scan', () => hub.scan()),
    r('POST', '/tvs', (_, body) => hub.add(body)),
    r('PATCH', `/tvs/${id}`, ([tv], body) => hub.update(tv, body)),
    r('DELETE', `/tvs/${id}`, ([tv]) => hub.remove(tv)),
    r('POST', `/tvs/${id}/pair`, ([tv], body) =>
      hub.pair(tv, {
        ...(body.pin !== undefined ? { pin: String(body.pin).replace(/\D/g, '').slice(0, 8) } : {}),
        ...(body.mode === 'pin' ? { mode: 'pin' } : {}),
        // Google TV full remote: { mode: 'code' } shows the code, { code } finishes.
        ...(body.mode === 'code' ? { mode: 'code' } : {}),
        ...(body.code !== undefined ? { code: String(body.code).replace(/[^0-9a-f]/gi, '').slice(0, 6) } : {}),
      })),
    // ── doctor: fix connections, pair again ──
    r('POST', `/tvs/${id}/doctor`, ([tv]) => runDoctor(hub, tv)),
    r('POST', '/doctor', () => runDoctorAll(hub).then((reports) => ({ reports }))),
    r('POST', `/tvs/${id}/unpair`, ([tv]) => hub.unpair(tv)),
    r('POST', `/tvs/${id}/key`, ([tv], body) => {
      if (typeof body.key !== 'string') throw badRequest('key is required');
      const hold = Number.isFinite(body.hold) && body.hold > 0 ? body.hold : 0;
      return hub.wakeFor(tv).then(() => hub.driver(tv).key(body.key, { hold })).then(() => settled(tv));
    }),
    r('POST', `/tvs/${id}/power`, ([tv], body) => hub.power(tv, Boolean(body.on))),
    // ── the wake coach: how this TV can be turned on from the phone, and a live test ──
    r('GET', `/tvs/${id}/wake-plan`, ([tv]) => wakePlan(hub.view(hub.get(tv)), hub.list())),
    r('POST', `/tvs/${id}/wake-test`, ([tv], body) => hub.wakeTest(tv, { via: body.via ? String(body.via) : undefined })),
    r('POST', `/tvs/${id}/volume`, ([tv], body) => {
      if (!Number.isFinite(body.level)) throw badRequest('level must be a number 0–100');
      return hub.wakeFor(tv).then(() => hub.driver(tv).setVolume(body.level)).then(() => settled(tv));
    }),
    r('GET', `/tvs/${id}/apps`, ([tv], _, url) => hub.apps(tv, { fresh: url.searchParams.has('fresh') })),
    r('POST', `/tvs/${id}/launch`, ([tv], body) => hub.wakeFor(tv).then(() => hub.driver(tv).launch(String(body.id ?? ''))).then(() => settled(tv))),
    r('GET', `/tvs/${id}/inputs`, ([tv]) => hub.driver(tv).inputs()),
    r('POST', `/tvs/${id}/input`, ([tv], body) => hub.wakeFor(tv).then(() => hub.driver(tv).setInput(String(body.id ?? ''))).then(() => settled(tv))),
    r('POST', `/tvs/${id}/toast`, ([tv], body) => {
      const message = String(body.message ?? '').trim();
      if (!message) throw badRequest('message is required');
      return hub.driver(tv).toast(message).then(() => ({ ok: true }));
    }),
    r('POST', '/all/power', (_, body) => hub.powerAll(Boolean(body.on))),
    r('POST', '/refresh', () => hub.refreshAll()), // pull to refresh
    // ── the cross-brand app launcher ──
    r('GET', '/catalog', () => catalogView()),
    r('GET', '/catalog/status', (_, __, url) => catalogStatus(hub, { fresh: url.searchParams.has('fresh') })),
    r('POST', '/launch', (_, body) => launchOn(hub, body)),
    // ── bulk select + scenes ──
    r('POST', '/bulk', (_, body) => bulk(hub, body.ids, String(body.action ?? ''), body.args ?? {}).then((results) => ({ results }))),
    r('GET', '/scenes', () => scenesOf(hub).list()),
    r('POST', '/scenes', (_, body) => scenesOf(hub).create(body)),
    // "Just say it": a sentence → a draft scene for the editor (nothing saved).
    // Names never leave: sceneRequest() swaps them for TV1, TV2… and back.
    r('POST', '/scenes/draft', async (_, body) => {
      const tvs = hub.list().filter((t) => t.paired);
      const { request, refs } = sceneRequest(body.text, tvs);
      if (!request) throw badRequest('Say a little more about what it should do.');
      const { draft, model } = await hub.insights.scene(request);
      const scene = restoreScene(draft, refs, tvs);
      const days = daysFromText(body.text);
      if (scene.schedule && days) scene.schedule.days = days;
      return { draft: scene, model };
    }),
    r('POST', '/scenes/try', (_, body) => scenesOf(hub).tryDraft(body)),
    r('PATCH', `/scenes/${id}`, ([sc], body) => scenesOf(hub).update(sc, body)),
    r('DELETE', `/scenes/${id}`, ([sc]) => scenesOf(hub).remove(sc)),
    r('POST', `/scenes/${id}/run`, ([sc]) => {
      // Reply at once; progress streams over SSE ('scene' events).
      scenesOf(hub).get(sc);
      scenesOf(hub).run(sc).catch((err) => log.warn('[hearth] scene failed:', err.message));
      return { ok: true, started: true };
    }),
    // ── health: report card, diagnostics, AI insights (keys pass through, never stored) ──
    r('GET', '/report', () => hub.report()),
    r('GET', `/tvs/${id}/health`, ([tv]) => hub.health(tv)),
    r('GET', `/tvs/${id}/diagnostics`, ([tv]) => hub.diagnostics(tv)),
    r('POST', `/tvs/${id}/insights`, ([tv], body, _url, req) =>
      hub.aiInsights(tv, {
        provider: String(body.provider ?? 'edge'),
        model: body.model ? String(body.model).slice(0, 120) : null,
        key: req.headers['x-hearth-key'] ?? '',
        refresh: Boolean(body.refresh),
      })),
    // ── energy: what each TV costs (the bill is read by AI; only numbers are kept) ──
    r('GET', '/energy', () => hub.energyReport()),
    r('POST', '/energy/bill', (_, body, _url, req) =>
      hub.readBill(body, {
        provider: String(body.provider ?? 'edge'),
        model: body.model ? String(body.model).slice(0, 120) : null,
        key: req.headers['x-hearth-key'] ?? '',
      })),
    r('PUT', '/energy/price', async (_, body) => {
      await hub.energy.setPrice(body);
      return hub.energyReport();
    }),
    r('DELETE', '/energy/bill', async () => {
      await hub.energy.clear();
      return hub.energyReport();
    }),
    r('PATCH', `/energy/tvs/${id}`, async ([tv], body) => {
      hub.get(tv);
      await hub.energy.setWatts(tv, { onW: body.onW, standbyW: body.standbyW });
      return hub.energyReport();
    }),
    // ── device guides + support: "we know your TV, here's how", and "it won't connect" ──
    // POST /guide { tvId? | device?, symptom?, ai? }: the built-in guide for the
    // model at once; with ai (or when the model isn't in the built-in table, or
    // something went wrong) the AI's take for this exact model, merged in.
    r('POST', '/guide', async (_, body) => {
      const tv = body.tvId ? hub.get(String(body.tvId)) : null;
      const device = tv ? { brand: tv.brand, model: tv.model, firmware: body.device?.firmware } : body.device;
      if (!device?.brand) throw badRequest('Which TV?');
      const local = deviceGuide(device);
      const wantAi = body.ai === true || (body.ai !== false && (!local.known || body.symptom)) ;
      if (!wantAi || !device.model) return { guide: local, ai: null };
      try {
        const ai = await hub.insights.guide(device, body.symptom ?? null, local, { refresh: body.refresh === true });
        return { guide: mergeGuide(local, ai.guide), ai: { model: ai.model, cached: ai.cached, confidence: ai.guide.confidence } };
      } catch (err) {
        return { guide: local, ai: null, aiError: err.message };
      }
    }),
    // An app's icon as data, for clients that can't load the TV's URL (the phone app).
    r('GET', `/tvs/${id}/icon-data`, ([tv], _b, url) => iconData(hub, tv, url.searchParams.get('u') ?? '')),
    r('POST', '/support', (_, body) => {
      const tv = body.tvId ? hub.get(String(body.tvId)) : null;
      const report = { ...body.report, ...(tv ? { device: { brand: tv.brand, model: tv.model, firmware: body.report?.device?.firmware } } : {}) };
      return hub.insights.support(report);
    }),
    r('GET', '/support/([a-z0-9]{6,16})', ([ticket]) => hub.insights.supportStatus(ticket)),
    r('POST', '/ai/models', (_, body, _url, req) => hub.insights.models(String(body.provider ?? 'auto'), req.headers['x-hearth-key'] ?? '')),
    // ── trackpad + keyboard (browser / search) ──
    r('POST', `/tvs/${id}/pointer`, ([tv], body) => {
      if (!['move', 'click', 'scroll'].includes(body.type)) throw badRequest('type must be move, click or scroll');
      const clamp = (n) => Math.max(-2000, Math.min(2000, Number(n) || 0));
      return hub.driver(tv).pointer({ type: body.type, dx: clamp(body.dx), dy: clamp(body.dy) }).then(() => ({ ok: true }));
    }),
    r('POST', `/tvs/${id}/text`, ([tv], body) => {
      const input = {
        text: typeof body.text === 'string' ? body.text.slice(0, 500) : '',
        backspace: Math.max(0, Math.min(100, Number(body.backspace) || 0)),
        enter: Boolean(body.enter),
      };
      if (!input.text && !input.backspace && !input.enter) throw badRequest('Send text, backspace or enter');
      return hub.driver(tv).text(input).then(() => ({ ok: true }));
    }),
  ];
}
