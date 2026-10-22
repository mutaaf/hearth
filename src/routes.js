// Every API call, as data: [method, path pattern, handler(params, body, url,
// req)]. Handlers return JSON or throw HearthError. The home server
// (src/server.js) serves them over HTTP; the phone app (hearth-app) calls them
// in-process from its WebView bridge, with a stand-in req ({ headers }).
import { bulk } from './bulk.js';
import { catalogView } from './catalog.js';
import { runDoctor, runDoctorAll } from './doctor.js';
import { badRequest, HearthError } from './errors.js';
import { catalogStatus, launchOn } from './launch.js';
import { log } from './log.js';

const scenesOf = (hub) => {
  if (!hub.scenes) throw new HearthError(503, 'Scenes aren’t available');
  return hub.scenes;
};

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
      return hub.driver(tv).key(body.key, { hold }).then(() => settled(tv));
    }),
    r('POST', `/tvs/${id}/power`, ([tv], body) => hub.power(tv, Boolean(body.on))),
    r('POST', `/tvs/${id}/volume`, ([tv], body) => {
      if (!Number.isFinite(body.level)) throw badRequest('level must be a number 0–100');
      return hub.driver(tv).setVolume(body.level).then(() => settled(tv));
    }),
    r('GET', `/tvs/${id}/apps`, ([tv], _, url) => hub.apps(tv, { fresh: url.searchParams.has('fresh') })),
    r('POST', `/tvs/${id}/launch`, ([tv], body) => hub.driver(tv).launch(String(body.id ?? '')).then(() => settled(tv))),
    r('GET', `/tvs/${id}/inputs`, ([tv]) => hub.driver(tv).inputs()),
    r('POST', `/tvs/${id}/input`, ([tv], body) => hub.driver(tv).setInput(String(body.id ?? '')).then(() => settled(tv))),
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
