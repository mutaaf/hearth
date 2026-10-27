// App icons live on the TV. Only URLs that TV itself listed for its apps may
// be fetched, and only from the TV's own address: never "any path on any
// port of that address", which would let a page read other services there.
// The home server streams them (src/server.js); the phone app, which has no
// HTTP server, gets them as data through the API (GET /tvs/:id/icon-data).
import { badRequest, HearthError } from './errors.js';

const MAX_ICON = 400_000;

export async function checkIconUrl(hub, tvId, url) {
  const tv = hub.get(tvId);
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
  return target;
}

export async function iconData(hub, tvId, url, { fetchFn = (...a) => fetch(...a) } = {}) {
  const target = await checkIconUrl(hub, tvId, url);
  const res = await fetchFn(target.href, { signal: AbortSignal.timeout(4000) }).catch(() => null);
  const type = res?.headers.get('content-type') ?? 'image/png';
  if (!res?.ok || !/^image\//.test(type)) throw new HearthError(502, 'Icon unavailable');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_ICON) throw new HearthError(502, 'Icon too big');
  return { type: type.split(';')[0], data: buf.toString('base64') };
}
