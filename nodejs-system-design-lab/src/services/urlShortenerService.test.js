const test = require("node:test");
const assert = require("node:assert/strict");
const { LruCache } = require("../cache/lruCache");
const { IdempotencyStore } = require("../distributed/idempotencyStore");
const { CircuitBreaker } = require("../resilience/circuitBreaker");
const { UrlShortenerService } = require("./urlShortenerService");

function createService() {
  const enqueued = [];
  return {
    enqueued,
    service: new UrlShortenerService({
      cache: new LruCache({ maxKeys: 100, defaultTtlMs: 1000 }),
      idempotencyStore: new IdempotencyStore(),
      analyticsQueue: {
        enqueue(task) {
          enqueued.push(task);
          return "task-1";
        },
      },
      circuitBreaker: new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 50 }),
    }),
  };
}

test("UrlShortenerService rejects invalid TTL values", async () => {
  const { service } = createService();

  await assert.rejects(
    service.createShortUrl({ longUrl: "https://example.com", ttlMs: 0 }),
    /ttlMs must be a positive number/
  );
});

test("UrlShortenerService does not reuse expired long URL mapping", async () => {
  const { service } = createService();

  const first = await service.createShortUrl({
    longUrl: "https://example.com/a",
    requestId: "first",
    userId: "u1",
    ttlMs: 1,
  });
  first.expiresAt = Date.now() - 1;

  const second = await service.createShortUrl({
    longUrl: "https://example.com/a",
    requestId: "second",
    userId: "u1",
    ttlMs: 1000,
  });

  assert.notEqual(second.code, first.code);
  await assert.rejects(service.resolve(first.code), /Short URL not found/);
  assert.equal(await service.resolve(second.code), "https://example.com/a");
});

test("UrlShortenerService returns idempotent response for duplicate requestId", async () => {
  const { service } = createService();

  const first = await service.createShortUrl({
    longUrl: "https://example.com/idempotent",
    requestId: "same-request",
    userId: "u1",
  });
  const second = await service.createShortUrl({
    longUrl: "https://example.com/idempotent",
    requestId: "same-request",
    userId: "u1",
  });

  assert.deepEqual(second, first);
});
