# Part 4: Scaling Systems (Deep)

## 1) Handling Millions of Users

### Intuition
Scaling is constraint management: CPU, memory, I/O, network, and human operability.

### Capacity estimation baseline
- DAU/MAU
- Peak concurrency
- Requests per user per day
- Read/write ratio
- Payload size
- Storage growth per day/month

### Formula example
```text
peak_qps = (daily_requests * peak_factor) / 86400
```

---

## 2) Database Scaling Strategies

### Read scaling
- Read replicas
- Query cache/materialized views

### Write scaling
- Sharding by key
- Domain decomposition (service-owned data)

### Hybrid
- OLTP primary + CDC stream to analytical/search systems

### Tradeoffs
- Replicas add lag.
- Sharding adds rebalancing and cross-shard query complexity.

---

## 3) Hotspot Handling

### Common hotspot causes
- Celebrity IDs
- Trending content
- Sequential keys

### Mitigations
- Key salting/bucketing
- Request coalescing (singleflight)
- Multi-layer cache
- Adaptive shard splits

## Advanced Roadmap: Scaling Systems

### Topics and subtopics
- Vertical scaling versus horizontal scaling.
- Stateless services and session externalization.
- Database read replicas and write partitioning.
- Sharding keys and rebalancing.
- Hot key detection and mitigation.
- Queue-based load leveling.
- CDN and edge caching.
- Autoscaling and capacity planning.
- Cost-aware scaling.

### Scale evolution architecture
```text
Stage 1: App + DB
Stage 2: App replicas + Load Balancer + DB
Stage 3: Cache + Queue + Read Replica
Stage 4: Sharded DB + Worker Pools + Search
Stage 5: Multi-region + CDN + Stream Processing + DR
```

### Example: scaling a feed system
```text
Post Write -> Event Bus -> Fanout Workers -> Timeline Store
Read Feed  -> Feed Cache -> Timeline Store -> Ranking
```

Tradeoff:
- Fanout-on-write gives fast reads but expensive writes.
- Fanout-on-read gives cheaper writes but slower reads.
- Hybrid fanout handles celebrity skew.

### Real systems to study
- Twitter/X timeline fanout.
- TikTok/Instagram ranking feeds.
- YouTube CDN-heavy video delivery.
- Google Search distributed indexing and serving.

### Design exercise
Scale a URL shortener from 100 QPS to 1M QPS:
- What changes first?
- Where do you cache?
- How do you protect the DB?
- How do you handle hot links?
- What metrics trigger the next scaling step?

## Rigorous Scaling Playbook

### Scaling decision tree
```text
Is CPU saturated?
  -> add replicas or optimize hot code
Is DB read-heavy?
  -> cache, read replicas, indexes
Is DB write-heavy?
  -> batch, shard, async writes, reduce indexes
Is queue lagging?
  -> add workers, partition, backpressure, inspect poison tasks
Is one key hot?
  -> replicate, cache locally, salt, special-case hot entity
Is network egress high?
  -> CDN, compression, regional placement
```

### Scaling triggers
```text
Signal                    Trigger
p95 > SLO for 10 min       investigate saturated resource
DB CPU > 70% sustained     optimize query or add read path relief
Queue age > user promise   autoscale workers or shed noncritical work
Cache hit rate drops       inspect invalidation/miss storm
Hot partition detected     split/salt/rebalance
Error budget burn          freeze risky deploys and prioritize reliability
```

### Cost discipline
- Scale the bottleneck, not every layer.
- Prefer simpler vertical scaling until it blocks reliability or cost.
- Cache only data with stable reuse.
- Shard only after access patterns justify it.
- Track cloud cost per feature or tenant when possible.

---

## 4) CDN Internals

### Flow
1. User request routed to nearest edge PoP.
2. Edge cache hit returns immediately.
3. On miss, fetch from parent/origin.
4. Cache with policy headers.

### Key mechanics
- Cache key normalization
- TTL + revalidation (`ETag`, `If-Modified-Since`)
- Purge/invalidation APIs

### Tradeoffs
- Longer TTL lowers origin load but increases stale risk.

---

## 5) Geo-Distribution

### Why
- Lower latency
- Regulatory compliance
- Fault isolation

### Patterns
- Active-passive: simpler consistency, slower failover.
- Active-active: lower latency, conflict handling required.

### Data locality
Route users to nearest region while respecting data residency.

---

## 6) Multi-Region Systems

### Design decisions
- Global routing strategy
- Replication mode (sync/async)
- Conflict resolution strategy
- Failover and failback procedures

### Failure handling
- Region isolation
- Read-only degraded mode
- Circuit breakers around cross-region dependencies

### Interview
Discuss blast radius and recovery objectives (RTO/RPO).

---

## Diagram
```text
Global DNS/Anycast
   -> Region A (active) <-> Region B (active)
      |   \                    /   |
      |    -> replication ----    |
   Edge CDN                    Edge CDN
```

## Exercises
1. Design global photo-sharing backend across 3 regions.
2. Handle a hot key receiving 1M QPS.
3. Define RTO/RPO policy for region outage.

---

## Capacity Planning and Cost Modeling Addendum

### Capacity worksheet
For each service, track:
- peak QPS
- p95 payload size
- CPU per request
- memory per connection/session
- storage growth per day
- cache hit ratio target

### Cost-aware architecture
- Compute cost (always-on vs autoscaled)
- Egress cost (often dominant for media systems)
- Storage class strategy (hot/warm/cold tiers)

### Load-shedding tiers
1. Drop non-critical traffic
2. Disable expensive personalization
3. Serve cached/stale fallback
4. Preserve critical write paths

### Multi-region failover checklist
1. Traffic steering control tested
2. Data replication health checked
3. Secrets/config parity validated
4. Read-only fallback mode available
5. Failback plan documented

### Hotspot war game
Simulate one shard receiving 20x traffic and document:
- detection signals,
- immediate mitigations,
- long-term architecture changes.
