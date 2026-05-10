/**
 * File Relationship Map
 * - Used by: src/index.js, src/eventing/outboxProcessor.js, src/services/orderService.js
 * - Subscribed by: analytics/email handlers or auditing consumers
 * - Related files:
 *   - src/queue/taskQueue.js
 *   - src/observability/metricsRegistry.js
 */

const { logger } = require("../common/logger");

class EventBus {
  constructor({ metrics = null } = {}) {
    this.handlers = new Map();
    this.deadLetter = [];
    this.metrics = metrics;
  }

  subscribe(eventType, handler) {
    const list = this.handlers.get(eventType) || [];
    list.push(handler);
    this.handlers.set(eventType, list);
    logger.info("Event handler subscribed", { eventType, handlerCount: list.length });
  }

  async publish(event) {
    if (!event || !event.type) {
      throw new Error("event.type is required");
    }
    const list = this.handlers.get(event.type) || [];
    logger.debug("Publishing event", { type: event.type, handlerCount: list.length });
    if (this.metrics) {
      this.metrics.inc("eventbus.publish.total", 1, { type: event.type });
    }
    for (let i = 0; i < list.length; i += 1) {
      const handler = list[i];
      try {
        await handler(event);
      } catch (error) {
        this.deadLetter.push({
          event,
          error: error.message,
          failedAt: Date.now(),
        });
        if (this.metrics) {
          this.metrics.inc("eventbus.handler.error", 1, { type: event.type });
        }
        logger.error("Event handler failed", { type: event.type, error });
      }
    }
  }

  stats() {
    return {
      eventTypes: this.handlers.size,
      deadLetterSize: this.deadLetter.length,
    };
  }
}

module.exports = { EventBus };
