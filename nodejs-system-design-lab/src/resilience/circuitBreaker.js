class CircuitBreaker {
  constructor({
    failureThreshold = 5,
    recoveryTimeMs = 10000,
    halfOpenMaxCalls = 2,
  } = {}) {
    this.failureThreshold = failureThreshold;
    this.recoveryTimeMs = recoveryTimeMs;
    this.halfOpenMaxCalls = halfOpenMaxCalls;

    this.state = "CLOSED";
    this.failureCount = 0;
    this.nextAttemptTs = 0;
    this.halfOpenCalls = 0;
    this.metrics = {
      openTransitions: 0,
      successfulCalls: 0,
      failedCalls: 0,
      rejectedCalls: 0,
    };
  }

  _now() {
    return Date.now();
  }

  _transitionToOpen() {
    this.state = "OPEN";
    this.nextAttemptTs = this._now() + this.recoveryTimeMs;
    this.halfOpenCalls = 0;
    this.metrics.openTransitions += 1;
  }

  _transitionToHalfOpen() {
    this.state = "HALF_OPEN";
    this.halfOpenCalls = 0;
  }

  _transitionToClosed() {
    this.state = "CLOSED";
    this.failureCount = 0;
    this.halfOpenCalls = 0;
  }

  _canExecute() {
    if (this.state === "CLOSED") {
      return true;
    }
    if (this.state === "OPEN") {
      if (this._now() >= this.nextAttemptTs) {
        this._transitionToHalfOpen();
        return true;
      }
      return false;
    }
    return this.halfOpenCalls < this.halfOpenMaxCalls;
  }

  async execute(fn) {
    if (!this._canExecute()) {
      this.metrics.rejectedCalls += 1;
      const error = new Error("Circuit breaker is OPEN");
      error.code = "CIRCUIT_OPEN";
      throw error;
    }

    if (this.state === "HALF_OPEN") {
      this.halfOpenCalls += 1;
    }

    try {
      const result = await fn();
      this.metrics.successfulCalls += 1;

      if (this.state === "HALF_OPEN" && this.halfOpenCalls >= this.halfOpenMaxCalls) {
        this._transitionToClosed();
      } else if (this.state === "CLOSED") {
        this.failureCount = 0;
      }
      return result;
    } catch (error) {
      this.metrics.failedCalls += 1;
      this.failureCount += 1;
      if (this.state === "HALF_OPEN" || this.failureCount >= this.failureThreshold) {
        this._transitionToOpen();
      }
      throw error;
    }
  }

  snapshot() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      nextAttemptTs: this.nextAttemptTs,
      ...this.metrics,
    };
  }
}

module.exports = { CircuitBreaker };
