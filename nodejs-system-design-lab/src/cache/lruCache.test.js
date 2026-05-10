const test = require("node:test");
const assert = require("node:assert/strict");
const { LruCache } = require("./lruCache");

test("LruCache stores null values and has() does not count as a miss", () => {
  const cache = new LruCache({ maxKeys: 2, defaultTtlMs: 1000 });

  cache.set("nullable", null);

  assert.equal(cache.has("nullable"), true);
  assert.equal(cache.get("nullable"), null);
  assert.equal(cache.stats().hits, 1);
  assert.equal(cache.stats().misses, 0);
});

test("LruCache evicts least recently used key", () => {
  const cache = new LruCache({ maxKeys: 2, defaultTtlMs: 1000 });

  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1);
  cache.set("c", 3);

  assert.equal(cache.has("a"), true);
  assert.equal(cache.has("b"), false);
  assert.equal(cache.has("c"), true);
});
