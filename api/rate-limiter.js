class FixedWindowRateLimiter {
  constructor(options) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.now = options.now || Date.now;
    this.windows = new Map();
  }

  consume(clientId) {
    const now = this.now();
    let window = this.windows.get(clientId);
    if (!window || now >= window.endsAt) {
      window = { count: 0, endsAt: now + this.windowMs };
      this.windows.set(clientId, window);
    }
    if (window.count >= this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((window.endsAt - now) / 1000)),
      };
    }
    window.count += 1;
    return { allowed: true };
  }
}

module.exports = { FixedWindowRateLimiter };
