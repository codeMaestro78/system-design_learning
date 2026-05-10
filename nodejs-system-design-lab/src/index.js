/**
 * File Relationship Map
 * - Entry point. Assembles all modules into a production-like graph.
 * - Core chains:
 *   1) HTTP -> OrderService -> OrderSaga -> Inventory/Payment -> Outbox -> EventBus
 *   2) HTTP -> UrlShortenerService -> Cache/Queue/CircuitBreaker
 * - Related files:
 *   - src/http/server.js
 *   - src/services/orderService.js
 *   - src/eventing/outboxProcessor.js
 */

const { LruCache } = require("./cache/lruCache");
const { TokenBucketLimiter } = require("./ratelimiter/tokenBucketLimiter");
const { TaskQueue } = require("./queue/taskQueue");
const { IdempotencyStore } = require("./distributed/idempotencyStore");
const { ConsistentHashRing } = require("./distributed/consistentHashRing");
const { CircuitBreaker } = require("./resilience/circuitBreaker");
const { UrlShortenerService } = require("./services/urlShortenerService");
const { InventoryService } = require("./services/inventoryService");
const { PaymentService } = require("./services/paymentService");
const { OrderSaga } = require("./workflows/orderSaga");
const { OrderService } = require("./services/orderService");
const { EventBus } = require("./eventing/eventBus");
const { OutboxProcessor } = require("./eventing/outboxProcessor");
const { MetricsRegistry } = require("./observability/metricsRegistry");
const { loadAppConfig } = require("./config/appConfig");
const { createServer } = require("./http/server");
const { logger } = require("./common/logger");

function listenOnPort(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port);
  });
}

async function startServer(server, { preferredPort, maxAttempts }) {
  let port = preferredPort;
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      await listenOnPort(server, port);
      return port;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || i === maxAttempts - 1) {
        throw error;
      }
      logger.warn("Port in use, trying next port", { port });
      port += 1;
    }
  }
  throw new Error("Unable to bind server");
}

async function bootstrap() {
  const config = loadAppConfig();
  const metrics = new MetricsRegistry();
  logger.info("Bootstrapping system design lab", {
    port: config.server.preferredPort,
    maxPortAttempts: config.server.maxPortAttempts,
    paymentFailureRate: config.resilience.paymentFailureRate,
    inventoryFailureRate: config.resilience.inventoryFailureRate,
  });

  const cache = new LruCache({ maxKeys: 20000, defaultTtlMs: 2 * 60 * 1000 });
  const limiter = new TokenBucketLimiter({ capacity: 120, refillPerSecond: 60 });
  const queue = new TaskQueue({ concurrency: 8, pollIntervalMs: 20 });
  const idempotency = new IdempotencyStore({
    inProgressTtlMs: 30000,
    completeTtlMs: 15 * 60 * 1000,
  });
  const ring = new ConsistentHashRing({ virtualNodes: 150 });
  const breaker = new CircuitBreaker({
    failureThreshold: 4,
    recoveryTimeMs: 7000,
    halfOpenMaxCalls: 2,
  });
  const eventBus = new EventBus({ metrics });
  const inventoryService = new InventoryService({
    failureRate: config.resilience.inventoryFailureRate,
    metrics,
  });
  const paymentService = new PaymentService({
    failureRate: config.resilience.paymentFailureRate,
    metrics,
  });
  const orderSaga = new OrderSaga({
    inventoryService,
    paymentService,
    config,
    metrics,
  });
  const orderService = new OrderService({
    saga: orderSaga,
    idempotencyStore: idempotency,
    config,
    metrics,
  });
  const outboxProcessor = new OutboxProcessor({
    orderService,
    eventBus,
    metrics,
    pollMs: config.resilience.outboxPollMs,
    batchSize: config.resilience.outboxBatchSize,
  });

  ring.addNode("redis-shard-a");
  ring.addNode("redis-shard-b");
  ring.addNode("redis-shard-c");

  queue.registerHandler("analytics.click", async (payload) => {
    if (!payload.code) {
      throw new Error("Invalid analytics payload");
    }
    metrics.inc("analytics.click.processed");
  });

  queue.registerHandler("notification.email", async (payload) => {
    if (!payload.to || !payload.subject) {
      throw new Error("Invalid email payload");
    }
    metrics.inc("notification.email.processed");
  });

  eventBus.subscribe("ORDER_CONFIRMED", async (event) => {
    metrics.inc("orders.confirmed.events");
    queue.enqueue({
      type: "notification.email",
      payload: {
        to: `${event.userId}@example.com`,
        subject: `Order ${event.orderId} confirmed`,
      },
      maxAttempts: 4,
      backoffMs: 100,
    });
  });

  eventBus.subscribe("ORDER_FAILED", async () => {
    metrics.inc("orders.failed.events");
  });

  queue.start();
  outboxProcessor.start();

  const shortener = new UrlShortenerService({
    cache,
    idempotencyStore: idempotency,
    analyticsQueue: queue,
    circuitBreaker: breaker,
  });

  const server = createServer({
    services: {
      cache,
      limiter,
      queue,
      idempotency,
      ring,
      breaker,
      shortener,
      orderService,
      paymentService,
      inventoryService,
      eventBus,
      metrics,
    },
  });

  const hasExplicitPort = Boolean(process.env.PORT && process.env.PORT.length > 0);
  const preferredPort = Number(config.server.preferredPort);
  if (!Number.isInteger(preferredPort) || preferredPort <= 0 || preferredPort > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }
  const port = await startServer(server, {
    preferredPort,
    maxAttempts: hasExplicitPort ? 1 : config.server.maxPortAttempts,
  });
  logger.info("Node.js system design lab started", { port, hasExplicitPort });

  const maintenanceTimer = setInterval(() => {
    // In-memory stores need explicit housekeeping in this teaching lab; real deployments would
    // delegate most of this to Redis/Postgres TTLs, background jobs, or managed infrastructure.
    cache.sweepExpired();
    idempotency.sweep();
    limiter.sweepInactive();
    metrics.setGauge("orders.total", orderService.stats().totalOrders);
  }, 10_000).unref();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      logger.warn("Shutdown already in progress", { signal });
      return;
    }
    shuttingDown = true;
    logger.info("Graceful shutdown started", { signal });
    clearInterval(maintenanceTimer);
    // Stop producers before closing HTTP so no new background work is scheduled during shutdown.
    queue.stop();
    outboxProcessor.stop();

    await new Promise((resolve) => {
      server.close((error) => {
        if (error) {
          logger.error("HTTP server close failed", { error });
        }
        resolve();
      });
    });

    logger.info("Graceful shutdown completed");
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM").finally(() => process.exit(0));
  });
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { error: reason instanceof Error ? reason : new Error(String(reason)) });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
  process.exitCode = 1;
});

bootstrap().catch((error) => {
  logger.error("Failed to start server", {
    error,
    code: error.code || "STARTUP_ERROR",
  });
  process.exitCode = 1;
});
