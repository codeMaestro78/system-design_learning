/**
 * File Relationship Map
 * - Used by: src/index.js
 * - Depends on: src/services/orderService.js (outbox storage) + src/eventing/eventBus.js
 * - Purpose: transactional outbox processor to avoid lost events
 */

const { logger } = require("../common/logger");

class OutboxProcessor {
  constructor({ orderService, eventBus, metrics, pollMs = 100, batchSize = 50 }) {
    this.orderService = orderService;
    this.eventBus = eventBus;
    this.metrics = metrics;
    this.pollMs = pollMs;
    this.batchSize = batchSize;
    this.running = false;
    this.timer = null;
  }

  async _tick() {
    const batch = this.orderService.getOutboxBatch(this.batchSize);
    if (batch.length === 0) {
      return;
    }
    for (let i = 0; i < batch.length; i += 1) {
      const entry = batch[i];
      try {
        // Publishing from the outbox makes the local order write and future event publication recoverable.
        logger.debug("Publishing outbox event", { outboxId: entry.id, type: entry.event.type });
        await this.eventBus.publish(entry.event);
        this.orderService.markOutboxPublished(entry.id);
        this.metrics.inc("outbox.publish.success");
      } catch (error) {
        this.orderService.markOutboxFailed(entry.id, error.message);
        this.metrics.inc("outbox.publish.failed");
        logger.error("Outbox publish failed", {
          outboxId: entry.id,
          type: entry.event.type,
          error,
        });
      }
    }
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    logger.info("Outbox processor started", { pollMs: this.pollMs, batchSize: this.batchSize });
    const loop = async () => {
      if (!this.running) {
        return;
      }
      try {
        await this._tick();
      } finally {
        this.timer = setTimeout(loop, this.pollMs);
        if (typeof this.timer.unref === "function") {
          this.timer.unref();
        }
      }
    };
    loop();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("Outbox processor stopped");
  }
}

module.exports = { OutboxProcessor };
