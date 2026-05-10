/**
 * File Relationship Map
 * - Used by: src/services/orderService.js
 * - Depends on:
 *   - src/services/inventoryService.js
 *   - src/services/paymentService.js
 *   - src/resilience/timeout.js
 * - Emits domain steps that become outbox events in orderService
 */

const { withTimeout } = require("../resilience/timeout");
const { logger } = require("../common/logger");

class OrderSaga {
  constructor({ inventoryService, paymentService, config, metrics }) {
    this.inventoryService = inventoryService;
    this.paymentService = paymentService;
    this.config = config;
    this.metrics = metrics;
  }

  async run(order) {
    const context = {
      orderId: order.id,
      reserved: false,
      charged: false,
      chargeResult: null,
    };

    try {
      await withTimeout(
        () => this.inventoryService.reserve(order.id, order.items),
        this.config.resilience.inventoryTimeoutMs,
        "Inventory reservation timed out"
      );
      context.reserved = true;
      this.metrics.inc("saga.inventory.reserved");
      logger.debug("Saga inventory reserved", { orderId: order.id });

      const amount = order.totalAmount;
      const chargeResult = await withTimeout(
        () => this.paymentService.charge(order.id, amount, order.paymentMethod),
        this.config.resilience.paymentTimeoutMs,
        "Payment charge timed out"
      );
      context.charged = true;
      context.chargeResult = chargeResult;
      this.metrics.inc("saga.payment.charged");
      logger.debug("Saga payment charged", { orderId: order.id, chargeId: chargeResult.chargeId });

      return {
        ok: true,
        status: "CONFIRMED",
        charge: chargeResult,
      };
    } catch (error) {
      this.metrics.inc("saga.failed");
      logger.warn("Saga failed; starting compensation", { orderId: order.id, error });
      await this._compensate(context);
      return {
        ok: false,
        status: "FAILED",
        reason: error.message,
        code: error.code || "SAGA_FAILED",
      };
    }
  }

  async _compensate(context) {
    if (context.charged) {
      await this.paymentService.refund(context.orderId);
      this.metrics.inc("saga.compensation.refund");
      logger.info("Saga refunded payment", { orderId: context.orderId });
    }
    if (context.reserved) {
      await this.inventoryService.release(context.orderId);
      this.metrics.inc("saga.compensation.release");
      logger.info("Saga released inventory", { orderId: context.orderId });
    }
  }
}

module.exports = { OrderSaga };
