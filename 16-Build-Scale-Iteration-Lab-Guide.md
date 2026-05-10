# Build + Scale Iterations Guide (Node.js Lab)

Use this with: `nodejs-system-design-lab/`

## Goal
Practice real engineering loop: **measure -> break -> fix -> explain**.

---

## Iteration Framework

1. Define hypothesis (what bottleneck/failure you expect)
2. Measure baseline
3. Apply stress/failure
4. Observe metrics/logs
5. Implement fix
6. Re-measure
7. Document tradeoff introduced

---

## Iteration 1: Throughput bottleneck

## Target
`POST /shorten` and `POST /orders` under concurrent load.

## Steps
1. Generate load (k6/autocannon/curl loops).
2. Capture:
   - success rate
   - p50/p95 latency
   - queue pending size
3. Increase concurrency until degradation.

## Possible fixes
- Raise queue concurrency carefully.
- Reduce expensive synchronous work in hot path.
- Improve caching strategy.

---

## Iteration 2: Dependency failure injection

## Target
Payment/inventory failure resilience in order saga.

## Steps
1. Increase `PAYMENT_FAILURE_RATE` and `INVENTORY_FAILURE_RATE`.
2. Send order traffic.
3. Confirm compensation path runs correctly.
4. Check outbox and dead-letter behavior.

## Expected learning
- Timeouts + compensation + idempotency correctness
- Difference between graceful degradation and silent corruption

---

## Iteration 3: Portability and startup robustness

## Target
Startup behavior with port collisions and environment config.

## Steps
1. Occupy preferred port.
2. Start service with/without explicit `PORT`.
3. Validate fallback behavior.

---

## Iteration 4: Event pipeline reliability

## Target
Outbox processor and event bus behavior under handler failures.

## Steps
1. Add failing event subscriber.
2. Create orders.
3. Track:
   - outbox retries
   - dead letter growth
4. Add fix (retry/backoff/handler hardening).

---

## Iteration 5: Rate limiting fairness

## Target
Per-client protection without overblocking.

## Steps
1. Simulate multiple client IDs.
2. Validate one noisy client does not starve others.
3. Tune token bucket values.

---

## What to Record for Every Iteration
1. Baseline metrics
2. Stress condition
3. Failure mode observed
4. Fix implemented
5. New metrics
6. Tradeoff accepted

---

## Production-style report template
```text
Objective:
Baseline:
Stress/failure method:
Observed bottleneck:
Fix:
Result:
Tradeoff:
Next iteration:
```

---

## Interview Leverage
After each iteration, prepare a 2-minute story:
1. What broke
2. Why it broke
3. What fix you chose
4. What tradeoff it introduced
5. How you validated improvement

## Sophisticated Lab Iterations

### Iteration: idempotency under retries
Target: `POST /shorten` and `POST /orders`.

Steps:
1. Send the same idempotency key repeatedly.
2. Simulate client timeout and retry.
3. Confirm only one logical side effect occurs.
4. Verify returned response is stable.

Expected learning:
- Retry-safe APIs are designed intentionally.
- Idempotency stores need TTL and status semantics.

### Iteration: queue backpressure
Target: task queue and outbox processor.

Steps:
1. Slow down a handler.
2. Increase producer traffic.
3. Watch queue pending count and retry behavior.
4. Tune concurrency, backoff, and DLQ policy.

Expected learning:
- Queues absorb bursts but do not create infinite capacity.
- Retry storms must be controlled.

### Iteration: production review
For every endpoint, document:
- SLO.
- Input validation.
- Failure behavior.
- Metrics.
- Security concern.
- Scaling limit.

## Rigorous Lab Acceptance Criteria

### Required experiment report
```text
Endpoint/component:
Hypothesis:
Baseline traffic:
Failure injected:
Observed metric:
Root cause:
Fix:
Before/after:
Remaining risk:
```

### Required lab scenarios
- Hot URL redirect.
- Duplicate order creation.
- Payment dependency timeout.
- Queue handler poison message.
- Cache miss storm.
- Rate limiter burst.
- Outbox publish failure.
