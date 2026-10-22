// Errors that carry an HTTP status, so drivers can say "not supported" or
// "TV is off" without knowing anything about the web server.
export class HearthError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const unsupported = (what) => new HearthError(501, `${what} isn't supported on this TV`);
export const notFound = (what) => new HearthError(404, `${what} not found`);
export const badRequest = (message) => new HearthError(400, message);
export const offline = () => new HearthError(503, 'TV is off or not reachable');

// Network errors that mean "the TV isn't there right now" (off, asleep,
// unplugged, Wi-Fi gone), never "Hearth is broken". Every driver maps these
// to offline() → 503, so the app says "off or not reachable", not a 500.
const UNREACHABLE = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
export function isUnreachable(err) {
  if (!err) return false;
  if (err.status === 503) return true;
  if (UNREACHABLE.has(err.code) || UNREACHABLE.has(err.cause?.code)) return true;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  return /handshake has timed out|opening handshake|socket hang up|^timeout$|timed out|^stale$/i.test(err.message ?? '');
}
// Pass through what's already a HearthError; turn "not there" into offline().
export const asOffline = (err) => (err instanceof HearthError ? err : isUnreachable(err) ? offline() : err);
