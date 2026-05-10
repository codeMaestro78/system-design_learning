# Node.js System Design Lab

A production-style learning codebase with reusable system design building blocks:

- **LRU cache with TTL + metrics**
- **Token bucket rate limiter**
- **Task queue with retries, exponential backoff, DLQ**
- **Circuit breaker**
- **Idempotency store**
- **Consistent hashing ring**
- **HTTP server that composes these into practical APIs**
- **Order saga orchestration (inventory + payment + compensation)**
- **Transactional outbox processor + event bus**
- **Custom metrics registry for domain and infra metrics**

## Structure
```text
src/
  cache/lruCache.js
  ratelimiter/tokenBucketLimiter.js
  queue/taskQueue.js
  resilience/circuitBreaker.js
  resilience/retry.js
  distributed/consistentHashRing.js
  distributed/idempotencyStore.js
  config/appConfig.js
  observability/metricsRegistry.js
  eventing/eventBus.js
  eventing/outboxProcessor.js
  workflows/orderSaga.js
  services/inventoryService.js
  services/paymentService.js
  services/orderService.js
  services/urlShortenerService.js
  http/server.js
  index.js
  demo.js
```

## Architecture Graph (high-level)
```text
HTTP Server
  ├─ URL Shortener Service
  │    ├─ LRU Cache
  │    ├─ Idempotency Store
  │    ├─ Circuit Breaker
  │    └─ Task Queue (analytics events)
  └─ Order Service
       ├─ Order Saga
       │    ├─ Inventory Service (bulkhead)
       │    └─ Payment Service (bulkhead)
       └─ Transactional Outbox -> Outbox Processor -> Event Bus -> Task Queue (email)
```

## Run
```bash
npm start
```

By default the server starts on **port 3100**. If 3100 is in use, it automatically tries the next ports.

## Demo (in another terminal after server starts)
```bash
npm run demo
```

If you set a custom server port, run demo with the same port:
```bash
PORT=3200 npm run demo
```

## API Endpoints
- `GET /health`
- `GET /metrics`
- `POST /shorten` body: `{ longUrl, requestId, userId, ttlMs? }`
- `GET /r/:code` redirects
- `POST /tasks/email` body: `{ to, subject }`
- `POST /orders` body: `{ idempotencyKey, userId, paymentMethod, items:[{sku,qty,price}] }`
- `GET /orders/:id`
- `GET /events/dead-letter`
- `GET /placement?key=...` (consistent hash placement)

## Why this is useful for system design
This lab demonstrates practical patterns that appear in real systems:

1. **Hot path acceleration** (cache)
2. **Overload protection** (rate limit + queue)
3. **Dependency failure containment** (circuit breaker)
4. **Retry-safe writes** (idempotency)
5. **Shard routing strategy** (consistent hashing)

## Suggested Extensions
1. Replace in-memory storage with Redis/Postgres.
2. Add distributed tracing with OpenTelemetry.
3. Add persistent queue backend.
4. Add write-ahead event log and replay.
5. Add optimistic locking + versioned order updates.

## Sophisticated Learning Path

Use this lab as the implementation side of the roadmap.

### Component-to-concept mapping
- `cache/lruCache.js`: cache-aside, TTL, eviction, hit rate.
- `ratelimiter/tokenBucketLimiter.js`: overload protection and abuse control.
- `queue/taskQueue.js`: retries, backoff, DLQ, async work.
- `distributed/idempotencyStore.js`: retry-safe writes.
- `distributed/consistentHashRing.js`: shard placement and rebalancing.
- `resilience/circuitBreaker.js`: dependency failure containment.
- `workflows/orderSaga.js`: distributed workflow compensation.
- `eventing/outboxProcessor.js`: reliable event publication.
- `observability/metricsRegistry.js`: operational visibility.

### Production upgrade roadmap
1. Replace in-memory stores with Redis/Postgres.
2. Add OpenTelemetry traces and request IDs.
3. Add persistent queue storage.
4. Add integration tests around HTTP endpoints.
5. Add load tests for `/shorten`, `/r/:code`, and `/orders`.
6. Add chaos tests for payment/inventory failures.
7. Add dashboards and alert thresholds.

### Real-world comparison
- URL shortener path maps to Bitly-style redirect architecture.
- Order saga maps to e-commerce checkout orchestration.
- Outbox/event bus maps to production event-driven systems.
- Consistent hash ring maps to cache shard routing.

### Current verification
```bash
npm test
```

The test suite validates the most important corrected behaviors: cache semantics, rate limiter validation, idempotent URL creation, expired link handling, and order payload validation.

## Rigorous Engineering Roadmap

### Target architecture
```text
HTTP Server
  -> Request ID + structured logs
  -> Rate Limiter
  -> URL Shortener Service
      -> Cache
      -> Idempotency Store
      -> Analytics Queue
  -> Order Service
      -> Idempotency Store
      -> Saga
      -> Outbox
  -> Queue Workers
  -> Metrics Endpoint
```

### Next robustness upgrades
- Add repository interfaces for Postgres/Redis replacements.
- Add integration tests for all HTTP endpoints.
- Add OpenTelemetry trace propagation.
- Add Prometheus text-format metrics.
- Add Docker Compose for app, Redis, Postgres, and observability.
- Add load tests for hot redirects and order creation.
- Add runbooks for queue lag, payment failure, and cache outage.

### Code quality bar
- Public endpoint has validation tests.
- Unsafe write has idempotency tests.
- Background task has retry and DLQ tests.
- Log line has request or operation identity.
- Error response has stable code.
- Service has metrics for success, failure, and latency.
