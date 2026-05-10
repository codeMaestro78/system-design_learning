const test = require("node:test");
const assert = require("node:assert/strict");
const { TokenBucketLimiter } = require("./tokenBucketLimiter");

test("TokenBucketLimiter validates constructor values and request cost", () => {
  assert.throws(() => new TokenBucketLimiter({ capacity: 0 }), /capacity/);
  assert.throws(() => new TokenBucketLimiter({ refillPerSecond: 0 }), /refillPerSecond/);

  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });
  assert.throws(() => limiter.allow("client", 0), /cost/);
});

test("TokenBucketLimiter denies when bucket is empty", () => {
  const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1 });

  assert.equal(limiter.allow("client").allowed, true);
  const denied = limiter.allow("client");

  assert.equal(denied.allowed, false);
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterMs > 0);
});
