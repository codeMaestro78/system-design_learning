const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createServer } = require("./server");
const { MetricsRegistry } = require("../observability/metricsRegistry");
const { TokenBucketLimiter } = require("../ratelimiter/tokenBucketLimiter");

function request(port, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        method,
        path,
        headers,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: raw ? JSON.parse(raw) : null,
          });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

async function withServer(fn) {
  const metrics = new MetricsRegistry();
  const server = createServer({
    services: {
      limiter: new TokenBucketLimiter({ capacity: 100, refillPerSecond: 100 }),
      shortener: {},
      queue: { stats: () => ({ pending: 0 }) },
      cache: { stats: () => ({}) },
      idempotency: { stats: () => ({}) },
      ring: { snapshot: () => ({}), getNode: () => "node-a", getReplicas: () => ["node-a"] },
      breaker: { snapshot: () => ({}) },
      orderService: { stats: () => ({}), getOrder: () => null },
      paymentService: { stats: () => ({}) },
      inventoryService: { stats: () => ({}) },
      eventBus: { stats: () => ({}), deadLetter: [] },
      metrics,
    },
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  try {
    await fn(port, metrics);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("HTTP server echoes a bounded request id", async () => {
  await withServer(async (port) => {
    const res = await request(port, {
      path: "/health",
      headers: { "x-request-id": "req-test-1" },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-request-id"], "req-test-1");
    assert.equal(res.body.requestId, "req-test-1");
  });
});

test("HTTP server rejects unsupported JSON content type", async () => {
  await withServer(async (port) => {
    const res = await request(port, {
      method: "POST",
      path: "/shorten",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });

    assert.equal(res.statusCode, 415);
    assert.equal(res.body.error, "unsupported_media_type");
    assert.ok(res.body.requestId);
  });
});
