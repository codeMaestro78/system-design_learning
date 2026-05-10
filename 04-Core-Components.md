# Part 2: Core Components (Deep)

## 1) Caching

### Intuition
Caching stores expensive-to-produce data closer to where it is consumed.

### Problem
Databases become bottlenecks under repeated reads.

### Naive
Cache everything forever.

### Optimized evolution
1. Cache read-heavy hot keys.
2. Use bounded TTLs.
3. Add invalidation/versioning.
4. Protect against stampede.

### Deep internals
- Cache-aside: app controls populate/refresh.
- Write-through: writes update cache and DB synchronously.
- Write-back: cache acknowledges before durable store (risk window).
- Write-around: writes bypass cache, reads populate later.

### Eviction policies
- LRU (recency)
- LFU (frequency)
- Size-aware hybrids for large value distributions

### Tradeoffs
- Higher hit ratio lowers DB load but can increase staleness complexity.
- More aggressive TTL reduces staleness but lowers hit rate.

### Pseudo-code (cache-aside with lock)
```text
v = cache.get(k)
if v != nil: return v
acquire singleflight(k)
v = cache.get(k)
if v == nil:
  v = db.get(k)
  cache.set(k, v, ttl+jitter)
release singleflight(k)
return v
```

### Diagram
```text
Client -> Service -> Cache -> (miss) -> DB -> Cache set -> Client
```

### Interview
Always discuss invalidation and stale-read policy.

## Advanced Roadmap: Core Components

### Component map
```text
Client
  -> CDN/WAF
  -> Load Balancer
  -> API Gateway
  -> Service
    -> Rate Limiter
    -> Cache
    -> Database
    -> Queue
    -> Search
    -> Object Store
    -> Metrics/Logs/Traces
```

### Topics and subtopics
- API gateway: routing, auth, rate limits, request shaping, schema validation.
- Cache: TTL, invalidation, stampede protection, hot key mitigation.
- Queue: ack, retry, DLQ, visibility timeout, ordering, partitioning.
- Search: indexing, ranking, relevance, freshness, shard layout.
- Object storage: multipart upload, lifecycle policy, signed URLs, CDN.
- Rate limiter: token bucket, sliding window, distributed counters, abuse controls.

### Example: notification system
```text
Event Intake
  -> Preference Service
  -> Template Renderer
  -> Priority Queue
  -> Channel Workers
  -> Provider Adapters
  -> Delivery Status Store
```

Design decisions:
- Queue by priority to protect critical notifications.
- Idempotency key per notification event.
- Provider failover for email/SMS/push.
- DLQ for invalid templates or permanent provider failures.

### Real systems to study
- Stripe-style idempotent APIs.
- Redis-style cache and data structure server.
- Kafka-style durable partitioned log.
- Elasticsearch/OpenSearch-style distributed search.

### Design exercise
Design a rate-limited public API platform with:
- Per-user and per-IP quotas.
- Burst handling.
- Admin override.
- Metrics for near-limit and rejected traffic.

## Rigorous Component Architecture

### Component responsibilities
```text
CDN/WAF          -> edge caching, DDoS filtering, TLS edge
API Gateway     -> auth, routing, schema validation, coarse rate limits
Service         -> business logic, authorization, orchestration
Cache           -> hot read acceleration, bounded staleness
Queue           -> async work, load leveling, retries
Database        -> source of truth
Search          -> query/relevance optimized projection
Object Store    -> durable large blob storage
Metrics/Logs    -> operability and debugging
```

### Component failure review
```text
Component       Failure mode              Required design answer
Cache           unavailable/stale/hot key fallback + invalidation policy
Queue           backlog/poison message    DLQ + retry budget + replay
Rate limiter    store unavailable         fail-open/fail-closed decision
Search          stale index               fallback + freshness SLO
Object store    slow upload/download      resumable upload + CDN
Gateway         bad routing/auth config   staged rollout + audit logs
```

### Anti-patterns
- Putting business logic into the API gateway.
- Making cache the only copy of important data.
- Letting queues grow without alerting on age.
- Retrying forever.
- Exposing raw database errors to clients.

---

## 2) Load Balancing

### Intuition
Spread traffic to avoid overloading single instances.

### Core algorithms
- Round Robin
- Least Connections
- IP Hash / consistent hash

### L4 vs L7
- L4: transport-level, faster.
- L7: application-level routing, richer policy.

### Reverse Proxy Responsibilities
- TLS termination
- Rate limiting
- Auth edge checks
- Header normalization

### Tradeoffs
- Smart L7 routing improves control, increases complexity.

---

## 3) Database Internals (WAL, Compaction, Read/Write Path)

### Write path
1. Validate request
2. Append to WAL
3. Apply to memory structures
4. Flush/merge to disk structures

### Read path
1. Check memory cache
2. Check indexes
3. Read from disk structures
4. Merge versions if needed

### Compaction
Merges sorted files to reduce read amplification and reclaim tombstoned space.

### Tradeoffs
- Frequent compaction improves reads but increases write amplification.

---

## 4) Message Queues

### Kafka vs RabbitMQ
- Kafka: durable log, high-throughput stream processing, replay-friendly.
- RabbitMQ: flexible routing and queue semantics, strong broker patterns.

### Delivery semantics
- At-most-once
- At-least-once
- Effectively-once with idempotent consumers + dedupe key

### Internals
- Consumer groups
- Offsets/acks
- Partition ordering guarantees

### Interview
Say where ordering is required and how you preserve it.

---

## 5) Consistency Models

### Models
- Strong consistency
- Eventual consistency
- Causal consistency

### Quorum systems
For replication factor `N`, choose read quorum `R`, write quorum `W`.

### Vector clocks
Track causality/version ancestry across replicas to detect concurrent updates.

### Tradeoffs
- Strong consistency simplifies reasoning, increases coordination latency.
- Eventual consistency improves availability/latency, adds reconciliation complexity.

---

## Mastery Exercises
1. Design cache strategy for product service with 95% read traffic.
2. Build queue retry strategy that avoids retry storms.
3. Choose consistency model for profile updates vs payment balance.

---

## Production Patterns Addendum

### Cache invalidation playbook
1. Prefer versioned keys for deterministic invalidation.
2. Use event-driven invalidation for mutable hot objects.
3. Add TTL jitter to avoid synchronized expiry.
4. Add stale-if-error fallback for read paths.

### Queue reliability playbook
- Message key for idempotent consumer
- Exponential backoff + max retry cap
- Dead-letter queue with triage tooling
- Poison message quarantine

### Load balancer health model
- Liveness probe: "process alive"
- Readiness probe: "can serve traffic safely"
- Slow-start ramp for newly added instances

### Consistency decision matrix (quick)
| Use case | Preferred consistency |
|---|---|
| Payment ledger | Strong |
| Profile bio | Eventual acceptable |
| Inventory reservation | Strong for decrement path |
| Feed counters | Eventual/approximate |

### Critical anti-patterns
- Cache used as source of truth without durability strategy
- Blind retries without idempotency
- Unbounded queues with no shedding policy
