async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff(
  fn,
  {
    maxAttempts = 3,
    baseDelayMs = 50,
    maxDelayMs = 2000,
    jitter = 0.2,
    shouldRetry = () => true,
  } = {}
) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error, attempt)) {
        throw error;
      }
      const expo = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const noise = expo * jitter * Math.random();
      await sleep(Math.floor(expo + noise));
    }
  }
  throw new Error("retryWithBackoff exhausted unexpectedly");
}

module.exports = { retryWithBackoff };
