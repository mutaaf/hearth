import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';

// Wake-on-LAN: 6×0xFF followed by the MAC 16 times, sent as UDP broadcast.
// TVs only honour it with "Turn on via Wi-Fi/LAN" enabled in their settings.
export function magicPacket(mac) {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error(`bad MAC address: ${mac}`);
  const macBytes = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBytes)]);
}

const toInt = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const toIp = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

// The broadcast address of the local network the TV is on, from the real
// netmask. Mesh routers love /22s (eero: 192.168.4.0–7.255), so guessing
// "x.y.z.255" sends the packet nowhere.
export function broadcastFor(ip, interfaces = os.networkInterfaces()) {
  if (!net.isIPv4(ip)) return null;
  for (const addr of Object.values(interfaces).flat()) {
    if (!addr || addr.family !== 'IPv4' || addr.internal || !addr.netmask) continue;
    const mask = toInt(addr.netmask);
    const net0 = toInt(addr.address) - (toInt(addr.address) % (2 ** 32 - mask));
    const size = 2 ** 32 - mask;
    const target = toInt(ip);
    if (target >= net0 && target < net0 + size) return toIp(net0 + size - 1);
  }
  return null;
}

// Every address in the /22 around this machine's own (a mesh router's whole
// network, and always the /24 inside it), nearest first, minus our own.
export function neighbours(interfaces = os.networkInterfaces()) {
  for (const addr of Object.values(interfaces).flat()) {
    if (!addr || addr.family !== 'IPv4' || addr.internal || !net.isIPv4(addr.address)) continue;
    const me = toInt(addr.address);
    const base = me - (me % 1024);
    const all = [];
    for (let n = base + 1; n < base + 1023; n++) if (n !== me) all.push(n);
    return all.sort((a, b) => Math.abs(a - me) - Math.abs(b - me)).map(toIp);
  }
  return [];
}

// Where broadcast isn't allowed (an iPhone without Apple's multicast
// entitlement), knock on every neighbour instead: a sleeping TV keeps its
// address and answers ARP, so a unicast magic packet to wherever the router
// put it overnight still wakes it. Set by the host; also kicks in by itself
// when a broadcast send fails.
const options = { spray: false };
export function configureWake(next) {
  Object.assign(options, next);
}

export async function wake(macs, ip, { spray = options.spray, hosts = neighbours, gapMs = 800 } = {}) {
  // Belt and braces: the subnet broadcast, the global broadcast, and the
  // TV's own address (the OS often still knows its MAC), on ports 9 and 7.
  const targets = new Set(['255.255.255.255']);
  const subnet = broadcastFor(ip);
  if (subnet) targets.add(subnet);
  if (ip && net.isIPv4(ip)) targets.add(ip);
  const broadcasts = new Set([...targets].filter((t) => t !== ip));
  let refused = false;
  const socket = dgram.createSocket('udp4');
  // A send to an unreachable network errors asynchronously; without a
  // listener that 'error' would crash Hearth. A wake is best-effort anyway.
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(resolve);
  });
  socket.setBroadcast(true);
  const send = (packet, port, host) =>
    new Promise((resolve) => {
      try {
        socket.send(packet, port, host, (err) => {
          if (err && broadcasts.has(host)) refused = true;
          resolve();
        });
      } catch {
        if (broadcasts.has(host)) refused = true;
        resolve();
      }
    });
  try {
    for (let round = 0; round < 3; round++) {
      for (const mac of macs) {
        const packet = magicPacket(mac);
        for (const host of targets) {
          for (const port of [9, 7]) await send(packet, port, host);
        }
      }
      if (round < 2) await new Promise((r) => setTimeout(r, 120));
    }
    if (spray || refused) {
      // Two passes: the first makes the OS ask "who has…?" (packets to
      // addresses it hasn't met yet are dropped while it asks), the second
      // goes out once the answers are in.
      const others = hosts().filter((h) => h !== ip);
      for (let pass = 0; pass < 2 && others.length; pass++) {
        for (const mac of macs) {
          const packet = magicPacket(mac);
          for (let i = 0; i < others.length; i += 64) await Promise.all(others.slice(i, i + 64).map((host) => send(packet, 9, host)));
        }
        if (pass === 0) await new Promise((r) => setTimeout(r, gapMs));
      }
    }
  } finally {
    try {
      socket.close();
    } catch {}
  }
}
