const test = require("node:test");
const assert = require("node:assert/strict");
const { formatLog } = require("./logger");

test("formatLog serializes error context safely", () => {
  const error = new Error("boom");
  error.code = "TEST_ERROR";

  const parsed = JSON.parse(formatLog("ERROR", "failed", { error, requestId: "req-1" }));

  assert.equal(parsed.level, "ERROR");
  assert.equal(parsed.service, "nodejs-system-design-lab");
  assert.equal(parsed.message, "failed");
  assert.equal(parsed.requestId, "req-1");
  assert.equal(parsed.error.message, "boom");
  assert.equal(parsed.error.code, "TEST_ERROR");
});
