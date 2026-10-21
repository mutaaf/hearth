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

export async function wake(macs, ip) {
  // Belt and braces: the subnet broadcast, the global broadcast, and the
  // TV's own address (the OS often still knows its MAC), on ports 9 and 7.
  const targets = new Set(['255.255.255.255']);
  const subnet = broadcastFor(ip);
  if (subnet) targets.add(subnet);
  if (ip && net.isIPv4(ip)) targets.add(ip);
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(resolve));
  socket.setBroadcast(true);
  try {
    for (let round = 0; round < 3; round++) {
      for (const mac of macs) {
        const packet = magicPacket(mac);
        for (const host of targets) {
          for (const port of [9, 7]) {
            await new Promise((resolve) => socket.send(packet, port, host, () => resolve()));
          }
        }
      }
      if (round < 2) await new Promise((r) => setTimeout(r, 120));
    }
  } finally {
    socket.close();
  }
}
