import net from 'node:net';

// Who may talk to Hearth, and where Hearth may reach on someone's behalf.
//
// DNS rebinding: a web page on evil.example can re-point its own name at
// 192.168.x.x and then call the API "same-origin". It can't make the browser
// send a Host header that isn't its own public name, so only names that can't
// be bought on the internet are accepted: IP literals on private ranges,
// localhost, single-label names (mac-mini), local suffixes (.local, .lan,
// .home.arpa…), the friendly URL's host and anything in HEARTH_ALLOWED_HOSTS.

const LOCAL_SUFFIXES = ['.local', '.localhost', '.lan', '.home', '.home.arpa', '.internal', '.localdomain'];

const v4 = (ip) => ip.split('.').map(Number);
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = v4(ip);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); // last: CGNAT/Tailscale
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    return x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || /^::ffff:/.test(x) && isPrivateIp(x.slice(7));
  }
  return false;
}

// Addresses a TV can never live at: refused for add/PATCH (and so for the
// icon proxy, which only ever fetches from a TV's own address).
export function isForbiddenTarget(ip) {
  if (!net.isIPv4(ip)) return true; // TVs are IPv4 on every LAN we support
  // (x.y.z.0 and .255 stay allowed: on a /22, 192.168.5.0 is an ordinary host.)
  const [a, b] = v4(ip);
  return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
}

const hostOf = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) return raw.slice(1, raw.indexOf(']'));
  return raw.replace(/:\d+$/, '');
};

export function createHostCheck({ friendlyUrl = process.env.HEARTH_FRIENDLY_URL, extra = process.env.HEARTH_ALLOWED_HOSTS } = {}) {
  const named = new Set(['localhost']);
  try {
    if (friendlyUrl) named.add(new URL(friendlyUrl).hostname.toLowerCase());
  } catch {}
  for (const h of String(extra ?? '').split(',')) if (h.trim()) named.add(hostOf(h));
  const allowed = (host) => {
    if (!host) return false;
    if (named.has(host)) return true;
    if (net.isIP(host)) return isPrivateIp(host);
    if (!host.includes('.')) return true; // "mac-mini": a LAN name, not buyable
    return LOCAL_SUFFIXES.some((s) => host.endsWith(s));
  };
  return {
    // → null when OK, else a reason. A missing Host (HTTP/1.0 tools) is fine.
    check(req, { mutating = false } = {}) {
      const host = hostOf(req.headers.host);
      if (req.headers.host && !allowed(host)) return `Unknown host "${host}"`;
      const origin = req.headers.origin;
      if (mutating && origin) {
        let o = null;
        try {
          o = new URL(origin).host;
        } catch {}
        if (!o || !allowed(hostOf(o))) return 'Cross-site request refused';
      }
      return null;
    },
    allowed: (h) => allowed(hostOf(h)),
  };
}

// A small token bucket per client and action: plenty for a family tapping
// around, but nobody on the Wi-Fi can hammer scans, doctor runs (which wake
// TVs and wait 25 s) or cloud AI calls in a loop.
export function createLimiter({ capacity = 6, refillMs = 10_000, now = Date.now } = {}) {
  const buckets = new Map();
  return {
    take(key) {
      const t = now();
      const b = buckets.get(key) ?? { tokens: capacity, at: t };
      b.tokens = Math.min(capacity, b.tokens + (t - b.at) / refillMs);
      b.at = t;
      if (buckets.size > 2000) buckets.clear(); // never grows without bound
      buckets.set(key, b);
      if (b.tokens < 1) return Math.ceil((1 - b.tokens) * refillMs);
      b.tokens -= 1;
      return 0;
    },
  };
}
