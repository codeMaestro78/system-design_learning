/**
 * File Relationship Map
 * - Used by: src/index.js
 * - Receives tasks from:
 *   - src/http/server.js (/tasks/email endpoint)
 *   - src/services/urlShortenerService.js (analytics click events)
 *   - src/index.js event subscribers (ORDER_CONFIRMED email)
 */

const { logger } = require("../common/logger");

class TaskQueue {
  constructor({ concurrency = 4, pollIntervalMs = 25 } = {}) {
    this.concurrency = concurrency;
    this.pollIntervalMs = pollIntervalMs;
    this.pending = [];
    this.deadLetter = [];
    this.handlers = new Map();
    this.active = 0;
    this.running = false;
    this.timer = null;
    this.metrics = {
      enqueued: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      deadLettered: 0,
    };
  }

  registerHandler(type, fn) {
    if (!type || typeof fn !== "function") {
      throw new Error("handler type and function are required");
    }
    this.handlers.set(type, fn);
    logger.info("Task handler registered", { type });
  }

  enqueue(task) {
    if (!task || !task.type) {
      throw new Error("task.type is required");
    }
    const normalized = {
      id: task.id ?? `${task.type}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      type: task.type,
      payload: task.payload ?? {},
      attempts: task.attempts ?? 0,
      maxAttempts: task.maxAttempts ?? 5,
      backoffMs: task.backoffMs ?? 100,
      visibleAt: task.visibleAt ?? Date.now(),
    };
    this.pending.push(normalized);
    this.metrics.enqueued += 1;
    logger.debug("Task enqueued", {
      taskId: normalized.id,
      type: normalized.type,
      maxAttempts: normalized.maxAttempts,
      visibleAt: normalized.visibleAt,
    });
    return normalized.id;
  }

  async _processTask(task) {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      throw new Error(`No handler registered for task type: ${task.type}`);
    }
    await handler(task.payload, task);
  }

  _scheduleRetry(task, error) {
    task.attempts += 1;
    if (task.attempts >= task.maxAttempts) {
      // Dead-letter keeps poisoned work inspectable instead of retrying forever.
      this.deadLetter.push({
        ...task,
        error: {
          message: error.message,
          code: error.code ?? "TASK_FAILED",
        },
        deadLetteredAt: Date.now(),
      });
      this.metrics.deadLettered += 1;
      return;
    }
    // Exponential backoff protects dependencies and workers from retry storms.
    const delay = Math.min(10000, task.backoffMs * 2 ** (task.attempts - 1));
    task.visibleAt = Date.now() + delay;
    this.pending.push(task);
    this.metrics.retried += 1;
  }

  async _tick() {
    const now = Date.now();
    this.pending.sort((a, b) => a.visibleAt - b.visibleAt);
    while (this.active < this.concurrency && this.pending.length > 0 && this.pending[0].visibleAt <= now) {
      const task = this.pending.shift();
      this.active += 1;
      this._processTask(task)
        .then(() => {
          this.metrics.completed += 1;
          logger.debug("Task completed", { taskId: task.id, type: task.type, attempts: task.attempts + 1 });
        })
        .catch((error) => {
          this.metrics.failed += 1;
          logger.warn("Task failed", { taskId: task.id, type: task.type, error: error.message });
          this._scheduleRetry(task, error);
        })
        .finally(() => {
          this.active -= 1;
        });
    }
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    logger.info("Task queue started", { concurrency: this.concurrency, pollIntervalMs: this.pollIntervalMs });
    const loop = async () => {
      if (!this.running) {
        return;
      }
      await this._tick();
      this.timer = setTimeout(loop, this.pollIntervalMs);
      if (typeof this.timer.unref === "function") {
        this.timer.unref();
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
    logger.info("Task queue stopped", { pending: this.pending.length, active: this.active });
  }

  stats() {
    return {
      ...this.metrics,
      pending: this.pending.length,
      active: this.active,
      deadLetterSize: this.deadLetter.length,
      handlers: this.handlers.size,
      concurrency: this.concurrency,
    };
  }
}

module.exports = { TaskQueue };
