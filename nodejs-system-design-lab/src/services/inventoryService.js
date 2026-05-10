/**
 * File Relationship Map
 * - Used by: src/services/orderService.js
 * - Depends on: src/resilience/bulkhead.js
 * - Related to compensation in: src/workflows/orderSaga.js
 */

const { Bulkhead } = require("../resilience/bulkhead");
const { logger } = require("../common/logger");

class InventoryService {
  constructor({ failureRate = 0.1, metrics = null }) {
    this.failureRate = failureRate;
    this.metrics = metrics;
    this.bulkhead = new Bulkhead({ maxConcurrent: 20, name: "inventory" });
    this.reservations = new Map();
  }

  async reserve(orderId, items) {
    return this.bulkhead.execute(async () => {
      this.metrics && this.metrics.inc("inventory.reserve.total");
      if (Math.random() < this.failureRate) {
        this.metrics && this.metrics.inc("inventory.reserve.failed");
        const err = new Error("Inventory dependency failed");
        err.code = "INVENTORY_DOWN";
        logger.warn("Inventory reserve failed", { orderId, error: err });
        throw err;
      }
      this.reservations.set(orderId, { items, status: "RESERVED", ts: Date.now() });
      logger.debug("Inventory reserved", { orderId, itemCount: items.length });
      return { reservationId: `resv-${orderId}`, status: "RESERVED" };
    });
  }

  async release(orderId) {
    return this.bulkhead.execute(async () => {
      this.metrics && this.metrics.inc("inventory.release.total");
      this.reservations.delete(orderId);
      logger.debug("Inventory reservation released", { orderId });
      return { status: "RELEASED" };
    });
  }

  stats() {
    return {
      reservations: this.reservations.size,
      bulkhead: this.bulkhead.stats(),
      failureRate: this.failureRate,
    };
  }
}

module.exports = { InventoryService };
