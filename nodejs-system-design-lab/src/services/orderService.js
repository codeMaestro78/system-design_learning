/**
 * File Relationship Map
 * - Used by: src/http/server.js
 * - Depends on:
 *   - src/workflows/orderSaga.js
 *   - src/distributed/idempotencyStore.js
 *   - src/eventing/outboxProcessor.js (consumes outbox entries)
 * - Related files:
 *   - src/eventing/eventBus.js
 *   - src/services/paymentService.js
 *   - src/services/inventoryService.js
 */

const { logger } = require("../common/logger");

class OrderService {
  constructor({ saga, idempotencyStore, config, metrics }) {
    this.saga = saga;
    this.idempotencyStore = idempotencyStore;
    this.config = config;
    this.metrics = metrics;
    this.orders = new Map();
    this.outbox = [];
    this.nextOutboxId = 1;
  }

  _validateInput(input) {
    if (!input || !Array.isArray(input.items) || input.items.length === 0) {
      const err = new Error("items array is required");
      err.statusCode = 400;
      throw err;
    }
    if (input.items.length > this.config.limits.maxItemsPerOrder) {
      const err = new Error("too many items in one order");
      err.statusCode = 400;
      throw err;
    }
    for (let i = 0; i < input.items.length; i += 1) {
      const item = input.items[i];
      if (
        !item.sku ||
        typeof item.sku !== "string" ||
        !Number.isInteger(item.qty) ||
        item.qty <= 0 ||
        !Number.isFinite(item.price) ||
        item.price < 0
      ) {
        const err = new Error("invalid item payload");
        err.statusCode = 400;
        throw err;
      }
    }
  }

  _computeTotal(items) {
    let total = 0;
    for (let i = 0; i < items.length; i += 1) {
      total += items[i].qty * items[i].price;
    }
    if (!Number.isFinite(total)) {
      const err = new Error("invalid order total");
      err.statusCode = 400;
      throw err;
    }
    return total;
  }

  _createOrderRecord(input) {
    const id = `ord_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
    const totalAmount = this._computeTotal(input.items);
    if (totalAmount > this.config.limits.maxOrderValue) {
      const err = new Error("order value exceeds allowed limit");
      err.statusCode = 400;
      throw err;
    }
    return {
      id,
      userId: input.userId || "anonymous",
      items: input.items.map((item) => ({ ...item })),
      paymentMethod: input.paymentMethod || "card",
      totalAmount,
      status: "PENDING",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      failureReason: null,
      chargeId: null,
    };
  }

  _appendOutbox(event) {
    this.outbox.push({
      id: this.nextOutboxId++,
      event,
      status: "PENDING",
      retries: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastError: null,
    });
  }

  async createOrder(input, idempotencyKey) {
    this._validateInput(input);
    if (!idempotencyKey) {
      const err = new Error("idempotencyKey is required");
      err.statusCode = 400;
      throw err;
    }

    const gate = this.idempotencyStore.begin(`order:${idempotencyKey}`);
    if (!gate.allowed) {
      if (gate.status === "COMPLETED" && gate.response) {
        logger.info("Returning idempotent order response", { idempotencyKey, orderId: gate.response.orderId });
        return gate.response;
      }
      const conflict = new Error("duplicate order request in progress");
      conflict.statusCode = 409;
      throw conflict;
    }

    try {
      const order = this._createOrderRecord(input);
      this.orders.set(order.id, order);
      this.metrics.inc("orders.created");
      logger.info("Order created", {
        orderId: order.id,
        userId: order.userId,
        itemCount: order.items.length,
        totalAmount: order.totalAmount,
      });

      const sagaResult = await this.saga.run(order);
      if (sagaResult.ok) {
        order.status = "CONFIRMED";
        order.chargeId = sagaResult.charge.chargeId;
        this._appendOutbox({
          type: "ORDER_CONFIRMED",
          orderId: order.id,
          userId: order.userId,
          amount: order.totalAmount,
          ts: Date.now(),
        });
        logger.info("Order confirmed", { orderId: order.id, chargeId: order.chargeId });
      } else {
        order.status = "FAILED";
        order.failureReason = sagaResult.reason;
        this._appendOutbox({
          type: "ORDER_FAILED",
          orderId: order.id,
          userId: order.userId,
          reason: sagaResult.reason,
          ts: Date.now(),
        });
        logger.warn("Order failed", { orderId: order.id, reason: sagaResult.reason });
      }

      order.updatedAt = Date.now();
      const response = {
        orderId: order.id,
        status: order.status,
        totalAmount: order.totalAmount,
        failureReason: order.failureReason,
      };
      this.idempotencyStore.complete(`order:${idempotencyKey}`, response);
      return response;
    } catch (error) {
      this.idempotencyStore.fail(`order:${idempotencyKey}`);
      logger.error("Order creation failed", { idempotencyKey, error });
      throw error;
    }
  }

  getOrder(orderId) {
    return this.orders.get(orderId) || null;
  }

  getOutboxBatch(batchSize) {
    const result = [];
    for (let i = 0; i < this.outbox.length && result.length < batchSize; i += 1) {
      const entry = this.outbox[i];
      if (entry.status === "PENDING") {
        entry.status = "PROCESSING";
        entry.updatedAt = Date.now();
        result.push(entry);
      }
    }
    return result;
  }

  markOutboxPublished(outboxId) {
    for (let i = 0; i < this.outbox.length; i += 1) {
      if (this.outbox[i].id === outboxId) {
        this.outbox[i].status = "PUBLISHED";
        this.outbox[i].updatedAt = Date.now();
        logger.debug("Outbox entry published", { outboxId });
        return;
      }
    }
  }

  markOutboxFailed(outboxId, message) {
    for (let i = 0; i < this.outbox.length; i += 1) {
      if (this.outbox[i].id === outboxId) {
        this.outbox[i].status = "PENDING";
        this.outbox[i].retries += 1;
        this.outbox[i].updatedAt = Date.now();
        this.outbox[i].lastError = message;
        logger.warn("Outbox entry marked for retry", { outboxId, retries: this.outbox[i].retries, message });
        return;
      }
    }
  }

  stats() {
    let confirmed = 0;
    let failed = 0;
    let pendingOutbox = 0;
    for (const order of this.orders.values()) {
      if (order.status === "CONFIRMED") {
        confirmed += 1;
      } else if (order.status === "FAILED") {
        failed += 1;
      }
    }
    for (let i = 0; i < this.outbox.length; i += 1) {
      if (this.outbox[i].status !== "PUBLISHED") {
        pendingOutbox += 1;
      }
    }
    return {
      totalOrders: this.orders.size,
      confirmed,
      failed,
      outboxSize: this.outbox.length,
      pendingOutbox,
    };
  }
}

module.exports = { OrderService };
