/**
 * File Relationship Map
 * - Used by: src/index.js, src/services/*.js, src/http/server.js, src/eventing/*.js
 * - Purpose: central in-memory metrics registry for counters/gauges/timers
 * - Related files:
 *   - src/common/logger.js
 *   - src/http/server.js
 */

class MetricsRegistry {
  constructor() {
    this.counters = new Map();
    this.gauges = new Map();
    this.timers = new Map();
  }

  _key(name, labels) {
    if (!labels || Object.keys(labels).length === 0) {
      return name;
    }
    const parts = Object.keys(labels)
      .sort()
      .map((k) => `${k}=${labels[k]}`);
    return `${name}{${parts.join(",")}}`;
  }

  inc(name, value = 1, labels = null) {
    const key = this._key(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  setGauge(name, value, labels = null) {
    const key = this._key(name, labels);
    this.gauges.set(key, value);
  }

  observeMs(name, durationMs, labels = null) {
    const key = this._key(name, labels);
    const state = this.timers.get(key) || { count: 0, totalMs: 0, maxMs: 0 };
    state.count += 1;
    state.totalMs += durationMs;
    state.maxMs = Math.max(state.maxMs, durationMs);
    this.timers.set(key, state);
  }

  snapshot() {
    const counters = {};
    const gauges = {};
    const timers = {};
    for (const [k, v] of this.counters.entries()) {
      counters[k] = v;
    }
    for (const [k, v] of this.gauges.entries()) {
      gauges[k] = v;
    }
    for (const [k, state] of this.timers.entries()) {
      timers[k] = {
        count: state.count,
        totalMs: state.totalMs,
        avgMs: state.count === 0 ? 0 : state.totalMs / state.count,
        maxMs: state.maxMs,
      };
    }
    return { counters, gauges, timers };
  }
}

module.exports = { MetricsRegistry };
