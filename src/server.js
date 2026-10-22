import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bulk } from './bulk.js';
import { catalogView } from './catalog.js';
import { catalogStatus, launchOn } from './launch.js';
import { badRequest, HearthError, isUnreachable, notFound } from './errors.js';
import { createHostCheck, createLimiter } from './guard.js';
import { COOKIE } from './household.js';
import { log } from './log.js';
import { qrSvg } from './qr.js';
import { runDoctor, runDoctorAll } from './doctor.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// [method, path pattern, handler(params, body, url)] — handlers return JSON.
function routes(hub) {
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
    r('GET', '/info', (_, __, url) => ({ name: 'hearth', version, friendlyUrl: process.env.HEARTH_FRIENDLY_URL || null })),
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

// ── the household: which phones may work the TVs (src/household.js) ──
function householdRoutes(household) {
  const id = '([\\w-]+)';
  const r = (method, pattern, fn) => [method, new RegExp(`^/api/household${pattern}$`), fn];
  return [
    r('GET', '/devices', (_, __, ___, req) => ({ code: household.code, devices: household.devices(req.device?.id) })),
    r('POST', '/invite', () => household.invite()),
    r('POST', '/code', (_, body) => household.setCode(body.code ?? null)),
    r('PATCH', `/devices/${id}`, ([d], body) => household.rename(d, body.name)),
    r('DELETE', `/devices/${id}`, ([d]) => household.revoke(d)),
  ];
}

// This computer itself (the browser on the Mac running Hearth, scripts, `npm
// run up`) is always in the house: it's how the first phone gets the code.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const deviceCookie = (token) => `${COOKIE}=${token}; Path=/; Max-Age=315360000; HttpOnly; SameSite=Strict`;

const scenesOf = (hub) => {
  if (!hub.scenes) throw new HearthError(503, 'Scenes aren’t available');
  return hub.scenes;
};

async function readJson(req) {
  // Requiring JSON forces a CORS preflight, so a random web page open on
  // someone's laptop can't quietly POST commands to the TVs.
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HearthError(415, 'Send JSON (content-type: application/json)');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw badRequest('Request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw badRequest('Body must be JSON');
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

// Third-party browser files served straight from node_modules.
const VENDOR = {
  'vendor/aurora-field.min.js': path.join(ROOT, 'node_modules', 'aurora-field', 'dist', 'aurora-field.min.js'),
  'vendor/insight-schema.js': path.join(ROOT, 'src', 'insight-schema.js'),
};

async function serveStatic(res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel.endsWith('/')) rel += 'index.html'; // racer/ → racer/index.html
  const file = VENDOR[rel] ?? path.resolve(WEB, rel);
  if (!VENDOR[rel] && !file.startsWith(WEB + path.sep)) throw notFound('Page');
  let body;
  try {
    body = await readFile(file);
  } catch {
    // Unknown paths fall back to the app shell (client-side routes).
    if (path.extname(rel)) throw notFound('File');
    body = await readFile(path.join(WEB, 'index.html'));
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
    return res.end(body);
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(body);
}

// App icons live on the TV, sometimes behind its self-signed HTTPS cert, which
// phones refuse to load. Proxy them — but only from that TV's own address.
// And only URLs that TV itself listed for its apps: never "any path on any
// port of that address", which would let a page read other services there.
async function proxyIcon(hub, tvIdParam, url, res) {
  const tv = hub.get(tvIdParam);
  let target;
  try {
    target = new URL(url);
  } catch {
    throw badRequest('Bad icon URL');
  }
  if (target.hostname !== tv.ip || !/^https?:$/.test(target.protocol) || hub.forbiddenIp(tv.ip)) throw badRequest('Icon must come from the TV');
  const listed = (list) => Array.isArray(list) && list.some((a) => a?.icon === url);
  if (!listed(hub.cachedApps(tv.id)) && !listed(await hub.apps(tv.id).catch(() => null))) {
    throw new HearthError(403, 'That icon isn’t one this TV listed');
  }
  const client = target.protocol === 'https:' ? https : http;
  const upstream = client.get(target, { rejectUnauthorized: false, timeout: 4000 }, (up) => {
    if (up.statusCode !== 200) {
      up.resume();
      return sendJson(res, 502, { error: 'Icon unavailable' });
    }
    res.writeHead(200, { 'content-type': up.headers['content-type'] ?? 'image/png', 'cache-control': 'max-age=86400' });
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => res.headersSent || sendJson(res, 502, { error: 'Icon unavailable' }));
}

// Calls that are slow or costly (they wake TVs, wait 25 s, or reach the
// cloud) are rate limited per client: [method, path pattern, bucket].
const LIMITED = [
  ['POST', /^\/api\/scan$/, 'scan'],
  ['POST', /^\/api\/tvs$/, 'add'],
  ['POST', /^\/api\/(tvs\/[\w-]+\/)?doctor$/, 'doctor'],
  ['POST', /^\/api\/(tvs\/[\w-]+\/insights|ai\/models)$/, 'ai'],
  ['POST', /^\/api\/household\/join$/, 'join'],
  ['POST', /^\/api\/refresh$/, 'refresh'],
];
const SSE_MAX_BUFFER = 512 * 1024; // a phone this far behind is gone; drop it

// `household`: a Household (src/household.js) to require a joined phone for
// the API; null leaves it open to anyone on the LAN (tests, HEARTH_OPEN=1).
export function createServer(hub, { hostCheck = createHostCheck(), limiter = createLimiter(), household = null, trustLoopback = true } = {}) {
  const table = [...routes(hub), ...(household ? householdRoutes(household) : [])];
  const listeners = new Map(); // SSE response → device id (null: this computer / open)
  const viewersChanged = () => hub.setViewers?.(listeners.size);
  const drop = (res) => {
    if (!listeners.delete(res)) return;
    viewersChanged();
    res.destroy();
  };
  // A phone removed from the house loses its live stream at once.
  household?.on('revoked', (deviceId) => {
    for (const [res, d] of listeners) if (d === deviceId) drop(res);
  });
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners.keys()) {
      // A phone that stopped reading (asleep, walked out of Wi-Fi without
      // closing) would buffer forever and keep "someone's watching" on.
      if (res.destroyed || res.writableLength > SSE_MAX_BUFFER) drop(res);
      else res.write(frame);
    }
  };
  hub.on('change', (tv) => broadcast('tv', tv));
  hub.on('removed', (info) => broadcast('removed', info));
  hub.on('nearby', (list) => broadcast('nearby', list));
  hub.on('healed', (info) => broadcast('healed', info)); // ── doctor
  hub.on('doctor', (step) => broadcast('doctor', step));
  hub.scenes?.on('progress', (p) => broadcast('scene', p));
  hub.scenes?.on('changed', (list) => broadcast('scenes', list));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://hearth.local');
    try {
      // DNS rebinding / cross-site: only local names, and for anything that
      // changes something, only pages served from one.
      const refused = hostCheck.check(req, { mutating: req.method !== 'GET' && req.method !== 'HEAD' });
      if (refused) throw new HearthError(req.headers.host && !hostCheck.allowed(req.headers.host) ? 421 : 403, refused);
      const limited = LIMITED.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (limited) {
        const wait = limiter.take(`${req.socket.remoteAddress}|${limited[2]}`);
        if (wait) {
          res.setHeader('retry-after', String(Math.ceil(wait / 1000)));
          throw new HearthError(429, `That's a lot of requests. Try again in ${Math.ceil(wait / 1000)} s.`);
        }
      }
      // The household: the app shell and /api/health (away mode's probe) are
      // public; every other API call needs a phone that joined (or this computer).
      if (url.pathname.startsWith('/api/')) {
        req.device = household?.identify(req) ?? null;
        const local = !household || (trustLoopback && LOOPBACK.has(req.socket.remoteAddress));
        if (url.pathname === '/api/household' && req.method === 'GET') {
          return sendJson(res, 200, { locked: Boolean(household), trusted: local || Boolean(req.device), thisComputer: Boolean(household) && local, device: req.device ? household.view(req.device, req.device.id) : null });
        }
        if (url.pathname === '/api/household/join' && req.method === 'POST' && household) {
          const body = await readJson(req);
          const joined = await household.join({
            code: typeof body.code === 'string' || typeof body.code === 'number' ? String(body.code) : undefined,
            invite: typeof body.invite === 'string' ? body.invite.slice(0, 100) : undefined,
            name: body.name,
            ua: req.headers['user-agent'],
          });
          res.setHeader('set-cookie', deviceCookie(joined.token));
          return sendJson(res, 200, { ok: true, device: joined.device });
        }
        if (!local && !req.device && url.pathname !== '/api/health') {
          throw new HearthError(401, 'This phone isn’t part of the house yet');
        }
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify(hub.list())}\n\n`);
        res.write(`event: nearby\ndata: ${JSON.stringify(hub.nearby)}\n\n`);
        listeners.set(res, req.device?.id ?? null);
        viewersChanged();
        const ping = setInterval(() => {
          if (res.destroyed || res.writableLength > SSE_MAX_BUFFER) return drop(res);
          res.write(': ping\n\n');
        }, 25_000);
        ping.unref?.();
        const gone = () => {
          clearInterval(ping);
          if (listeners.delete(res)) viewersChanged();
        };
        req.on('close', gone);
        res.on('close', gone);
        res.on('error', gone);
        return;
      }
      if (url.pathname === '/api/qr.svg' && req.method === 'GET') {
        const text = url.searchParams.get('u') ?? '';
        if (!/^https?:\/\/[^\s]{1,200}$/.test(text)) throw badRequest('u must be an http(s) link');
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=3600' });
        return res.end(qrSvg(text));
      }
      const icon = url.pathname.match(/^\/api\/tvs\/([\w-]+)\/icon$/);
      if (icon && req.method === 'GET') return await proxyIcon(hub, icon[1], url.searchParams.get('u') ?? '', res);

      if (url.pathname.startsWith('/api/')) {
        for (const [method, pattern, handler] of table) {
          const m = url.pathname.match(pattern);
          if (!m || method !== req.method) continue;
          const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
          return sendJson(res, 200, await handler(m.slice(1), body, url, req));
        }
        throw notFound('API route');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HearthError(405, 'Method not allowed');
      await serveStatic(res, url.pathname);
    } catch (err) {
      // ESSAP = the LG TV itself refused the request; pass its reason through.
      // Off/asleep/unreachable TVs are a 503 with plain words, never a 500.
      const status = err instanceof HearthError ? err.status : err.code === 'ESSAP' ? 502 : isUnreachable(err) ? 503 : 500;
      if (status === 500) log.error('[hearth]', req.method, url.pathname, err?.stack ?? err);
      const message = status === 500 ? 'Something went wrong talking to the TV' : status === 503 && !(err instanceof HearthError) ? 'TV is off or not reachable' : err.message;
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.destroy();
    }
  });
}
