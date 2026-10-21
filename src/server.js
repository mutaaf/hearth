import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { badRequest, HearthError, notFound } from './errors.js';

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
  const r = (method, pattern, fn) => [method, new RegExp(`^/api${pattern}$`), fn];
  return [
    r('GET', '/health', () => ({ ok: true, name: 'hearth', version })),
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
      })),
    r('POST', `/tvs/${id}/key`, ([tv], body) => {
      if (typeof body.key !== 'string') throw badRequest('key is required');
      const hold = Number.isFinite(body.hold) && body.hold > 0 ? body.hold : 0;
      return hub.driver(tv).key(body.key, { hold }).then(() => ({ ok: true }));
    }),
    r('POST', `/tvs/${id}/power`, ([tv], body) => hub.power(tv, Boolean(body.on))),
    r('POST', `/tvs/${id}/volume`, ([tv], body) => {
      if (!Number.isFinite(body.level)) throw badRequest('level must be a number 0–100');
      return hub.driver(tv).setVolume(body.level).then(() => ({ ok: true }));
    }),
    r('GET', `/tvs/${id}/apps`, ([tv]) => hub.driver(tv).apps()),
    r('POST', `/tvs/${id}/launch`, ([tv], body) => hub.driver(tv).launch(String(body.id ?? '')).then(() => ({ ok: true }))),
    r('GET', `/tvs/${id}/inputs`, ([tv]) => hub.driver(tv).inputs()),
    r('POST', `/tvs/${id}/input`, ([tv], body) => hub.driver(tv).setInput(String(body.id ?? '')).then(() => ({ ok: true }))),
    r('POST', `/tvs/${id}/toast`, ([tv], body) => {
      const message = String(body.message ?? '').trim();
      if (!message) throw badRequest('message is required');
      return hub.driver(tv).toast(message).then(() => ({ ok: true }));
    }),
    r('POST', '/all/power', (_, body) => hub.powerAll(Boolean(body.on))),
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
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
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
function proxyIcon(hub, tvIdParam, url, res) {
  const tv = hub.get(tvIdParam);
  let target;
  try {
    target = new URL(url);
  } catch {
    throw badRequest('Bad icon URL');
  }
  if (target.hostname !== tv.ip || !/^https?:$/.test(target.protocol)) throw badRequest('Icon must come from the TV');
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

export function createServer(hub) {
  const table = routes(hub);
  const listeners = new Set();
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of listeners) res.write(frame);
  };
  hub.on('change', (tv) => broadcast('tv', tv));
  hub.on('removed', (info) => broadcast('removed', info));
  hub.on('nearby', (list) => broadcast('nearby', list));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://hearth.local');
    try {
      if (url.pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(`event: hello\ndata: ${JSON.stringify(hub.list())}\n\n`);
        res.write(`event: nearby\ndata: ${JSON.stringify(hub.nearby)}\n\n`);
        listeners.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          listeners.delete(res);
        });
        return;
      }
      const icon = url.pathname.match(/^\/api\/tvs\/([\w-]+)\/icon$/);
      if (icon && req.method === 'GET') return proxyIcon(hub, icon[1], url.searchParams.get('u') ?? '', res);

      if (url.pathname.startsWith('/api/')) {
        for (const [method, pattern, handler] of table) {
          const m = url.pathname.match(pattern);
          if (!m || method !== req.method) continue;
          const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
          return sendJson(res, 200, await handler(m.slice(1), body, url));
        }
        throw notFound('API route');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HearthError(405, 'Method not allowed');
      await serveStatic(res, url.pathname);
    } catch (err) {
      // ESSAP = the LG TV itself refused the request; pass its reason through.
      const status = err instanceof HearthError ? err.status : err.code === 'ESSAP' ? 502 : 500;
      if (status === 500) console.error('[hearth]', req.method, url.pathname, err);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong talking to the TV' : err.message });
    }
  });
}
