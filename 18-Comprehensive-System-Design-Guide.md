# Complete System Design Guide with Implementation Notes

This file consolidates the curriculum in this folder into one practical design document. Use the smaller files for focused study, and use this file when you want one end-to-end reference for designing, building, reviewing, and explaining systems.

## 1. System Design Operating Model

System design is not drawing boxes first. It is a sequence of decisions under constraints.

Use this flow for every design:

1. Clarify requirements.
2. Define non-functional requirements.
3. Estimate scale.
4. Define APIs and data model.
5. Draw the baseline architecture.
6. Walk critical flows.
7. Identify bottlenecks.
8. Add resilience and observability.
9. Explain tradeoffs.
10. Define evolution plan.

Strong design answers are explicit about what they optimize for and what they intentionally do not solve in the first version.

## 2. Requirement Clarification

Functional requirements describe what the system does:

- Create, read, update, delete core entities.
- Authentication and authorization.
- Search, filtering, ranking, notifications, analytics, admin flows.
- Bulk operations, import/export, moderation, payments, compliance flows.

Non-functional requirements describe how well it must work:

- Latency: p50, p95, p99 targets.
- Availability: 99.9%, 99.99%, or higher.
- Durability: acceptable data loss window.
- Consistency: strong, read-your-writes, eventual, monotonic reads.
- Scale: QPS, concurrent users, storage growth, bandwidth.
- Security: abuse prevention, privacy, encryption, auditability.
- Operability: deployability, rollback, monitoring, incident response.

Do not overbuild before clarifying which requirements matter. A payment ledger and a social feed have different correctness needs.

## 3. Capacity Estimation

Use rough math to force architecture decisions.

```text
daily_requests = dau * requests_per_user_per_day
average_qps = daily_requests / 86400
peak_qps = average_qps * peak_factor
daily_storage = writes_per_day * average_record_size
bandwidth_per_second = qps * average_payload_size
```

Example:

```text
10M DAU
50 reads/user/day = 500M reads/day
average read QPS = 500M / 86400 ~= 5,800
peak factor 5x => 29,000 peak read QPS
```

Capacity estimates do not need perfect precision. They need to reveal which path dominates: reads, writes, storage, fanout, bandwidth, or compute.

## 4. Networking Basics

A typical request path:

```text
Client
  -> DNS
  -> TCP/TLS or QUIC handshake
  -> CDN or edge load balancer
  -> API gateway
  -> service
  -> cache/database/queue/downstream
```

Important concepts:

- DNS TTL controls agility versus resolver traffic.
- TCP gives ordered reliable streams but has connection overhead.
- HTTP/2 multiplexes requests over fewer connections.
- HTTP/3 over QUIC reduces some head-of-line blocking and improves mobile network behavior.
- Load balancers distribute traffic and perform health checks.
- CDNs move static and cacheable content closer to users.

Latency accumulates across hops. A good design states where the budget is spent and where tail latency can appear.

## 5. Storage and Data Modeling

Pick storage from access patterns, not popularity.

Use SQL when:

- Relationships and transactions matter.
- Query flexibility matters.
- Data correctness is more important than extreme horizontal write scale.

Use key-value or document stores when:

- Access is mostly by primary key.
- Horizontal scale and predictable latency matter.
- Joins are not central to the workload.

Use wide-column or log-structured stores when:

- Write volume is high.
- Query patterns are known.
- Data can be partitioned by key and time.

Use search engines when:

- Full-text search, ranking, filtering, or faceting is needed.

Use object storage when:

- Large immutable blobs dominate: images, videos, backups, logs.

### Data Model Checklist

- Primary entity IDs.
- Query patterns and indexes.
- Partition key and sort key.
- Retention and deletion policy.
- Schema evolution.
- Migration plan.
- Backup and restore plan.

### Consistency Choices

- Strong consistency: higher correctness, often higher latency and lower availability under partitions.
- Eventual consistency: better availability and scale, but clients must tolerate lag.
- Read-your-writes: useful for user-facing UX after writes.
- Monotonic reads: users should not see time move backward.

## 6. Core Components

### Cache

Caching reduces repeated expensive work.

Common patterns:

- Cache-aside: service reads cache, falls back to DB, then fills cache.
- Write-through: write DB and cache synchronously.
- Write-back: write cache first, persist later. Fast but riskier.
- Write-around: write DB only, let future reads populate cache.

Cache-aside flow:

```text
value = cache.get(key)
if value exists:
  return value
value = db.get(key)
cache.set(key, value, ttl)
return value
```

Production concerns:

- TTL and invalidation.
- Hot keys.
- Cache stampede.
- Negative caching.
- Eviction policy.
- Stale reads.

Implementation in this repo: `nodejs-system-design-lab/src/cache/lruCache.js`

Key code idea:

```js
set(key, value, ttlMs = this.defaultTtlMs) {
  if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
    throw new Error("ttlMs must be null or a positive number");
  }
  const expiresAt = ttlMs === null ? null : this._now() + ttlMs;
  const entry = { value, expiresAt };
  this.store.set(key, entry);
  this._touch(key, entry);
  this.metrics.writes += 1;
  this._evictIfNeeded();
}
```

### Load Balancer

Responsibilities:

- Spread traffic across healthy instances.
- Remove unhealthy instances.
- Support connection draining during deploys.
- Route based on path, host, region, or tenant.

Algorithms:

- Round-robin.
- Least connections.
- Weighted routing.
- Consistent hashing for sticky placement.

### Rate Limiter

Protects services from overload and abuse.

Common algorithms:

- Fixed window: simple but bursty at boundaries.
- Sliding window: smoother but more state.
- Token bucket: allows controlled bursts.
- Leaky bucket: smooths output rate.

Implementation in this repo: `nodejs-system-design-lab/src/ratelimiter/tokenBucketLimiter.js`

Core behavior:

```js
allow(key, cost = 1) {
  if (!Number.isFinite(cost) || cost <= 0) {
    throw new Error("cost must be a positive number");
  }
  const bucket = this._getBucket(key);
  if (bucket.tokens >= cost) {
    bucket.tokens -= cost;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
  }
  const missing = cost - bucket.tokens;
  return {
    allowed: false,
    remaining: Math.floor(bucket.tokens),
    retryAfterMs: Math.ceil((missing / this.refillPerSecond) * 1000),
  };
}
```

### Queue

Queues decouple producers from consumers.

Use queues for:

- Background work.
- Retries and delayed jobs.
- Fanout.
- Smoothing traffic bursts.
- Async analytics and notifications.

Production queue requirements:

- Ack/nack protocol.
- Visibility timeout or leases.
- Retry with exponential backoff.
- Dead-letter queue.
- Idempotent consumers.
- Lag metrics and replay tools.

Implementation in this repo: `nodejs-system-design-lab/src/queue/taskQueue.js`

Key behavior:

```js
_scheduleRetry(task, error) {
  task.attempts += 1;
  if (task.attempts >= task.maxAttempts) {
    this.deadLetter.push({ ...task, error: { message: error.message } });
    this.metrics.deadLettered += 1;
    return;
  }
  const delay = Math.min(10000, task.backoffMs * 2 ** (task.attempts - 1));
  task.visibleAt = Date.now() + delay;
  this.pending.push(task);
  this.metrics.retried += 1;
}
```

### Circuit Breaker

Prevents a failing dependency from consuming all service resources.

States:

- Closed: calls pass through.
- Open: calls fail fast.
- Half-open: limited probe calls decide recovery.

Implementation in this repo: `nodejs-system-design-lab/src/resilience/circuitBreaker.js`

Use circuit breakers with timeouts, bounded queues, and clear fallback behavior.

### Idempotency

Idempotency makes retry-safe writes possible.

Pattern:

```text
begin(idempotency_key)
if completed:
  return stored_response
if in_progress:
  reject_or_wait
perform_side_effect
store_response
```

Implementation in this repo: `nodejs-system-design-lab/src/distributed/idempotencyStore.js`

Idempotency is mandatory for payments, order creation, notification sends, task execution, and APIs that clients may retry.

## 7. Architecture Patterns

### Modular Monolith

Best default for early systems:

- One deployable.
- Clear module boundaries.
- Shared database initially.
- Lower operational overhead.

Evolve to services when team boundaries, scale, or domain complexity justify it.

### Microservices

Benefits:

- Independent deployability.
- Independent scaling.
- Ownership by domain.

Costs:

- Network failures.
- Distributed transactions.
- Observability complexity.
- Schema and API compatibility.
- Higher operational burden.

### Event-Driven Architecture

Services publish facts:

```text
OrderService -> ORDER_CONFIRMED event -> Email, Analytics, Fulfillment
```

Benefits:

- Loose coupling.
- Async scaling.
- Replay and audit.

Risks:

- Eventual consistency.
- Harder debugging.
- Schema evolution.
- Duplicate events.

Rules:

- Make consumers idempotent.
- Include correlation IDs.
- Version event schemas.
- Track dead-letter events.

### Saga Pattern

Use a saga for multi-step workflows where distributed transactions are not practical.

Example order flow:

```text
Create order
  -> reserve inventory
  -> charge payment
  -> confirm order
  -> publish outbox event
```

If payment fails after inventory reservation, release inventory as compensation.

Implementation in this repo:

- `nodejs-system-design-lab/src/workflows/orderSaga.js`
- `nodejs-system-design-lab/src/services/orderService.js`
- `nodejs-system-design-lab/src/services/inventoryService.js`
- `nodejs-system-design-lab/src/services/paymentService.js`

## 8. Scaling Strategy

Scale only after identifying the bottleneck.

Common bottlenecks:

- CPU saturation.
- Memory pressure.
- Database write IOPS.
- Slow queries.
- Lock contention.
- Queue lag.
- Hot partitions.
- Network egress.
- Downstream dependency latency.

Scaling moves:

- Add stateless service replicas.
- Add cache.
- Add read replicas.
- Shard by stable key.
- Partition streams.
- Move heavy work async.
- Use CDN or edge caching.
- Split hot and cold data.
- Precompute expensive reads.

### Hotspot Handling

Hotspots happen when traffic concentrates on one key, shard, user, celebrity, post, video, or link.

Mitigations:

- Cache hot keys.
- Request coalescing.
- Key salting.
- Read replicas.
- Adaptive partition splitting.
- Fanout-on-read for extreme celebrity cases.

## 9. Reliability and Failure Handling

Every design needs a failure story.

Checklist:

- What if database is slow?
- What if cache is down?
- What if queue is backed up?
- What if a dependency times out?
- What if a region fails?
- What if retry traffic amplifies the outage?
- What data can be stale?
- What data can never be lost?

Core patterns:

- Timeouts on every network call.
- Retries with exponential backoff and jitter.
- Idempotency keys on retryable writes.
- Circuit breakers around unstable dependencies.
- Bulkheads to isolate resource pools.
- Dead-letter queues for poisoned messages.
- Graceful degradation for non-critical features.
- Backpressure when consumers cannot keep up.

Timeout helper in this repo: `nodejs-system-design-lab/src/resilience/timeout.js`

```js
async function withTimeout(promiseFactory, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const error = new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`);
      error.code = "TIMEOUT";
      reject(error);
    }, timeoutMs);

    Promise.resolve()
      .then(() => promiseFactory())
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
  });
}
```

## 10. Observability

You cannot operate what you cannot see.

Use the three pillars:

- Logs: structured event details.
- Metrics: trends, counters, gauges, histograms.
- Traces: request path across services.

Minimum metrics:

- Request rate.
- Error rate.
- Duration by endpoint.
- Queue pending and age.
- Cache hit rate.
- Dependency latency and failure rate.
- Saturation: CPU, memory, connections, thread pools.

Alert on user impact and SLO burn rate, not only raw CPU.

Implementation in this repo: `nodejs-system-design-lab/src/observability/metricsRegistry.js`

## 11. Security and Abuse

Security is part of design, not an afterthought.

Checklist:

- Authentication and authorization.
- Input validation.
- Rate limits by user, IP, tenant, route.
- Audit logs for sensitive actions.
- Encryption in transit and at rest.
- Secret management.
- PII classification and retention.
- Abuse detection and blocklists.
- SSRF and unsafe redirect prevention.
- Least privilege for services.

For a URL shortener specifically:

- Validate `http` and `https` only.
- Block internal/private IP destinations after DNS resolution in production.
- Scan or reputation-check suspicious domains.
- Throttle link creation.
- Keep redirect path fast even if analytics is degraded.

## 12. Complete Example: URL Shortener with Analytics

### Requirements

- Create short URL.
- Resolve short code and redirect.
- Optional expiration.
- Idempotent create API.
- Async click analytics.
- High read availability and low redirect latency.

### Non-Functional Requirements

- Redirect p95 under 50 ms from service edge when cache is warm.
- Very high read QPS compared with write QPS.
- Eventual consistency is acceptable for analytics.
- Link creation should be retry-safe.
- Abuse controls required.

### APIs

```text
POST /shorten
body: { "longUrl": "...", "requestId": "...", "userId": "...", "ttlMs": 86400000 }

GET /r/{code}

GET /metrics
```

### Data Model

```sql
links(
  code text primary key,
  long_url text not null,
  owner_id text not null,
  created_at timestamp not null,
  expires_at timestamp null,
  is_active boolean not null
)

click_events(
  id text primary key,
  code text not null,
  ts timestamp not null,
  user_agent_hash text,
  ip_hash text,
  referrer text
)
```

### Architecture

```text
Client
  -> HTTP API
    -> Rate Limiter
    -> URL Shortener Service
      -> LRU/Redis Cache
      -> Link Store
      -> Idempotency Store
      -> Analytics Queue
        -> Workers
        -> Analytics Store
```

### Critical Flow: Create

1. Validate URL and TTL.
2. Build idempotency key from user and request ID.
3. Return stored response if request was already completed.
4. Check if the long URL already has a non-expired code.
5. Generate random Base62 code.
6. Retry on code collision.
7. Store link record.
8. Cache link.
9. Complete idempotency record.

Implementation in this repo: `nodejs-system-design-lab/src/services/urlShortenerService.js`

Important corrected behavior:

```js
if (existing.expiresAt !== null && existing.expiresAt <= Date.now()) {
  this.linksByCode.delete(existingCode);
  this.codeByLongUrl.delete(longUrl);
  this.cache.delete(`code:${existingCode}`);
} else {
  if (idempotencyKey) {
    this.idempotencyStore.complete(idempotencyKey, existing);
  }
  return existing;
}
```

This prevents an expired long URL mapping from being reused.

### Critical Flow: Redirect

1. Parse short code.
2. Read from cache.
3. On miss, read from link store.
4. Reject missing or expired links.
5. Increment click count or emit click event.
6. Redirect to long URL.
7. Do not block redirect on analytics if product requirements allow best-effort analytics.

### Bottlenecks

- Popular links becoming hot keys.
- Analytics queue lag during traffic spikes.
- Database lookups for misses.
- Abuse and bot traffic.

### Scaling

- Put redirect service behind CDN/edge.
- Cache code-to-URL mapping.
- Use Bloom filter or negative cache for nonexistent codes.
- Partition analytics by time and code.
- Batch analytics writes.
- Use separate write path for link creation and read path for redirect.

### Failure Handling

- Cache down: fall back to DB with rate-limited miss traffic.
- DB down: serve cached redirects only if acceptable.
- Analytics down: buffer to queue, degrade analytics, preserve redirect path.
- Duplicate create request: idempotency store returns same response.
- Code collision: retry with new code.

## 13. Complete Example: Order Service with Saga and Outbox

### Requirements

- Create order.
- Reserve inventory.
- Charge payment.
- Confirm or fail order.
- Publish domain events.
- Send confirmation notification.
- Make create order retry-safe.

### Architecture

```text
Client
  -> HTTP API
    -> Order Service
      -> Idempotency Store
      -> Order Store
      -> Order Saga
        -> Inventory Service
        -> Payment Service
      -> Transactional Outbox
        -> Outbox Processor
        -> Event Bus
        -> Notification Queue
```

### Why Saga

Inventory and payment are separate side effects. A single local database transaction cannot safely cover both. The saga makes each step explicit and defines compensation.

### Critical Flow

1. Validate order items.
2. Require idempotency key.
3. Create local pending order.
4. Reserve inventory with timeout.
5. Charge payment with timeout.
6. If both succeed, confirm order and append `ORDER_CONFIRMED`.
7. If a later step fails, compensate completed earlier steps.
8. Store idempotent response.
9. Outbox processor publishes events asynchronously.

### Correctness Rules

- Order creation must reject invalid item quantities and unsafe totals.
- Payment amount must be positive.
- Compensation must be idempotent.
- Event publishing must be retryable.
- Consumers must tolerate duplicate events.

Implementation in this repo:

- `nodejs-system-design-lab/src/services/orderService.js`
- `nodejs-system-design-lab/src/workflows/orderSaga.js`
- `nodejs-system-design-lab/src/eventing/outboxProcessor.js`
- `nodejs-system-design-lab/src/eventing/eventBus.js`

## 14. Real-World Design Templates

### Twitter/X

Hard problem: timeline fanout under skew.

Architecture:

```text
Tweet API -> Tweet Store -> Event Bus -> Fanout Workers -> Timeline Store
Timeline API -> Timeline Cache -> Timeline Store -> Ranking
```

Key choice: hybrid fanout.

- Normal users: fanout-on-write.
- Celebrity users: fanout-on-read.

### Instagram

Hard problem: media pipeline plus ranking.

Architecture:

```text
Upload API -> Object Store -> Processing Queue -> Transcode/Thumbnail Workers -> CDN
Feed API -> Ranking -> Feed Cache -> Metadata Store
```

Key choice: store media in object storage, metadata in DB, delivery through CDN.

### WhatsApp

Hard problem: realtime connection management and delivery guarantees.

Architecture:

```text
Client <-> WebSocket Gateway -> Chat Service -> Message Store
                                -> Presence Store
                                -> Push Notification Service
```

Key choice: sequence numbers per conversation and idempotent message IDs.

### YouTube

Hard problem: video ingest, transcoding, and CDN delivery.

Architecture:

```text
Upload -> Ingest -> Queue -> Transcode Workers -> Object Store -> CDN -> Player
```

Key choice: async processing and adaptive bitrate manifests.

### Uber

Hard problem: geospatial matching under low latency.

Architecture:

```text
Driver Location Stream -> Geo Index
Rider Request -> Matching Service -> Dispatch -> Trip Service
```

Key choice: partition by geohash/S2 cells and maintain fresh driver state.

### Netflix

Hard problem: global playback quality and personalization.

Architecture:

```text
Catalog API -> Metadata Store
Playback API -> Entitlement -> Manifest -> CDN
Events -> Stream Processing -> Recommendations
```

Key choice: push video near users and keep playback path resilient.

### Distributed Cache

Hard problem: consistency, eviction, and shard movement.

Architecture:

```text
Client -> Cache Client/Ring -> Cache Shards -> Optional Backing Store
```

Key choice: consistent hashing with virtual nodes and replication.

### Search Engine

Hard problem: indexing, ranking, freshness, and query latency.

Architecture:

```text
Crawler/Ingest -> Parser -> Index Builder -> Inverted Index
Query API -> Query Planner -> Ranking -> Results
```

Key choice: separate indexing path from query path.

## 15. Performance Engineering

Method:

1. Define SLO.
2. Measure baseline.
3. Break down latency by hop.
4. Identify saturated resource.
5. Change the smallest useful thing.
6. Re-measure.

Important ideas:

- Average latency hides user pain. Track p95 and p99.
- High utilization causes nonlinear queueing delays.
- Retries can amplify outages.
- Bounded queues are safer than infinite queues.
- Deadline propagation prevents wasted work.

Typical web latency budget:

```text
DNS + TCP/TLS + edge + gateway + app + cache + DB + downstream + serialization
```

## 16. Production Readiness Checklist

Before calling a system production-ready:

- Health endpoint exists.
- Metrics endpoint or exporter exists.
- Structured logs include request IDs.
- Timeouts configured for every dependency.
- Retries have backoff and max attempts.
- Write APIs have idempotency where needed.
- Queues have DLQ and replay story.
- Database has backup and restore test.
- Deployments support rollback.
- Runbooks exist for top incidents.
- Security review covers auth, input validation, secrets, and PII.
- Load test has been run against the expected peak.

## 17. Interview Answer Template

Use this structure:

```text
I will start by clarifying scope.
Functional requirements are...
Non-functional requirements are...
Assuming X DAU and Y requests per user, peak QPS is...
The baseline architecture is...
The critical write/read flow is...
The first bottleneck is likely...
To scale, I would...
For failures, I would...
The main tradeoff is...
```

High-signal phrasing:

- "Given this latency target, I am keeping the hot path synchronous work minimal."
- "This data can be eventually consistent because stale values do not break correctness."
- "This write needs idempotency because clients and gateways may retry."
- "The first bottleneck will likely be the fanout path, not the API server."
- "I would start simple, measure, then split this component when ownership or scale requires it."

## 18. Improvements Made to the Lab Code

The Node.js lab was improved to better match production-style reasoning:

- Test script now fails when tests fail instead of masking errors with `|| true`.
- Added focused Node test coverage for cache, rate limiter, URL shortener, and order validation.
- LRU cache now validates limits and TTLs.
- LRU `has()` now handles cached `null` values correctly and does not pollute hit/miss metrics.
- Token bucket limiter validates constructor values and request cost.
- Task queue now validates task type and clears its timer on stop.
- URL shortener now rejects invalid TTLs and does not reuse expired long URL mappings.
- Order service now rejects fractional quantities, validates totals, and copies item payloads into stored records.
- HTTP body parsing now avoids double-settlement on oversized payloads.
- App config now rejects non-positive operational limits and timeout values.
- README typo was fixed and this guide was added to the course structure.

Verification:

```bash
cd nodejs-system-design-lab
npm test
```

Expected result:

```text
tests 9
pass 9
fail 0
```

## 19. How to Use This Repository

Recommended path:

1. Read this file once end-to-end.
2. Study `01` to `06` for fundamentals.
3. Use `07*` files for full design practice.
4. Use `08*` and `nodejs-system-design-lab/` to build and test concepts.
5. Use `09` to `12` for advanced distributed systems, performance, production, and interviews.
6. Use `14` to `17` for timed practice and communication drills.

The target skill is not memorizing diagrams. The target skill is making clear, defensible decisions from requirements, scale, failure modes, and tradeoffs.

## 20. Ultimate Roadmap Index

Use this as the master checklist for the entire folder.

### Fundamentals
- Requirements and NFRs.
- Capacity estimation.
- Networking and request lifecycle.
- Storage engines and data modeling.
- Consistency and transactions.

### Core infrastructure
- Load balancers and gateways.
- Caches and CDNs.
- Queues and streams.
- Rate limiters and abuse systems.
- Search indexes and object storage.

### Distributed systems
- Replication and sharding.
- Consensus and leader election.
- Sagas and transactional outbox.
- Idempotency and retries.
- Multi-region disaster recovery.

### Real systems
- Social feeds.
- Messaging.
- Media streaming.
- Ride matching.
- URL shorteners.
- Distributed caches.
- Search engines.
- Notification platforms.

### Production mastery
- SLOs and error budgets.
- Metrics, logs, traces.
- Load testing and profiling.
- Security and privacy.
- Deployment and rollback.
- Incident response.

### Portfolio deliverables
- 10 complete design docs.
- 7 working projects.
- 20 bottleneck/failure analyses.
- 10 timed mock interviews.
- 1 capstone production-readiness review.

## 21. Rigorous Capstone Architecture

Use this architecture as the reference capstone for connecting the roadmap to code.

```text
Clients
  -> CDN/WAF
  -> API Gateway
  -> Auth + Rate Limit
  -> Domain Services
      -> URL Shortener Service
      -> Order Service
      -> Notification Service
  -> Data Layer
      -> Postgres primary data
      -> Redis cache/idempotency/rate limit
      -> Queue/event stream
      -> Search/analytics projection
  -> Workers
      -> Analytics aggregation
      -> Outbox publisher
      -> Notification sender
  -> Observability
      -> Metrics
      -> Logs
      -> Traces
      -> Alerts and runbooks
```

### Capstone correctness rules
- Unsafe writes require idempotency keys.
- Durable state changes happen before outbox publication.
- Async workers are at-least-once and idempotent.
- Public APIs return stable error contracts.
- Logs include request IDs and never include secrets.
- Metrics expose request, error, duration, and saturation.

### Capstone failure review
```text
Failure                  Expected behavior
Redis unavailable        degrade cache/rate-limit according to policy
Postgres primary down    reject writes, serve safe cached reads if allowed
Queue backlog            preserve API hot path, alert on age
Worker poison message    retry budget then DLQ
Payment timeout          saga compensation and retry-safe response
Bad deployment           canary rollback
```
