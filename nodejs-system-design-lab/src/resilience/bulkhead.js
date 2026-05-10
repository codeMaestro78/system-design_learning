/**
 * File Relationship Map
 * - Used by: src/services/paymentService.js, src/services/inventoryService.js
 * - Purpose: isolate dependency saturation using strict concurrency cap
 */

class Bulkhead {
  constructor({ maxConcurrent = 10, name = "bulkhead" } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.name = name;
    this.active = 0;
    this.metrics = {
      accepted: 0,
      rejected: 0,
      completed: 0,
      failed: 0,
    };
  }

  async execute(fn) {
    if (this.active >= this.maxConcurrent) {
      this.metrics.rejected += 1;
      const error = new Error(`Bulkhead ${this.name} saturated`);
      error.code = "BULKHEAD_REJECTED";
      throw error;
    }
    this.active += 1;
    this.metrics.accepted += 1;
    try {
      const out = await fn();
      this.metrics.completed += 1;
      return out;
    } catch (error) {
      this.metrics.failed += 1;
      throw error;
    } finally {
      this.active -= 1;
    }
  }

  stats() {
    return {
      ...this.metrics,
      active: this.active,
      maxConcurrent: this.maxConcurrent,
      name: this.name,
    };
  }
}

module.exports = { Bulkhead };
