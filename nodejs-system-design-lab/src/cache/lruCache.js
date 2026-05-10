/**
 * File Relationship Map
 * - Used by: src/services/urlShortenerService.js
 * - Surface exposed in: src/http/server.js /metrics
 * - Function: low-latency cache layer with TTL and LRU eviction
 */

class LruCache {
  constructor({ maxKeys = 10000, defaultTtlMs = 60000 } = {}) {
    if (!Number.isInteger(maxKeys) || maxKeys <= 0) {
      throw new Error("maxKeys must be a positive integer");
    }
    if (defaultTtlMs !== null && (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0)) {
      throw new Error("defaultTtlMs must be null or a positive number");
    }
    this.maxKeys = maxKeys;
    this.defaultTtlMs = defaultTtlMs;
    this.store = new Map();
    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      writes: 0,
      deletes: 0,
      expirations: 0,
    };
  }

  _now() {
    return Date.now();
  }

  _isExpired(entry) {
    return entry.expiresAt !== null && entry.expiresAt <= this._now();
  }

  _touch(key, entry) {
    this.store.delete(key);
    this.store.set(key, entry);
  }

  _evictIfNeeded() {
    while (this.store.size > this.maxKeys) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
      this.metrics.evictions += 1;
    }
  }

  _getEntry(key, { recordMetrics = true, touch = true } = {}) {
    const entry = this.store.get(key);
    if (!entry) {
      if (recordMetrics) {
        this.metrics.misses += 1;
      }
      return null;
    }

    if (this._isExpired(entry)) {
      this.store.delete(key);
      if (recordMetrics) {
        this.metrics.misses += 1;
      }
      this.metrics.expirations += 1;
      return null;
    }

    if (recordMetrics) {
      this.metrics.hits += 1;
    }
    if (touch) {
      this._touch(key, entry);
    }
    return entry;
  }

  get(key) {
    const entry = this._getEntry(key);
    if (!entry) {
      return null;
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error("ttlMs must be null or a positive number");
    }
    const expiresAt = ttlMs === null ? null : this._now() + ttlMs;
    const entry = { value, expiresAt };
    this.store.set(key, entry);
    this._touch(key, entry);
    this.metrics.writes += 1;
    this._evictIfNeeded();
  }

  has(key) {
    return this._getEntry(key, { recordMetrics: false, touch: false }) !== null;
  }

  delete(key) {
    const deleted = this.store.delete(key);
    if (deleted) {
      this.metrics.deletes += 1;
    }
    return deleted;
  }

  sweepExpired(limit = 5000) {
    let checked = 0;
    for (const [key, entry] of this.store) {
      if (checked >= limit) {
        break;
      }
      checked += 1;
      if (this._isExpired(entry)) {
        this.store.delete(key);
        this.metrics.expirations += 1;
      }
    }
  }

  stats() {
    const totalGets = this.metrics.hits + this.metrics.misses;
    const hitRate = totalGets === 0 ? 0 : this.metrics.hits / totalGets;
    return {
      ...this.metrics,
      size: this.store.size,
      maxKeys: this.maxKeys,
      hitRate,
    };
  }
}

module.exports = { LruCache };
