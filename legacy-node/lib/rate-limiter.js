class RateLimiter {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.entries = new Map();
    this.operations = 0;
  }

  consume(key, cooldownMs) {
    const now = this.now();
    const availableAt = this.entries.get(key) || 0;
    if (now < availableAt) return false;

    this.entries.set(key, now + cooldownMs);
    this.operations += 1;
    if (this.operations % 100 === 0) this.prune(now);
    return true;
  }

  prune(now = this.now()) {
    for (const [key, availableAt] of this.entries) {
      if (availableAt <= now) this.entries.delete(key);
    }
  }

  clear() {
    this.entries.clear();
  }
}

module.exports = { RateLimiter };
