import makeMdns from 'multicast-dns';

// Bonjour/mDNS browsing: ask "who offers <service>?" on 224.0.0.251:5353 and
// stitch PTR → SRV/TXT → A records into { service, name, ip, port, txt }.
// Google TVs, Chromecasts and AirPlay devices announce themselves this way
// (they don't answer SSDP like LG, Samsung and Roku do).
export async function browse(services, { timeout = 2200 } = {}) {
  let mdns;
  try {
    mdns = makeMdns();
  } catch {
    return [];
  }
  const ptr = new Map(); // instance fqdn → service
  const srv = new Map(); // instance fqdn → { target, port }
  const txt = new Map(); // instance fqdn → { key: value }
  const addr = new Map(); // host → ip

  const take = (records = []) => {
    for (const r of records) {
      if (r.type === 'PTR' && services.includes(r.name)) ptr.set(r.data, r.name);
      else if (r.type === 'SRV') srv.set(r.name, { target: r.data.target, port: r.data.port });
      else if (r.type === 'TXT') txt.set(r.name, parseTxt(r.data));
      else if (r.type === 'A') addr.set(r.name, r.data);
    }
  };
  mdns.on('response', (res) => {
    take(res.answers);
    take(res.additionals);
  });
  mdns.on('error', () => {});

  const ask = () => mdns.query(services.map((name) => ({ name, type: 'PTR' })));
  ask();
  await sleep(400);
  ask(); // multicast is lossy; ask twice
  await sleep(Math.max(0, timeout - 400));

  // Some responders send PTR/SRV but leave the address for a follow-up.
  const missing = [...srv.values()].map((s) => s.target).filter((h) => !addr.has(h));
  if (missing.length) {
    mdns.query([...new Set(missing)].map((name) => ({ name, type: 'A' })));
    await sleep(700);
  }
  mdns.destroy();

  return [...ptr].flatMap(([instance, service]) => {
    const s = srv.get(instance);
    const ip = s && addr.get(s.target);
    if (!ip) return [];
    return [{ service, name: instance.slice(0, -(service.length + 1)).replace(/\\032/g, ' '), ip, port: s.port, txt: txt.get(instance) ?? {} }];
  });
}

function parseTxt(data) {
  const out = {};
  for (const chunk of [].concat(data ?? [])) {
    const s = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    const i = s.indexOf('=');
    if (i > 0) out[s.slice(0, i).toLowerCase()] = s.slice(i + 1);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
