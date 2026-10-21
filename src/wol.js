import dgram from 'node:dgram';

// Wake-on-LAN: 6×0xFF followed by the MAC 16 times, sent as UDP broadcast.
// TVs only honour it with "Turn on via Wi-Fi/LAN" enabled in their settings.
export function magicPacket(mac) {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error(`bad MAC address: ${mac}`);
  const macBytes = Buffer.from(hex, 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBytes)]);
}

export async function wake(macs, ip) {
  const targets = ['255.255.255.255'];
  // Directed broadcast for the TV's /24 too; some mesh routers drop the global one.
  if (ip) targets.push(ip.replace(/\.\d+$/, '.255'));
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(resolve));
  socket.setBroadcast(true);
  try {
    for (const mac of macs) {
      const packet = magicPacket(mac);
      for (let i = 0; i < 3; i++) {
        for (const host of targets) {
          await new Promise((resolve) => socket.send(packet, 9, host, () => resolve()));
        }
      }
    }
  } finally {
    socket.close();
  }
}
