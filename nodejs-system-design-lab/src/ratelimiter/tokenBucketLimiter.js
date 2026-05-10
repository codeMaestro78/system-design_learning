class TokenBucketLimiter {
  constructor({ capacity = 60, refillPerSecond = 30 } = {}) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error("capacity must be a positive number");
    }
    if (!Number.isFinite(refillPerSecond) || refillPerSecond <= 0) {
      throw new Error("refillPerSecond must be a positive number");
    }
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.buckets = new Map();
    this.metrics = {
      allowed: 0,
      denied: 0,
      activeBuckets: 0,
    };
  }

  _now() {
    return Date.now();
  }

  _getBucket(key) {
    const now = this._now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        tokens: this.capacity,
        lastRefillTs: now,
      };
      this.buckets.set(key, bucket);
    }
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefillTs) / 1000);
    const refillTokens = elapsedSeconds * this.refillPerSecond;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refillTokens);
    bucket.lastRefillTs = now;
    return bucket;
  }

  allow(key, cost = 1) {
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error("cost must be a positive number");
    }
    const bucket = this._getBucket(key);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.metrics.allowed += 1;
      this.metrics.activeBuckets = this.buckets.size;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    this.metrics.denied += 1;
    this.metrics.activeBuckets = this.buckets.size;
    const missing = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((missing / this.refillPerSecond) * 1000);
    return { allowed: false, remaining: Math.floor(bucket.tokens), retryAfterMs };
  }

  sweepInactive(maxIdleMs = 10 * 60 * 1000) {
    const now = this._now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefillTs > maxIdleMs) {
        this.buckets.delete(key);
      }
    }
    this.metrics.activeBuckets = this.buckets.size;
  }

  stats() {
    return {
      ...this.metrics,
      capacity: this.capacity,
      refillPerSecond: this.refillPerSecond,
    };
  }
}

module.exports = { TokenBucketLimiter };
