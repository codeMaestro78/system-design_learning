/**
 * File Relationship Map
 * - Used by: src/services/orderService.js
 * - Purpose: deterministic timeout wrapper for async dependencies
 */

async function withTimeout(promiseFactory, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      const error = new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`);
      error.code = "TIMEOUT";
      reject(error);
    }, timeoutMs);

    Promise.resolve()
      .then(() => promiseFactory())
      .then((result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}

module.exports = { withTimeout };
