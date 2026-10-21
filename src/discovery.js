import { execFile } from 'node:child_process';
import dgram from 'node:dgram';
import net from 'node:net';
import { appleTvModel } from './drivers/appletv.js';
import { rokuFromInfo, rokuInfo } from './drivers/roku.js';
import { browse } from './mdns.js';

// Finding TVs: shout an SSDP M-SEARCH at the LAN multicast group, collect who
// answers, then ask each candidate who it is (LG: UPnP description XML,
// Samsung: the REST endpoint on :8001).
const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:lge-com:service:webos-second-screen:1',
  'urn:lge:device:tv:1',
  'urn:samsung.com:device:RemoteControlReceiver:1',
  'urn:dial-multiscreen-org:service:dial:1',
  'urn:schemas-upnp-org:device:MediaRenderer:1',
  'roku:ecp',
];

const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;
export const isMac = (mac) => typeof mac === 'string' && MAC_RE.test(mac) && !/^(00[:-]){5}00$/.test(mac);
export const isIPv4 = (ip) => net.isIPv4(String(ip ?? ''));

export function tvId(brand, macs, ip) {
  return `${brand}-${String(macs?.[0] || ip).replace(/[^0-9a-z]/gi, '').toLowerCase()}`;
}

export function parseSsdp(text) {
  const headers = {};
  for (const line of text.split(/\r?\n/).slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return {
    st: headers.st || headers.nt || '',
    location: headers.location || '',
    server: headers.server || '',
  };
}

const decodeXml = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseDescription(xml) {
  const tag = (name) => {
    const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, 'i'));
    return m ? decodeXml(m[1].trim()) : '';
  };
  return {
    friendlyName: tag('friendlyName'),
    manufacturer: tag('manufacturer'),
    deviceType: tag('deviceType'),
    modelName: tag('modelName'),
    modelNumber: tag('modelNumber'),
    wifiMac: tag('wifiMac'),
    wiredMac: tag('wiredMac'),
  };
}

const isLgAnswer = ({ server, st }) => /webos/i.test(server) || /lge/i.test(st);

// LG publishes several descriptions, and their model fields are mostly noise
// ("LG Smart TV", "1.0", "WEBOS", "6.5.3"). The urn:lge:device:tv one carries
// both MACs; the real model code (55UP7000PUA, OLED65C1PUB) can be in any.
export function lgFromDescriptions(ip, descriptions) {
  const lg = descriptions.filter((d) => /lg/i.test(d.manufacturer) || /lge/i.test(d.deviceType));
  if (!lg.length) return null;
  const withMacs = lg.find((d) => isMac(d.wiredMac) || isMac(d.wifiMac));
  const macs = withMacs ? [withMacs.wiredMac, withMacs.wifiMac].filter(isMac).map((m) => m.toLowerCase()) : [];
  return {
    id: tvId('lg', macs, ip),
    brand: 'lg',
    name: lg.find((d) => d.friendlyName)?.friendlyName || 'LG TV',
    model: lg.flatMap((d) => [d.modelNumber, d.modelName]).find(isModelCode) || '',
    ip,
    macs,
  };
}

// A real model code mixes letters and digits and isn't a version number.
export const isModelCode = (s) =>
  typeof s === 'string' && s.length >= 5 && /[a-z]/i.test(s) && /\d/.test(s) && !/tv|webos|^[\d.]+$/i.test(s);

export function samsungFromInfo(ip, info) {
  const device = info?.device;
  if (!device || !/samsung/i.test(`${device.type} ${info.type} ${device.name}`)) return null;
  const macs = [device.wifiMac].filter(isMac).map((m) => m.toLowerCase());
  return {
    id: tvId('samsung', macs, ip),
    brand: 'samsung',
    name: decodeXml(device.name || info.name || 'Samsung TV').replace(/^\[TV\]\s*/, ''),
    model: device.modelName || '',
    ip,
    macs,
  };
}

async function getText(url, timeout = 2000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

export async function samsungInfo(ip, timeout = 2000) {
  return JSON.parse(await getText(`http://${ip}:8001/api/v2/`, timeout));
}

async function identify(ip, answer) {
  if (answer.roku) return rokuInfo(ip).then((info) => rokuFromInfo(ip, info)).catch(() => null);
  if (isLgAnswer(answer)) {
    const xmls = await Promise.all([...answer.locations].map((u) => getText(u).catch(() => '')));
    return lgFromDescriptions(ip, xmls.filter(Boolean).map(parseDescription));
  }
  return samsungInfo(ip).then((info) => samsungFromInfo(ip, info)).catch(() => null);
}

export async function discover({ timeout = 2500 } = {}) {
  const [ssdp, mdns] = await Promise.all([discoverSsdp({ timeout }), discoverMdns().catch(() => [])]);
  // A device found both ways keeps its SSDP identity (LG/Samsung/Roku).
  const seen = new Set(ssdp.map((t) => t.ip));
  return [...ssdp, ...mdns.filter((t) => !seen.has(t.ip))];
}

// Apple TVs announce _companion-link (rpMd=AppleTV6,2) and _airplay
// (model=AppleTV6,2). Macs, iPads, HomePods (AudioAccessory*), and TVs with
// AirPlay built in (LG, TCL, Roku) answer too; only AppleTV* models count.
const isAppleTvModel = (m) => /^AppleTV\d/i.test(m ?? '');
export function appleTvsFrom(entries) {
  const byIp = new Map();
  for (const e of entries) {
    const companion = e.service.startsWith('_companion-link');
    const airplay = e.service.startsWith('_airplay');
    if (!companion && !airplay) continue;
    const model = companion ? e.txt.rpmd : e.txt.model;
    if (!isAppleTvModel(model)) continue;
    const tv = byIp.get(e.ip) ?? { brand: 'appletv', name: '', model: '', rawModel: model, ip: e.ip, macs: [] };
    // Both services carry the user's name for it ("Media Room").
    tv.name ||= e.name;
    // AirPlay's deviceid is what pyatv calls the identifier. Apple TVs
    // randomise it (locally administered bit), so it's not a MAC for WOL.
    if (airplay && e.txt.deviceid) tv.atvId = e.txt.deviceid.toUpperCase();
    byIp.set(e.ip, tv);
  }
  return [...byIp.values()].map(({ rawModel, ...tv }) => ({
    ...tv,
    name: tv.name || 'Apple TV',
    model: appleTvModel(rawModel),
    id: tvId('appletv', tv.atvId ? [tv.atvId] : [], tv.ip),
  }));
}

async function discoverMdns() {
  const entries = await browse([
    '_googlecast._tcp.local',
    '_androidtvremote2._tcp.local',
    '_airplay._tcp.local',
    '_companion-link._tcp.local',
  ]);
  return [...(await googleTvsWithMacs(googleTvsFrom(entries))), ...appleTvsFrom(entries)];
}

// Google TV / Android TV / Chromecast announce over mDNS. Nest Hubs and
// speakers cast too, so keep only devices that are TVs: they also offer the
// Android TV remote service, or call themselves a TV / Chromecast.
const NOT_A_TV = /nest|home mini|hub|audio|speaker|group|display/i;
export function googleTvsFrom(entries) {
  const byIp = (service) => new Map(entries.filter((e) => e.service.startsWith(service)).map((e) => [e.ip, e]));
  const remote = byIp('_androidtvremote2');
  const airplay = byIp('_airplay');
  return entries
    .filter((e) => e.service.startsWith('_googlecast'))
    .filter((e) => !NOT_A_TV.test(e.txt.md ?? '') && (remote.has(e.ip) || /tv|chromecast/i.test(e.txt.md ?? '')))
    .map((e) => {
      const ap = airplay.get(e.ip)?.txt;
      const model = ap?.model ? `${ap.manufacturer ? `${ap.manufacturer} ` : ''}${ap.model}` : e.txt.md || 'Google TV';
      return { brand: 'androidtv', name: e.txt.fn || remote.get(e.ip)?.name || 'Google TV', model, ip: e.ip, macs: [] };
    });
}

async function googleTvsWithMacs(tvs) {
  for (const tv of tvs) {
    await portOpen(tv.ip, 8009, 800); // say hello so the OS learns its MAC
    const mac = await macFor(tv.ip);
    if (mac) tv.macs = [mac];
    tv.id = tvId('androidtv', tv.macs, tv.ip);
  }
  return tvs;
}

// The LAN MAC for an IP from the OS neighbour table (we just talked to it,
// so it's there). Needed for Wake-on-LAN on devices that don't report it.
export function macFor(ip) {
  return new Promise((resolve) => {
    execFile('arp', ['-n', ip], { timeout: 1500 }, (err, out) => {
      const m = !err && String(out).match(/(([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})/i);
      if (!m) return resolve(null);
      const mac = m[1].split(/[:-]/).map((b) => b.padStart(2, '0')).join(':').toLowerCase();
      resolve(isMac(mac) ? mac : null);
    });
  });
}

async function discoverSsdp({ timeout }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const answers = new Map();
  socket.on('message', (msg, rinfo) => {
    const parsed = parseSsdp(msg.toString());
    const entry = answers.get(rinfo.address) ?? { server: '', st: '', locations: new Set() };
    if (isLgAnswer(parsed)) Object.assign(entry, { server: parsed.server, st: parsed.st });
    else if (!entry.server) entry.server = parsed.server;
    if (/roku/i.test(`${parsed.st} ${parsed.server}`)) entry.roku = true;
    if (parsed.location) entry.locations.add(parsed.location);
    answers.set(rinfo.address, entry);
  });
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(resolve);
  });
  const search = (st) =>
    Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_HOST}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
  // UDP is lossy, and the first multicast from a freshly started process is
  // often dropped (seen on macOS under launchd), so ask twice, and if nobody
  // answered at all, ask again before giving up.
  const ask = async () => {
    for (const round of [0, 1]) {
      for (const st of SEARCH_TARGETS) socket.send(search(st), SSDP_PORT, SSDP_HOST);
      if (round === 0) await new Promise((r) => setTimeout(r, 400));
    }
    await new Promise((r) => setTimeout(r, timeout));
  };
  await ask();
  if (!answers.size) await ask();
  socket.close();

  const found = await Promise.all([...answers].map(([ip, answer]) => identify(ip, answer).catch(() => null)));
  return found.filter(Boolean);
}

export function portOpen(ip, port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port, timeout });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// For "add by IP address" when discovery is blocked (guest networks, some
// mesh routers): ask each kind of TV the question only it can answer.
export async function probe(ip) {
  try {
    const tv = samsungFromInfo(ip, await samsungInfo(ip));
    if (tv) return tv;
  } catch {}
  try {
    return rokuFromInfo(ip, await rokuInfo(ip));
  } catch {}
  const mac = await macFor(ip);
  const macs = mac ? [mac] : [];
  if ((await portOpen(ip, 3001)) || (await portOpen(ip, 3000))) {
    return { id: tvId('lg', macs, ip), brand: 'lg', name: 'LG TV', model: '', ip, macs };
  }
  if (await portOpen(ip, 8009)) {
    return { id: tvId('androidtv', macs, ip), brand: 'androidtv', name: 'Google TV', model: '', ip, macs };
  }
  const atv = await appleTvInfo(ip).catch(() => null);
  if (atv) return { id: tvId('appletv', [], ip), brand: 'appletv', name: atv.name || 'Apple TV', model: appleTvModel(atv.model), ip, macs: [] };
  return null;
}

// AirPlay's GET /info is a binary plist; the strings we need sit in it as
// plain ASCII, so a regex is enough (no plist parser). Smart TVs with AirPlay
// answer too, with their own model, which doesn't match.
export function appleTvFromAirplayInfo(buf) {
  const text = Buffer.from(buf).toString('latin1');
  const model = text.match(/AppleTV\d+,\d+/)?.[0];
  return model ? { model, name: '' } : null;
}

export async function appleTvInfo(ip, timeout = 2000) {
  const res = await fetch(`http://${ip}:7000/info`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) return null;
  return appleTvFromAirplayInfo(Buffer.from(await res.arrayBuffer()));
}
