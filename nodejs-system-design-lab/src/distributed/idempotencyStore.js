class IdempotencyStore {
  constructor({ inProgressTtlMs = 30000, completeTtlMs = 10 * 60 * 1000 } = {}) {
    this.inProgressTtlMs = inProgressTtlMs;
    this.completeTtlMs = completeTtlMs;
    this.entries = new Map();
  }

  _now() {
    return Date.now();
  }

  _sweepIfExpired(key, entry) {
    if (!entry) {
      return null;
    }
    if (entry.expiresAt <= this._now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  begin(key) {
    const existing = this._sweepIfExpired(key, this.entries.get(key));
    if (existing) {
      return {
        allowed: false,
        status: existing.status,
        response: existing.response,
      };
    }
    this.entries.set(key, {
      status: "IN_PROGRESS",
      response: null,
      expiresAt: this._now() + this.inProgressTtlMs,
    });
    return { allowed: true, status: "IN_PROGRESS", response: null };
  }

  complete(key, response) {
    this.entries.set(key, {
      status: "COMPLETED",
      response,
      expiresAt: this._now() + this.completeTtlMs,
    });
  }

  fail(key) {
    this.entries.delete(key);
  }

  get(key) {
    const entry = this._sweepIfExpired(key, this.entries.get(key));
    if (!entry) {
      return null;
    }
    return {
      status: entry.status,
      response: entry.response,
    };
  }

  sweep(limit = 2000) {
    let checked = 0;
    for (const [key, entry] of this.entries) {
      if (checked >= limit) {
        break;
      }
      checked += 1;
      this._sweepIfExpired(key, entry);
    }
  }

  stats() {
    let inProgress = 0;
    let completed = 0;
    for (const entry of this.entries.values()) {
      if (entry.status === "IN_PROGRESS") {
        inProgress += 1;
      } else if (entry.status === "COMPLETED") {
        completed += 1;
      }
    }
    return { size: this.entries.size, inProgress, completed };
  }
}

module.exports = { IdempotencyStore };
