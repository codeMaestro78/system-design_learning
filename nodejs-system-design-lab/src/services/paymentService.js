/**
 * File Relationship Map
 * - Used by: src/services/orderService.js
 * - Depends on: src/resilience/bulkhead.js
 * - Related to compensation in: src/workflows/orderSaga.js
 */

const { Bulkhead } = require("../resilience/bulkhead");
const { logger } = require("../common/logger");

class PaymentService {
  constructor({ failureRate = 0.15, metrics = null }) {
    this.failureRate = failureRate;
    this.metrics = metrics;
    this.bulkhead = new Bulkhead({ maxConcurrent: 10, name: "payment" });
    this.charges = new Map();
  }

  async charge(orderId, amount, paymentMethod) {
    return this.bulkhead.execute(async () => {
      this.metrics && this.metrics.inc("payment.charge.total");
      if (amount <= 0) {
        const err = new Error("Invalid payment amount");
        err.code = "PAYMENT_BAD_AMOUNT";
        throw err;
      }
      if (Math.random() < this.failureRate) {
        this.metrics && this.metrics.inc("payment.charge.failed");
        const err = new Error("Payment gateway timeout");
        err.code = "PAYMENT_TIMEOUT";
        logger.warn("Payment charge failed", { orderId, amount, error: err });
        throw err;
      }
      const charge = {
        chargeId: `ch_${orderId}_${Date.now()}`,
        status: "CAPTURED",
        amount,
        paymentMethod: paymentMethod || "card",
      };
      this.charges.set(orderId, charge);
      logger.debug("Payment charged", { orderId, chargeId: charge.chargeId, amount });
      return charge;
    });
  }

  async refund(orderId) {
    return this.bulkhead.execute(async () => {
      this.metrics && this.metrics.inc("payment.refund.total");
      const charge = this.charges.get(orderId);
      if (!charge) {
        logger.debug("Payment refund skipped; no charge found", { orderId });
        return { status: "NOOP" };
      }
      charge.status = "REFUNDED";
      logger.info("Payment refunded", { orderId, chargeId: charge.chargeId });
      return { status: "REFUNDED", chargeId: charge.chargeId };
    });
  }

  stats() {
    return {
      charges: this.charges.size,
      bulkhead: this.bulkhead.stats(),
      failureRate: this.failureRate,
    };
  }
}

module.exports = { PaymentService };
