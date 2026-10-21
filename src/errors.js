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
