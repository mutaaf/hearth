import dgram from 'node:dgram';
import net from 'node:net';

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
  if (isLgAnswer(answer)) {
    const xmls = await Promise.all([...answer.locations].map((u) => getText(u).catch(() => '')));
    return lgFromDescriptions(ip, xmls.filter(Boolean).map(parseDescription));
  }
  return samsungInfo(ip).then((info) => samsungFromInfo(ip, info)).catch(() => null);
}

export async function discover({ timeout = 2500 } = {}) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const answers = new Map();
  socket.on('message', (msg, rinfo) => {
    const parsed = parseSsdp(msg.toString());
    const entry = answers.get(rinfo.address) ?? { server: '', st: '', locations: new Set() };
    if (isLgAnswer(parsed)) Object.assign(entry, { server: parsed.server, st: parsed.st });
    else if (!entry.server) entry.server = parsed.server;
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

function portOpen(ip, port, timeout = 1500) {
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

// For "add by IP address" when SSDP is blocked (guest networks, some mesh
// routers): ask Samsung's REST endpoint, then look for LG's control ports.
export async function probe(ip) {
  try {
    const tv = samsungFromInfo(ip, await samsungInfo(ip));
    if (tv) return tv;
  } catch {}
  if ((await portOpen(ip, 3001)) || (await portOpen(ip, 3000))) {
    return { id: tvId('lg', [], ip), brand: 'lg', name: 'LG TV', model: '', ip, macs: [] };
  }
  return null;
}
