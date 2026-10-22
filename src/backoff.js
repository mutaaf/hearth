// Reconnect pacing shared by every long-lived connection (LG, Cast, the
// Apple TV helper): exponential from `min` to `max` with ±jitter, so ten TVs
// that dropped together don't all knock at once. A connection only counts
// as healthy again once it has stayed up for `healthyMs`; a link that drops
// right after connecting keeps backing off instead of looping fast.
export class Backoff {
  #delay;
  #upSince = null;

  constructor({ min = 2000, max = 60_000, jitter = 0.2, healthyMs = 60_000, random = Math.random, now = Date.now } = {}) {
    Object.assign(this, { min, max, jitter, healthyMs, random, now });
    this.#delay = min;
  }

  // The connection is up.
  up() {
    this.#upSince = this.now();
  }

  // The connection failed or dropped: how long to wait before the next try.
  next() {
    if (this.#upSince != null && this.now() - this.#upSince >= this.healthyMs) this.#delay = this.min;
    this.#upSince = null;
    const base = this.#delay;
    this.#delay = Math.min(this.max, this.#delay * 2);
    return Math.max(0, Math.round(base * (1 + (this.random() * 2 - 1) * this.jitter)));
  }

  reset() {
    this.#delay = this.min;
    this.#upSince = null;
  }
}
