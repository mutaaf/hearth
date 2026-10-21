import net from 'node:net';
import { macFor, portOpen } from './discovery.js';
import { broadcastFor } from './wol.js';

// Deep, on-demand, read-only diagnostics. Everything each brand will tell us
// over its info endpoints, plus what the network itself says: TCP round
// trips, open ports, MAC, and the broadcast address Wake-on-LAN uses.
// Normalised to { identity, software, network, signals, capabilities, raw }.

export const KNOWN_PORTS = {
  lg: { 3000: 'SSAP ws', 3001: 'SSAP wss', 1407: 'UPnP basic', 1807: 'UPnP tv', 1184: 'DLNA renderer', 1906: 'room-connect', 7000: 'AirPlay' },
  samsung: { 8001: 'Remote ws', 8002: 'Remote wss', 8080: 'HTTP', 9197: 'DMR', 7676: 'UPnP', 9119: 'Smart View', 8187: 'MSF', 7678: 'UPnP 2', 55000: 'legacy remote', 7000: 'AirPlay' },
  roku: { 8060: 'ECP', 8080: 'HTTP', 9080: 'dev installer', 7000: 'AirPlay' },
  androidtv: { 8008: 'Cast HTTP', 8009: 'Cast TLS', 8443: 'Cast setup', 6466: 'ATV remote', 6467: 'ATV pairing', 7000: 'AirPlay' },
};
const CONTROL_PORT = { lg: 3001, samsung: 8001, roku: 8060, androidtv: 8009 };

export function tcpRtt(ip, port, timeout = 1500) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = net.connect({ host: ip, port, timeout });
    const done = (ok) => {
      sock.destroy();
      resolve(ok ? performance.now() - t0 : null);
    };
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

export function rttStats(samples) {
  const ok = samples.filter((s) => s != null);
  if (!ok.length) return { samples: samples.length, ok: 0, lossPct: 100 };
  const avg = ok.reduce((a, b) => a + b, 0) / ok.length;
  const jitter = ok.length > 1 ? ok.slice(1).reduce((a, s, i) => a + Math.abs(s - ok[i]), 0) / (ok.length - 1) : 0;
  const r = (x) => Math.round(x * 10) / 10;
  return { samples: samples.length, ok: ok.length, lossPct: Math.round(((samples.length - ok.length) / samples.length) * 100), min: r(Math.min(...ok)), avg: r(avg), max: r(Math.max(...ok)), jitter: r(jitter) };
}

async function getText(url, timeout = 2500) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.text();
}

// Roku ECP XML is flat <tag>value</tag>; keep every field.
export function flatXml(xml) {
  const out = {};
  for (const m of String(xml).matchAll(/<([\w-]+)>([^<]*)<\/\1>/g)) out[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  return out;
}

const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const yes = (v) => v === true || v === 'true';

async function brandInfo(tv, driver) {
  const ip = tv.ip;
  if (tv.brand === 'lg') {
    const d = (await driver?.diagnostics?.().catch((err) => ({ error: err.message }))) ?? { connected: false };
    const sw = d.software ?? {};
    const sys = d.system ?? {};
    const net0 = d.network ?? {};
    const wifi = net0.wifiInfo ?? {};
    return {
      raw: d,
      identity: { model: sys.modelName ?? tv.model, serial: sys.serialNumber ?? null },
      software: { os: sw.product_name ?? 'webOS', version: [sw.major_ver, sw.minor_ver].filter(Boolean).join('.') || null, build: sw.model_name ?? null, sdk: sys.sdkVersion ?? null, updateAvailable: null },
      network: { type: net0.wiredInfo?.state === 'connected' ? 'ethernet' : wifi.state === 'connected' ? 'wifi' : null, ssid: wifi.ssid ?? null, signalDbm: null },
      signals: {
        'Power state': d.power?.state ?? null,
        'Volume': d.volume?.volumeStatus?.volume ?? d.volume?.volume ?? null,
        'Launch points (apps)': d.launchPointCount,
        'External inputs': Array.isArray(d.inputs) ? d.inputs.length : null,
        'Inputs with a device': Array.isArray(d.inputs) ? d.inputs.filter((i) => i.connected).length : null,
        'Foreground app': d.foreground?.appId ?? null,
        'SSAP endpoint': d.url ?? null,
      },
    };
  }
  if (tv.brand === 'samsung') {
    const info = JSON.parse(await getText(`http://${ip}:8001/api/v2/`).catch(() => '{}'));
    const dv = info.device ?? {};
    return {
      raw: info,
      identity: { model: dv.modelName ?? tv.model, serial: dv.duid ?? null },
      software: { os: dv.OS ?? 'Tizen', version: dv.firmwareVersion && dv.firmwareVersion !== 'Unknown' ? dv.firmwareVersion : null, build: dv.msfVersion ? `MSF ${dv.msfVersion}` : null, updateAvailable: null },
      network: { type: dv.networkType ?? null, ssid: dv.ssid ?? null, signalDbm: null },
      signals: {
        'Power state (reported)': dv.PowerState ?? 'not reported (2016-17 set)',
        'Token auth': dv.TokenAuthSupport ?? 'no',
        'Resolution': dv.resolution ?? null,
        'Frame TV': dv.FrameTVSupport ?? null,
        'Game pad support': dv.GamePadSupport ?? null,
        'Voice support': dv.VoiceSupport ?? null,
        'Developer mode': dv.developerMode ?? null,
        'MSF version': dv.msfVersion ?? null,
      },
    };
  }
  if (tv.brand === 'roku') {
    const base = `http://${ip}:8060`;
    const [infoXml, playerXml, appsXml] = await Promise.all([
      getText(`${base}/query/device-info`).catch(() => ''),
      getText(`${base}/query/media-player`).catch(() => ''),
      getText(`${base}/query/apps`).catch(() => ''),
    ]);
    const di = flatXml(infoXml);
    const player = playerXml.match(/<player[^>]*state="([^"]+)"/)?.[1] ?? null;
    return {
      raw: { deviceInfo: di, mediaPlayer: playerXml.slice(0, 2000) },
      identity: { model: [di['model-name'], di['model-number']].filter(Boolean).join(' ') || tv.model, serial: di['serial-number'] ?? null },
      software: { os: 'Roku OS', version: di['software-version'] ?? null, build: di['software-build'] ?? null, updateAvailable: null },
      network: { type: di['network-type'] ?? null, ssid: di['network-name'] ?? null, signalDbm: null, band5g: yes(di['has-wifi-5G-support']) },
      signals: {
        'Uptime (h)': di.uptime ? Math.round(Number(di.uptime) / 360) / 10 : null,
        'Power mode': di['power-mode'] ?? null,
        'Is a TV': di['is-tv'] ?? null,
        'Is a stick': di['is-stick'] ?? null,
        'Supports 5 GHz Wi-Fi': di['has-wifi-5G-support'] ?? null,
        'Wake on WLAN': di['supports-wake-on-wlan'] ?? null,
        'Ethernet': di['supports-ethernet'] ?? null,
        'Media player': player,
        'Apps installed': (appsXml.match(/<app /g) ?? []).length || null,
        'Developer mode': di['developer-enabled'] ?? null,
        'UI resolution': di['ui-resolution'] ?? null,
        'Voice search': di['voice-search-enabled'] ?? null,
        'Notifications': di['notifications-enabled'] ?? null,
        'Headphones connected': di['headphones-connected'] ?? null,
      },
    };
  }
  if (tv.brand === 'androidtv') {
    const params = 'version,name,build_info,device_info,net,wifi,signal_level,noise_level,opt_in,setup';
    const e = JSON.parse(await getText(`http://${ip}:8008/setup/eureka_info?params=${params}`).catch(() => '{}'));
    const signal = num(e.signal_level ?? e.wifi?.signal_level);
    const noise = num(e.noise_level ?? e.wifi?.noise_level);
    return {
      raw: e,
      identity: { model: e.device_info?.model_name ?? tv.model, serial: null },
      software: { os: 'Google TV', version: e.cast_build_revision ?? null, build: e.build_version ?? null, updateAvailable: typeof e.has_update === 'boolean' ? e.has_update : null },
      network: { type: e.ethernet_connected ? 'ethernet' : 'wifi', ssid: e.ssid ?? null, signalDbm: signal, noiseDbm: noise, snrDb: signal != null && noise != null ? signal - noise : null },
      signals: {
        'Cast build': e.cast_build_revision ?? null,
        'Build version': e.build_version ?? null,
        'Update waiting': e.has_update ?? null,
        'Uptime (h)': e.uptime ? Math.round(e.uptime / 360) / 10 : null,
        'Wi-Fi signal (dBm)': signal,
        'Wi-Fi noise (dBm)': noise,
        'Crash reports on': e.opt_in?.crash ?? null,
        'Usage stats on': e.opt_in?.stats ?? null,
        'Setup state': e.setup_state ?? null,
        'Release track': e.release_track ?? null,
        'Wi-Fi supplicant state': e.wpa_state ?? null,
        'Cloud connected': e.connected ?? null,
      },
    };
  }
  return { raw: {}, identity: {}, software: {}, network: {}, signals: {} };
}

export async function diagnose(tv, view, driver) {
  const t0 = performance.now();
  const port = CONTROL_PORT[tv.brand];
  const ports = KNOWN_PORTS[tv.brand] ?? {};
  const [rtts, open, mac, info] = await Promise.all([
    (async () => {
      const out = [];
      for (let i = 0; i < 5; i++) out.push(port ? await tcpRtt(tv.ip, port) : null);
      return out;
    })(),
    Promise.all(Object.keys(ports).map(async (p) => ((await portOpen(tv.ip, Number(p), 900)) ? Number(p) : null))),
    macFor(tv.ip),
    brandInfo(tv, driver).catch((err) => ({ raw: { error: err.message }, identity: {}, software: {}, network: {}, signals: {} })),
  ]);
  return {
    at: Date.now(),
    tookMs: Math.round(performance.now() - t0),
    identity: { brand: tv.brand, name: tv.name, model: info.identity.model || tv.model, serial: info.identity.serial ?? null, ip: tv.ip, macs: tv.macs ?? [], arpMac: mac },
    software: info.software,
    network: {
      ...info.network,
      controlPort: port ?? null,
      rtt: rttStats(rtts),
      openPorts: open.filter(Boolean).map((p) => ({ port: p, service: ports[p] })),
      wolBroadcast: broadcastFor(tv.ip),
      protocol: { lg: 'SSAP (WebSocket)', samsung: 'Tizen remote channel (WebSocket)', roku: 'ECP (HTTP)', androidtv: 'Cast v2 (TLS + protobuf)' }[tv.brand] ?? null,
    },
    signals: info.signals,
    capabilities: view.capabilities,
    raw: info.raw,
  };
}
