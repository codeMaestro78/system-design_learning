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

---

## 22. Quick Reference: Capacity Estimation Calculator

Paste this into any Python 3 environment and plug in your numbers. No dependencies required.

```python
# capacity_calc.py - Plug in your numbers and run: python3 capacity_calc.py

def estimate(
    dau,                  # Daily Active Users
    reads_per_user,       # Avg read operations per user per day
    writes_per_user,      # Avg write operations per user per day
    bytes_per_record,     # Avg size of one record/payload in bytes
    retention_days=365,   # How long to keep data
    peak_factor=5,        # Peak-to-average QPS ratio (5x is a safe default)
    cache_ratio=0.2,      # Fraction of reads that can be served from cache
):
    """
    Estimates system capacity from first principles.
    All outputs are order-of-magnitude approximations.
    Use them to reveal which dimension dominates: reads, writes, storage, or bandwidth.
    """
    SECONDS_PER_DAY       = 86_400
    BYTES_PER_GB          = 1_073_741_824   # 2^30
    BYTES_PER_TB          = BYTES_PER_GB * 1_024
    QPS_PER_DB_NODE       = 5_000           # typical OLTP node (Postgres/MySQL)
    MEMORY_PER_REDIS_NODE = 32              # GB of usable RAM per Redis node

    # ── Traffic ───────────────────────────────────────────────────────
    daily_reads  = dau * reads_per_user
    daily_writes = dau * writes_per_user

    avg_read_qps   = daily_reads  / SECONDS_PER_DAY
    avg_write_qps  = daily_writes / SECONDS_PER_DAY
    peak_read_qps  = avg_read_qps  * peak_factor
    peak_write_qps = avg_write_qps * peak_factor

    # ── Storage ───────────────────────────────────────────────────────
    daily_write_bytes   = daily_writes * bytes_per_record
    total_storage_bytes = daily_write_bytes * retention_days
    total_storage_gb    = total_storage_bytes / BYTES_PER_GB
    total_storage_tb    = total_storage_bytes / BYTES_PER_TB

    # ── Cache ─────────────────────────────────────────────────────────
    # Assumption: cache holds the "hot" fraction of unique records accessed daily
    hot_records      = daily_reads * cache_ratio
    cache_size_bytes = hot_records * bytes_per_record
    cache_size_gb    = cache_size_bytes / BYTES_PER_GB

    # ── Bandwidth ─────────────────────────────────────────────────────
    peak_bytes_per_sec = peak_read_qps * bytes_per_record
    peak_mbps          = (peak_bytes_per_sec * 8) / 1_000_000

    # ── Node counts (rough estimates) ─────────────────────────────────
    db_nodes    = max(1, int(peak_read_qps  / QPS_PER_DB_NODE) + 1)
    redis_nodes = max(1, int(cache_size_gb  / MEMORY_PER_REDIS_NODE) + 1)

    # ── Report ────────────────────────────────────────────────────────
    SEP = "=" * 58
    DIV = "-" * 58
    print(SEP)
    print("  CAPACITY ESTIMATE")
    print(SEP)
    print(f"  DAU                    : {dau:>15,.0f}")
    print(f"  Reads  / user / day    : {reads_per_user:>15,.0f}")
    print(f"  Writes / user / day    : {writes_per_user:>15,.0f}")
    print(f"  Bytes  / record        : {bytes_per_record:>15,.0f}")
    print(f"  Retention              : {retention_days:>14,.0f}d")
    print(f"  Peak factor            : {peak_factor:>14,.0f}x")
    print(f"  Cache ratio            : {cache_ratio:>14.0%}")
    print(DIV)
    print("  TRAFFIC")
    print(f"    Daily reads          : {daily_reads:>15,.0f}")
    print(f"    Daily writes         : {daily_writes:>15,.0f}")
    print(f"    Avg  read  QPS       : {avg_read_qps:>15,.1f}")
    print(f"    Avg  write QPS       : {avg_write_qps:>15,.1f}")
    print(f"    Peak read  QPS       : {peak_read_qps:>15,.1f}")
    print(f"    Peak write QPS       : {peak_write_qps:>15,.1f}")
    print(DIV)
    print("  STORAGE")
    print(f"    Daily write volume   : {daily_write_bytes/1e9:>14.2f} GB")
    print(f"    Total ({retention_days}d)         : {total_storage_gb:>14.1f} GB  ({total_storage_tb:.2f} TB)")
    print(DIV)
    print("  CACHE")
    print(f"    Hot dataset size     : {cache_size_gb:>14.2f} GB")
    print(f"    Redis nodes needed   : {redis_nodes:>15}")
    print(DIV)
    print("  BANDWIDTH (peak reads)")
    print(f"    Bytes / sec          : {peak_bytes_per_sec:>15,.0f}")
    print(f"    Mbps                 : {peak_mbps:>15.1f}")
    print(DIV)
    print("  DATABASE")
    print(f"    DB nodes needed      : {db_nodes:>15}  (at {QPS_PER_DB_NODE:,} QPS/node)")
    print(SEP)


# ── Example: Twitter-scale read-heavy feed service ────────────────────
if __name__ == "__main__":
    estimate(
        dau              = 10_000_000,   # 10M DAU
        reads_per_user   = 50,           # 50 timeline reads/day
        writes_per_user  = 2,            # 2 tweets/day
        bytes_per_record = 1_000,        # ~1 KB per tweet record
        retention_days   = 365,
        peak_factor      = 5,
        cache_ratio      = 0.2,
    )
```

Expected output:

```text
==========================================================
  CAPACITY ESTIMATE
==========================================================
  DAU                    :      10,000,000
  Reads  / user / day    :              50
  Writes / user / day    :               2
  Bytes  / record        :           1,000
  Retention              :             365d
  Peak factor            :               5x
  Cache ratio            :             20%
----------------------------------------------------------
  TRAFFIC
    Daily reads          :     500,000,000
    Daily writes         :      20,000,000
    Avg  read  QPS       :           5,787.0
    Avg  write QPS       :             231.5
    Peak read  QPS       :          28,935.2
    Peak write QPS       :           1,157.4
----------------------------------------------------------
  STORAGE
    Daily write volume   :          20.00 GB
    Total (365d)         :       7,300.0 GB  (7.13 TB)
----------------------------------------------------------
  CACHE
    Hot dataset size     :          19.07 GB
    Redis nodes needed   :               1
----------------------------------------------------------
  BANDWIDTH (peak reads)
    Bytes / sec          :      28,935,185
    Mbps                 :           231.5
----------------------------------------------------------
  DATABASE
    DB nodes needed      :               6  (at 5,000 QPS/node)
==========================================================
```

**How to interpret:** Peak read QPS of ~29k immediately tells you a single Postgres node is insufficient. Storage of 7 TB over a year tells you you need tiered or partitioned storage. Cache of ~19 GB fits comfortably in one Redis node. These numbers drive architecture, not decorate it.

---

## 23. Decision Tree: Which Database?

Read top to bottom. Stop at the first branch that matches your primary requirement.

```text
START: What is your primary access pattern?
│
├─── Need ACID transactions / relational integrity?
│    └─► YES ──► PostgreSQL / MySQL
│                Use when   : joins, foreign keys, complex queries, financial data,
│                             flexible ad-hoc reporting
│                Don't use  : write throughput > ~50k TPS sustained; true
│                             multi-region active-active with <10ms global latency
│                Real example: Shopify orders, GitHub repos, Stripe payment ledger
│
├─── Need massive horizontal write scale with simple key lookups?
│    └─► YES ──► DynamoDB / Cassandra / ScyllaDB / Bigtable
│                Use when   : known key-based access patterns, horizontal write
│                             scale, multi-region replication, large data volume
│                Don't use  : ad-hoc queries, joins, strong consistency across rows,
│                             unknown or changing query patterns
│                Real example: Amazon shopping cart (DynamoDB),
│                             Discord messages (Cassandra → ScyllaDB)
│
├─── Need full-text search, ranking, or faceted filtering?
│    └─► YES ──► Elasticsearch / OpenSearch / Typesense / Meilisearch
│                Use when   : keyword search, autocomplete, log analytics,
│                             ranked results, multi-field filtering
│                Don't use  : primary transactional store, source of truth,
│                             financial records, relationships needing joins
│                Real example: GitHub code search, Airbnb listing search,
│                             Datadog log analytics
│
├─── Need time-series data: metrics, IoT readings, events by time?
│    └─► YES ──► InfluxDB / TimescaleDB / VictoriaMetrics / Prometheus
│                Use when   : high-frequency writes keyed by timestamp,
│                             time-window aggregations, retention/downsampling
│                Don't use  : general-purpose relational workloads,
│                             random-key access patterns
│                Real example: Cloudflare network metrics, Tesla sensor telemetry,
│                             Robinhood market data
│
├─── Need graph traversal where relationships are first-class?
│    └─► YES ──► Neo4j / Amazon Neptune / TigerGraph
│                Use when   : social graphs, fraud ring detection,
│                             recommendation engines, knowledge graphs
│                Don't use  : simple relational data, high-throughput writes,
│                             when SQL joins already solve the problem
│                Real example: LinkedIn degree-of-separation,
│                             fraud detection at PayPal and Uber
│
├─── Need fast in-memory caching, leaderboards, pub/sub, or counters?
│    └─► YES ──► Redis / Valkey / Dragonfly
│                Use when   : sub-millisecond reads, TTL-keyed sessions,
│                             rate limit counters, sorted sets, pub/sub fanout
│                Don't use  : primary durable data store without persistence
│                             configured; data too large for RAM budget
│                Real example: Twitter timeline cache, Uber surge pricing state,
│                             GitHub session storage
│
├─── Need analytical queries over large datasets (OLAP)?
│    └─► YES ──► ClickHouse / BigQuery / Redshift / Snowflake / Apache Pinot
│                Use when   : columnar scans, aggregations, BI dashboards,
│                             petabyte-scale analytics, event funnel analysis
│                Don't use  : transactional point reads, low-latency user-facing
│                             APIs, sub-10ms response requirements
│                Real example: Cloudflare analytics (ClickHouse),
│                             Uber trip analytics (Pinot), Airbnb data warehouse
│
└─── Need to store large files, blobs, or media?
     └─► YES ──► Amazon S3 / GCS / Azure Blob / MinIO (self-hosted)
                 Use when   : images, videos, ML model weights, backups,
                              logs, static assets, anything > 1MB
                 Don't use  : structured queries, sub-10ms random access,
                              data that changes frequently at byte level
                 Real example: Netflix video assets, Instagram photos,
                              Dropbox file storage, Hugging Face model hub
```

**Rule of thumb:** If two branches match, default to the one that is more boring and more battle-tested. Add the specialized store only when the primary store provably cannot handle that access pattern.

---

## 24. The 10 Most Common System Design Mistakes

These are not theoretical. They appear in real production postmortems.

### Mistake 1: Single Point of Failure

**What it looks like:** One database primary, one Kafka broker, one region, one load balancer node.

**What goes wrong at scale:** That node fails during a hardware replacement, network partition, or bad deploy. The entire system goes down. RTO equals however long it takes to notice and provision a replacement — often 20–60 minutes.

**The fix:**
- Every critical component needs a hot standby or replica running before you need it.
- Databases: primary + at least one synchronous replica, promoted automatically.
- Load balancers: pairs in active-passive or active-active configuration.
- Cloud deployments: multi-AZ as the baseline, multi-region for ≥ 99.99% SLA.
- Brokers: Kafka minimum 3 brokers with replication factor 3.

---

### Mistake 2: No Cache — DB Gets Hammered on Every Read

**What it looks like:** Every API call reads directly from Postgres. Works at 200 QPS. Falls apart at 10,000 QPS when the connection pool saturates and p99 spikes to 5 seconds.

**What goes wrong at scale:** Read replicas help briefly, then they saturate too. Adding more DB nodes helps but becomes expensive and complex.

**The fix:**

```text
Layer 1: In-process LRU cache    — microsecond latency, bounded memory, per-instance
Layer 2: Redis cluster           — millisecond latency, shared across all instances
Layer 3: CDN / edge cache        — tens of milliseconds, for public non-personalized responses
```

Cache the 20% of keys that serve 80% of traffic. Set aggressive TTLs. Use cache-aside for flexibility. Add negative caching for missing keys to prevent cache-miss storms.

---

### Mistake 3: Synchronous Everything — One Slow Service Blocks All

**What it looks like:** The order endpoint calls payment → shipping → email → analytics → loyalty points in sequence before returning. One 2-second email send makes checkout take 6 seconds.

**What goes wrong at scale:** Cascading latency. If analytics is slow, checkout is slow. Flaky shipping API causes order failures. Services that should not be coupled are tightly coupled through synchronous calls.

**The fix:**
- Keep only what must be confirmed before responding in the synchronous path. For orders: validate + charge payment synchronously.
- Everything else — email confirmation, analytics event, loyalty points, shipping label — goes onto a queue and is processed asynchronously.
- Use a task queue or event bus. The order endpoint returns in under 200ms regardless of what downstream services do.

---

### Mistake 4: No Rate Limiting — Bad Actors Tank the Whole System

**What it looks like:** A public API with no per-IP or per-user limits. One misconfigured client or attacker sends 100,000 RPS. All legitimate users are crowded out.

**What goes wrong at scale:** DB connections saturate. Memory fills with socket handles. Legitimate users get 503 errors. The attack is indistinguishable from a traffic spike until it is too late.

**The fix:**
- Rate limit at the API gateway or edge — not only in application code.
- Apply separate limits by: user ID, API key, IP address, tenant ID, and route.
- Return `429 Too Many Requests` with a `Retry-After` header so well-behaved clients back off.
- Unauthenticated traffic gets a much stricter limit than authenticated traffic.
- Token bucket algorithm: allows short controlled bursts while enforcing a sustained rate ceiling.

---

### Mistake 5: No Idempotency — Retries Cause Duplicate Charges or Emails

**What it looks like:** Client sends `POST /charge`. Network times out at 30 seconds. Client retries. Two charges hit the user's card. Support tickets flood in.

**What goes wrong at scale:** Every retry becomes a risk. Any gateway, load balancer, or client library will retry on timeout or 5xx. Without idempotency, every retry is potentially a duplicate side effect.

**The fix:**

```text
Client sends:   POST /charge
                Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000

Server logic:
  1. Look up the idempotency key.
  2. If COMPLETED  → return the stored response immediately.
  3. If IN_PROGRESS → return 409 or wait.
  4. If NEW        → mark IN_PROGRESS, execute, store result, mark COMPLETE.
```

Idempotency is mandatory for: payment charges, order creation, email and SMS sends, external API calls, task scheduling.

---

### Mistake 6: Fat Monolith Writes — One Slow Transaction Blocks Everything

**What it looks like:** A single write transaction touches 12 tables: orders, inventory, audit_log, user_stats, shipping_label, billing_record, loyalty_points... all under one distributed lock.

**What goes wrong at scale:** Lock contention grows with table size. One slow report running against the same tables stalls all checkouts. Long-running transactions increase deadlock probability. Write throughput degrades nonlinearly.

**The fix:**
- Commit only the core state in the transaction: the order record and payment record.
- Publish a domain event after the commit (Transactional Outbox pattern).
- Let downstream workers update audit logs, loyalty points, analytics, and shipping asynchronously.
- The write transaction should touch the minimum number of rows in the minimum time.

---

### Mistake 7: Missing Indexes — N+1 Queries at Scale

**What it looks like:** A query works fine in development on 10,000 rows. In production on 50 million rows, `SELECT * FROM orders WHERE user_id = ?` without an index does a full table scan. At 5,000 QPS, the database is doing 5,000 full table scans per second.

**What goes wrong at scale:** Query latency jumps from 1ms to 8 seconds. DB CPU pegs at 100%. Everything downstream queues up and times out.

**The fix:**
- Every foreign key column gets an index by default.
- Every `WHERE` column used in production queries gets an index.
- Run `EXPLAIN ANALYZE` before deploying any new query to production.
- Monitor slow query logs and alert on queries over 100ms.
- For multi-column filters, use composite indexes and pay attention to column order.
- Partial indexes for filtering over a subset (e.g., `WHERE status = 'pending'`).

---

### Mistake 8: No Circuit Breaker — Cascade Failure on Dependency Outage

**What it looks like:** Order service calls inventory service synchronously. Inventory service becomes slow — 50% of calls take 10 seconds. Order service threads block waiting. The thread pool exhausts. Order service is now also down. Everything that calls order service is now also down.

**What goes wrong at scale:** One slow microservice takes down every caller in the dependency chain. This is cascade failure: the most dangerous failure mode in distributed systems.

**The fix:**

```text
Circuit Breaker States:

  CLOSED   → requests flow through; failure rate is monitored
             (normal operation)

  OPEN     → requests fail immediately without calling the dependency
             (fast fail; protects the caller and gives dependency time to recover)

  HALF-OPEN → a limited number of probe requests are sent
             (if they succeed, transition back to CLOSED; if they fail, stay OPEN)
```

Pair circuit breakers with: hard timeouts on every call, bounded thread pools per dependency, and explicit fallback behavior (serve stale data, degrade the feature, return a degraded response).

---

### Mistake 9: Synchronous Fan-Out — Tweeting to 10M Followers in the Request Path

**What it looks like:** `POST /tweet` writes the tweet, then immediately loops through all 10M follower IDs and inserts a record into each follower's timeline table before returning the HTTP response.

**What goes wrong at scale:** The HTTP request times out after 30 seconds. Memory is exhausted buffering 10M IDs. The endpoint becomes unusable for any account with significant following. Regular users with 100 followers are also impacted because the DB is under load.

**The fix:**
- Write the tweet to the tweet store synchronously. Return the HTTP 200 response immediately.
- Enqueue a fan-out job asynchronously: `{ tweet_id, author_id, follower_list }`.
- Fan-out workers spread the work across many machines in parallel.
- For extreme celebrities (>1M followers): hybrid model — push to normal followers on write, pull celebrity tweets on read into the timeline.
- The `POST /tweet` response returns in under 100ms regardless of follower count.

---

### Mistake 10: No Monitoring or Alerting — Finding Out the System Is Down from Users

**What it looks like:** System is deployed. No dashboards. No alerts. On-call engineer is paged by a user's Slack message 45 minutes after the outage started. By the time they investigate, an hour of SLA is gone.

**What goes wrong at scale:** Long MTTD (mean time to detect). Long MTTR (mean time to recover). SLA is breached. User trust erodes. Post-mortems are chaotic because there is no data about what happened.

**The fix:**
- Alert on the four golden signals: latency, traffic, error rate, saturation.
- Use SLO-based burn rate alerts: "error rate is consuming the error budget 10x faster than normal" fires before the SLO is breached.
- Synthetic monitoring: run real end-to-end transactions against production every 60 seconds.
- Alert on queue consumer lag age, cache hit rate drops, and DB replication lag.
- Every alert must have a linked runbook that tells the on-call engineer exactly what to check and what to do.

---

## 25. Component Selection Matrix

| Need | Options | Choose When | Avoid When |
|------|---------|-------------|------------|
| **Caching** | Redis, Memcached, CDN edge, in-process LRU | Data is read-heavy; brief staleness is acceptable; need sub-millisecond response | Data changes on every request; strong consistency is required across all readers |
| **Message Queue** | Kafka, RabbitMQ, AWS SQS, Redis Streams, Google Pub/Sub | Producers and consumers need decoupling; need durable async delivery; event replay is required (Kafka) | You need synchronous request-reply; team has no operational bandwidth for a broker |
| **Full-Text Search** | Elasticsearch, PostgreSQL FTS, Typesense, Meilisearch | Keyword search, autocomplete, faceted filtering, log analytics, ranked relevance | It would be your sole data store; you need transactional writes against the same data |
| **Relational DB** | PostgreSQL, MySQL, CockroachDB, Cloud Spanner | Complex queries, joins, ACID transactions, schema flexibility, strong correctness | Sustained write throughput above ~100k TPS; true multi-region active-active at low latency |
| **NoSQL / Wide-Column** | DynamoDB, Cassandra, ScyllaDB, Bigtable, HBase | Known key-based access patterns; horizontal write scale; massive data volume | Ad-hoc analytical queries; many-to-many relationships; unknown future query patterns |
| **Blob / Object Storage** | AWS S3, GCS, Azure Blob, MinIO | Large immutable files: images, videos, ML weights, backups, logs, static assets | You need structured queries over content; sub-10ms random-byte access patterns |
| **CDN** | Cloudflare, Fastly, AWS CloudFront, Akamai | Public static or cacheable content; globally distributed users; DDoS mitigation | Highly personalized or user-specific content that cannot be cached; real-time dynamic data |
| **Load Balancer** | AWS ALB/NLB, NGINX, HAProxy, Envoy | Distributing HTTP or TCP traffic; SSL termination; health checks; path-based routing | Traffic is trivially low; single-node prototype; adds an unnecessary latency hop |
| **API Gateway** | Kong, AWS API Gateway, Apigee, Traefik | Central authentication, rate limiting, request routing, observability at the ingress tier | Internal service-to-service calls; adds unwanted latency or becomes a single point of failure |
| **Service Mesh** | Istio, Linkerd, Consul Connect, Cilium | mTLS between services; traffic shaping; fine-grained observability in Kubernetes | Small team with fewer than 10 services; operational complexity exceeds the benefit |
| **Monitoring** | Prometheus + Grafana, Datadog, New Relic, OpenTelemetry | Production metric collection, dashboards, SLO-based alerting, distributed tracing | Prototype phase with nothing meaningful to monitor yet |
| **Time-Series DB** | InfluxDB, TimescaleDB, Prometheus, VictoriaMetrics | High-frequency metric ingestion, time-window aggregations, automated retention/downsampling | General-purpose application data; relational workloads; point lookups by non-time key |

**How to use this table:** Identify the need in the left column. Consider all options. Apply the "Choose When" and "Avoid When" columns against your actual requirements. If multiple options fit, default to the one your team already operates — operational knowledge is a real asset.

---

## 26. The "Boring Technology" Principle

Dan McKinley's essay "Choose Boring Technology" is one of the most practically useful ideas in software engineering. Here is the distilled version.

### The Core Idea

Every technology choice is also an operational choice. You must run, debug, scale, hire for, and page on that technology at 3 AM. Well-understood ("boring") tools have:

- **Known failure modes:** You already know exactly how Postgres behaves under connection pressure, how Redis behaves when memory is full, how Kafka behaves when a broker goes down. There are no surprises.
- **Abundant expertise:** Every senior engineer has used Postgres, Redis, and Nginx. Hiring is easier. Debugging is faster.
- **Mature ecosystem:** Observability integrations, client libraries, ORMs, migration tools, and community answers on Stack Overflow all exist.
- **Predictable behavior:** Boring tools do not introduce exciting failure modes. Exciting failure modes are bad.

### Boring Technology Winning in Practice

**PostgreSQL over NewSQL (CockroachDB, TiDB, Spanner):**
- Postgres handles the vast majority of OLTP workloads at any startup or mid-size company.
- CockroachDB and Spanner solve real problems — global strong consistency at millions of TPS — but very few systems need that.
- Shopify runs its core commerce platform on MySQL (sharded via Vitess) and handles Black Friday with billions of dollars in GMV. They did not need a NewSQL database. They needed good sharding.
- Most companies hit Postgres's limits only after years of growth, by which time they have the engineering resources and data to make a migration decision based on real evidence.

**Redis over a custom in-memory cache:**
- Redis gives you persistence options, replication, clustering, pub/sub, sorted sets, TTL, and Lua scripting — battle-tested over a decade at scale.
- A custom in-memory cache gives you a maintenance burden, no replication, no persistence, and all the edge cases Redis already solved.
- Twitter, Slack, GitHub, and Stack Overflow all use Redis for caching and session management.

**S3 over a custom object store:**
- S3 provides 99.999999999% (11 nines) durability with zero operational burden on your team.
- Building a distributed object store requires solving erasure coding, replication, garbage collection, namespace management, and versioning from scratch.
- Dropbox used S3 in its early years, then built Magic Pocket only after it reached hundreds of petabytes — when the economics of building justified the years of engineering investment.

**Kafka over a custom event bus:**
- Kafka gives you durable ordered logs, consumer groups, partition-level parallelism, and replay — out of the box.
- It was built by LinkedIn to solve a real problem at scale. Netflix, Uber, Airbnb, and Confluent all run it in production.
- Build a custom event bus only if you have a specific, provable requirement Kafka cannot satisfy.

### When to Break This Rule

Cutting-edge technology is the right choice when:

1. **The boring option provably cannot solve your problem.** You genuinely need planetary-scale strong consistency (Spanner territory) or sub-millisecond global latency that no commodity database provides.
2. **The economics are compelling at your specific scale.** Dropbox building Magic Pocket at hundreds of petabytes of storage. The S3 bill was larger than the engineering cost of building their own.
3. **The cutting-edge capability is the product.** If you are building an AI product, the latest model capability is the core value proposition. Using the most capable model is not gold-plating — it is the product.
4. **Your team has deep existing expertise.** Choosing Rust for a high-performance networking component when your team already has Rust engineers is a rational choice, not a gamble.

### The Trade-Off Table

| Dimension | Boring Technology | Cutting-Edge Technology |
|---|---|---|
| **Hiring** | Large talent pool; any senior engineer knows it | Niche; harder and more expensive to hire |
| **Debugging** | Known failure modes; answers exist everywhere | Unknown unknowns; you are discovering failure modes |
| **Ecosystem** | Mature tooling, libraries, observability integrations | Immature or missing; you may build primitives |
| **Capability ceiling** | May have a real ceiling at extreme scale | May unlock capabilities that are otherwise impossible |
| **Operational risk** | Low; you know what to do when it breaks | Higher; the first production failure is a research project |
| **Competitive advantage** | Unlikely to be a differentiator | Can be a genuine moat if it works and competitors cannot match it |

**Default rule:** Start boring. Earn the right to be interesting by hitting the boring tool's actual limits in production — not in speculation.

---

## 27. Real-World Architecture Examples

These are not just inspiration. Each example contains a specific, defensible technology decision you can reference in design discussions.

### Instagram at Acquisition (2012) — $1B, 13 Engineers, 30M Users

**Stack:** Python (Django) + PostgreSQL + Redis + Gearman + Solr + Nginx on AWS EC2 + S3 + CloudFront

**What the architecture looked like:**
- PostgreSQL for all relational data: users, follows, likes, comments, media metadata.
- Redis for feed caching and session storage — the hot path for photo browsing.
- S3 for photo storage. CloudFront CDN for global photo delivery.
- Gearman as the job queue for async photo processing (thumbnail generation, filters).
- No microservices. No Kubernetes. No distributed transactions. One Django monolith.

**Why this matters:**
- 30 million users served by 13 engineers using the most boring stack available in 2012.
- Every component was a well-understood tool with known failure modes.
- The monolith scaled to a $1 billion acquisition without needing decomposition.
- Microservices came years later, after the team grew by an order of magnitude and domain boundaries solidified.

**Key lesson:** Product-market fit and engineering simplicity are not in conflict. The boring stack scaled further than anyone expected.

---

### Slack's Message Storage — Vitess + Redis + Memcached

**Stack:** Vitess (MySQL sharding layer) + Redis + Memcached + Solr for search

**The problem:** Slack needed MySQL's query flexibility and transactional guarantees but MySQL could not horizontally shard easily at Slack's message volume.

**The solution:** Vitess — originally built by YouTube to shard MySQL horizontally — was adopted rather than switching to a new database.

**Architecture choices:**
- Messages sharded by workspace and channel ID: predictable access pattern that maps well to horizontal sharding.
- Redis for presence (who is online right now): TTL-based keys, no durability needed, perfect for ephemeral state.
- Memcached for application-level caching of channel metadata and user profiles.
- The core data store remained MySQL throughout Slack's growth from startup to public company.

**Key lesson:** Do not switch databases when you can shard your existing one. The operational knowledge, the query patterns, the tooling, and the hiring pipeline for MySQL were all worth preserving.

---

### Discord's Storage Evolution — MongoDB → Cassandra → ScyllaDB (10B+ Messages/Day)

**Timeline and why each migration happened:**

- **2015 — MongoDB:** Flexible document schema was valuable during early product iteration. Query patterns were not yet known. Speed of development mattered more than operational efficiency.
- **2017 — Cassandra:** MongoDB could not sustain Discord's write volume as messages scaled. Cassandra's LSM-tree architecture handles high write throughput by design. Migrated based on real production bottlenecks, not speculation.
- **2022 — ScyllaDB:** Cassandra's JVM caused GC pause spikes that translated to p99 latency outliers at Discord's scale of billions of messages per day. ScyllaDB is API-compatible with Cassandra but implemented in C++ with its own scheduler, eliminating JVM GC as a variable.

**What this tells you:**
- Start with what lets you move fast. MongoDB's flexible schema was the right choice in 2015.
- Migrate when real production data forces the decision — not when a blog post suggests a better option.
- ScyllaDB was not chosen for new features. It was chosen to solve a specific, measured problem: JVM GC pause latency at scale.

**Key lesson:** Every migration was evidence-driven. The path from MongoDB to ScyllaDB represents one of the best-documented examples of data-driven infrastructure evolution in the industry.

---

### Shopify — The Rails Monolith That Handles Black Friday

**Stack:** Ruby on Rails + MySQL (sharded via Vitess) + Redis + Memcached + Kafka + Kubernetes for deployment

**Scale:** Billions of dollars in GMV processed on Black Friday. Peaks at hundreds of thousands of requests per minute. Hundreds of millions of API calls per day.

**Architecture choices:**
- Rails monolith for the core commerce platform — the same conceptual architecture since 2006, continuously refined.
- MySQL sharded via Vitess for horizontal write scale, without abandoning the SQL model.
- Shopify introduced "Pods" — tenant-isolated database shards — to limit blast radius and allow independent scaling per merchant tier. This is not microservices; it is isolation within a monolith.
- Redis for rate limiting, session management, and distributed locking.
- Kafka for event streaming between internal systems.

**Key lesson:** Microservices are not a prerequisite for scale. A well-engineered monolith with careful database sharding and caching can handle extraordinary traffic. Decompose services when team topology and domain complexity require it, not before.

---

### WhatsApp — Efficiency as Competitive Advantage (2014)

**Stack:** Erlang on FreeBSD + Mnesia (Erlang's distributed database) + custom XMPP protocol

**Scale at acquisition:** 450 million users. 50 engineers. 32 engineers in engineering. 2 million concurrent connections per server.

**Why Erlang:**
- Erlang was designed by Ericsson for telephone switches: always-on, fault-tolerant, massively concurrent.
- The actor model (lightweight processes, message passing) maps perfectly to the problem of managing millions of concurrent chat sessions.
- Each Erlang process is ~300 bytes. A server can host millions of processes with no thread-per-connection overhead.
- Hot code reloading means deployments can happen without dropping connections.

**Why this matters:**
- 2 million concurrent connections per server was not achievable with a conventional thread-per-connection stack (Node, Java, Python) without extraordinary engineering effort.
- The technology choice directly translated to fewer servers, lower infrastructure cost, and a smaller engineering team — all competitive advantages.
- WhatsApp did not choose Erlang because it was fashionable. They chose it because it was the right tool for their specific, unusual workload.

**Key lesson:** Technology choices compound over years. WhatsApp's Erlang decision shaped their entire cost structure and team size. Know your workload's unique characteristics before committing to a stack.

---

## 28. System Design Interview Checklist

Use this as your one-page reference before every mock interview and real interview. The goal is not to cover every item in every interview — it is to never forget a critical dimension.

### Requirements (2–3 minutes)

- [ ] Clarified functional requirements: what does the system do? What are the 3–5 core use cases?
- [ ] Clarified non-functional requirements:
  - [ ] Latency target (p50 / p95 / p99 at the API tier)
  - [ ] Availability target (99.9% / 99.99% / 99.999%)
  - [ ] Consistency model (strong / eventual / read-your-writes / monotonic reads)
  - [ ] Durability requirements (zero data loss / best-effort / RPO window)
- [ ] Asked which requirements are negotiable and which are hard constraints

### Estimation (2–3 minutes)

- [ ] Estimated DAU (Daily Active Users)
- [ ] Estimated reads per user per day → daily reads → avg and peak read QPS
- [ ] Estimated writes per user per day → daily writes → avg and peak write QPS
- [ ] Estimated storage growth per year (writes × record size × retention)
- [ ] Estimated bandwidth (peak QPS × average payload size)
- [ ] Called out which dimension dominates: read-heavy, write-heavy, or storage-heavy

### API Design (2–3 minutes)

- [ ] Defined 3–5 core API endpoints that cover the critical use cases
- [ ] Stated request and response shape for the most important paths
- [ ] Identified which APIs need idempotency keys and why

### Data Model (3–5 minutes)

- [ ] Chose the primary database type with explicit reasoning tied to access patterns
- [ ] Defined primary entities, their fields, and their relationships
- [ ] Identified the partition key or shard key and justified the choice
- [ ] Stated the indexing strategy (which columns, why)
- [ ] Considered schema evolution and migration strategy

### High-Level Design (5–8 minutes)

- [ ] Drew a 3–5 component diagram covering the critical path
- [ ] Named each component and stated its responsibility clearly
- [ ] Showed the data flow: client → edge → service → storage → response

### Critical Flows (5–8 minutes)

- [ ] Walked the critical READ path end-to-end, step by step
- [ ] Walked the critical WRITE path end-to-end, step by step
- [ ] Called out where latency is spent in each path
- [ ] Called out where failures can occur in each path

### Deep Dive: Bottlenecks and Scaling (8–12 minutes)

- [ ] Identified the number one bottleneck at the estimated scale
- [ ] Added caching strategy: what to cache, where, TTL, invalidation policy
- [ ] Addressed hotspots: celebrity accounts, viral content, trending keys
- [ ] Proposed sharding or partitioning strategy if write scale demands it
- [ ] Moved heavy or slow work off the synchronous critical path

### Reliability and Failure Handling

- [ ] Identified and eliminated single points of failure
- [ ] Added timeouts on every outbound network call
- [ ] Added retries with exponential backoff and jitter
- [ ] Added idempotency keys for all retryable writes
- [ ] Described circuit breaker placement and fallback behavior
- [ ] Defined graceful degradation: which features can be disabled under load
- [ ] Stated the consistency contract under network partition

### Observability

- [ ] Mentioned metrics: request rate, error rate, latency percentiles, saturation
- [ ] Mentioned distributed tracing for cross-service latency attribution
- [ ] Mentioned alerting strategy: SLO burn rate alerts, not just raw CPU thresholds
- [ ] Mentioned synthetic monitoring or canary probes for proactive detection

### Evolution at 10x Scale

- [ ] Stated which component breaks first if traffic grows 10x
- [ ] Proposed the concrete next scaling step for that bottleneck
- [ ] Noted what would need to be re-architected versus what just needs tuning

---

### High-Signal Phrases to Use in Interviews

```text
"Given the p95 latency target, I'm keeping the hot path synchronous work minimal —
 everything that can be async will be async."

"This data can be eventually consistent because stale reads don't break correctness
 for the user — they will see the update within seconds and that is acceptable."

"This write needs an idempotency key because the client, the gateway, and the load
 balancer may all retry on timeout, and duplicate side effects are unacceptable here."

"The first bottleneck at this scale will be the fan-out path, not the API tier —
 so I want to address that before we go further."

"I would start with a monolith and split this into a separate service only when team
 ownership or scale specifically requires the split."

"Let me call out the trade-off explicitly: option A gives us lower latency but risks
 stale reads; option B gives us strong consistency but requires a synchronous round
 trip to the primary. Given the requirements, I would choose A."

"At 10x scale, the primary write path saturates first. The fix is sharding by
 [partition key] — here is how I would pick that key."
```
