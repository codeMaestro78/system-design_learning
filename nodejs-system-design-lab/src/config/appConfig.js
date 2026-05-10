/**
 * File Relationship Map
 * - Used by: src/index.js
 * - Influences: service behavior (timeouts, failure rates, retries)
 * - Related files:
 *   - src/resilience/timeout.js
 *   - src/services/paymentService.js
 *   - src/services/orderService.js
 */

function toNumber(raw, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function toInt(raw, fallback) {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return value;
}

function positiveInt(raw, fallback) {
  const value = toInt(raw, fallback);
  return value > 0 ? value : fallback;
}

function positiveNumber(raw, fallback) {
  const value = toNumber(raw, fallback);
  return value > 0 ? value : fallback;
}

function loadAppConfig() {
  return {
    server: {
      preferredPort: positiveInt(process.env.PORT, 3100),
      maxPortAttempts: process.env.PORT ? 1 : 25,
    },
    resilience: {
      paymentTimeoutMs: positiveInt(process.env.PAYMENT_TIMEOUT_MS, 400),
      inventoryTimeoutMs: positiveInt(process.env.INVENTORY_TIMEOUT_MS, 250),
      paymentFailureRate: Math.max(0, Math.min(0.9, toNumber(process.env.PAYMENT_FAILURE_RATE, 0.15))),
      inventoryFailureRate: Math.max(0, Math.min(0.9, toNumber(process.env.INVENTORY_FAILURE_RATE, 0.1))),
      outboxBatchSize: positiveInt(process.env.OUTBOX_BATCH_SIZE, 50),
      outboxPollMs: positiveInt(process.env.OUTBOX_POLL_MS, 100),
    },
    limits: {
      maxItemsPerOrder: positiveInt(process.env.MAX_ITEMS_PER_ORDER, 30),
      maxOrderValue: positiveNumber(process.env.MAX_ORDER_VALUE, 500000),
    },
  };
}

module.exports = { loadAppConfig };
