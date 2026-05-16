# Deliberate Drills: Requirements, Estimation, Tradeoffs, Failure Handling

## Goal
Build precision in the 4 skills interviewers and senior engineers value most.

---

## Drill 1: Requirements Clarification

## Why
Bad requirements produce perfect solutions to the wrong problem.

## 10-question requirement checklist
1. Who are users?
2. Core functional features?
3. Non-functional priorities (latency, availability, consistency)?
4. Read/write ratio?
5. Peak traffic pattern?
6. Data retention/compliance needs?
7. Multi-region requirement?
8. Failure tolerance level?
9. Cost sensitivity?
10. Scope exclusions?

## Exercise format
- Take one system prompt.
- Spend 7 minutes writing only requirements.
- No architecture until this is complete.

---

## Drill 2: Estimation

## Why
Scale determines architecture choices.

## Estimation template
1. DAU/MAU assumption
2. Requests per user per day
3. Peak factor
4. Peak QPS
5. Average payload size
6. Daily storage growth
7. Yearly storage growth
8. Network bandwidth approximation

## Quick formulas
```text
peak_qps = (daily_requests * peak_factor) / 86400
daily_storage = writes_per_day * avg_record_size
```

## Exercise
Estimate for:
1. URL shortener
2. Chat service
3. Video platform metadata service

## Sophisticated Drill System

### Drill: architecture from bottleneck
Pick one bottleneck and design backward:
- Hot key.
- Slow database.
- Queue lag.
- Regional outage.
- Celebrity fanout.
- CDN miss storm.

Output:
- Root cause.
- Immediate mitigation.
- Long-term architecture change.
- Metrics proving recovery.

### Drill: consistency decision
For each feature, label consistency:
- Strong.
- Read-your-writes.
- Eventual.
- Best-effort.

Examples:
- Payment ledger: strong.
- Like counter: eventual.
- Message send ack: durable before ack.
- Presence: best-effort.

### Drill: real-world comparison
Compare your design to a known system:
- What is similar?
- What is simplified?
- What would only appear at massive scale?
- What is intentionally excluded?

## Rigorous Drill Bank

### Drill: one component, five failures
Pick cache, queue, database, search, or payment provider.
Write five failures and mitigations.

### Drill: scale trigger
For one system, define the exact metric that triggers:
- Add cache.
- Add queue.
- Add read replica.
- Shard database.
- Add regional deployment.

### Drill: remove a component
Take a design and remove one component. Explain:
- What breaks?
- What gets simpler?
- What new limit appears?
- When would removal be correct?

---

## Drill 3: Tradeoff Reasoning

## Why
Senior design quality = clear, explicit tradeoffs.

## Tradeoff matrix template
| Option | Latency | Throughput | Consistency | Cost | Complexity | Decision |
|---|---|---|---|---|---|---|
| A |  |  |  |  |  |  |
| B |  |  |  |  |  |  |

## Must-practice tradeoff topics
1. SQL vs NoSQL
2. Sync vs async replication
3. Fanout-on-write vs fanout-on-read
4. REST vs gRPC
5. Monolith vs microservices

## Exercise
For each topic, defend both sides in 2 minutes each, then choose one.

---

## Drill 4: Failure Handling

## Why
Production success depends on behavior under failure, not happy path.

## Failure checklist per dependency
1. Timeout configured?
2. Retry policy defined?
3. Idempotency guaranteed?
4. Circuit breaker/bulkhead applied?
5. Degradation behavior defined?
6. Alerting metric in place?

## Failure scenarios to drill
1. DB primary down
2. Cache cluster unavailable
3. Queue lag spikes
4. Regional outage
5. Third-party payment timeout

---

## Daily 30-minute Drill Routine
1. 8 min requirements
2. 8 min estimation
3. 8 min tradeoff defense
4. 6 min failure strategy

---

## Weekly Evaluation
Score 1–5:
1. Requirement quality
2. Estimation speed/accuracy
3. Tradeoff clarity
4. Failure-depth realism

If any score < 4, repeat same drill category next week.

---

## Part II: 30 Single-Concept Drills

Each drill isolates **one concept**. Set a 10-minute timer. Produce the output. Then self-check.

---

### Topic 1 — Consistent Hashing

**Drill 1A — The Ring and Remapping**
- **Concept:** Consistent Hashing — Basic Ring
- **Time:** 10 minutes
- **Prompt:** You have 5 cache nodes. A 6th node is added. How many keys need to be remapped? Draw the ring and show the math vs. modulo hashing.
- **What to produce:** Ring diagram + percentage comparison
- **Model Answer:** With N nodes and K keys uniformly distributed, consistent hashing remaps ≈ K/N keys = 1/6 ≈ 17%. With traditional modulo hashing, adding a node remaps (N-1)/N = 5/6 ≈ 83% of keys — nearly 5x worse. The ring works because only keys between the new node and its predecessor on the ring move.
- **Self-check:**
  - [ ] Did you draw the ring with positions?
  - [ ] Did you calculate the fraction remapped vs. modulo?
  - [ ] Did you mention virtual nodes (vnodes) and why they improve load distribution?

---

**Drill 1B — Hot Spots and Virtual Nodes**
- **Concept:** Consistent Hashing — Virtual Nodes
- **Time:** 10 minutes
- **Prompt:** In a 5-node cluster, node 3 handles 40% of all requests. Why? How do 150 virtual nodes per physical node fix this?
- **What to produce:** Diagram of uneven arc + explanation of vnode distribution
- **Model Answer:** With few physical nodes, arc lengths on the ring are uneven due to hash placement variance. Node 3 happened to own a larger arc, so it receives more keys. Virtual nodes (150 per physical node) place 750 points on the ring — each physical node's total arc ≈ 1/5 of the ring regardless of hash luck. Load standard deviation drops by √(vnodes) factor.
- **Self-check:**
  - [ ] Did you explain that arc length ∝ load?
  - [ ] Did you mention the statistical argument for 150 vnodes?
  - [ ] Did you mention the downside: more ring state to track in the coordinator?

---

### Topic 2 — Caching Strategies

**Drill 2A — Cache-Aside vs. Read-Through**
- **Concept:** Cache population patterns
- **Time:** 10 minutes
- **Prompt:** You're adding a cache to a user profile service. Compare cache-aside and read-through. Which do you use if the data assembly requires joining 3 tables?
- **What to produce:** Sequence diagram for each pattern + decision
- **Model Answer:** Cache-aside: application checks cache, on miss fetches from DB and populates cache itself. Read-through: cache fetches from DB on miss — app always talks to cache only. Read-through requires the cache to hold DB credentials and query logic; cache-aside keeps that complexity in the application. For a 3-table join, cache-aside is better — the application controls the assembly logic; the cache just stores the final result.
- **Self-check:**
  - [ ] Did you draw the sequence for each pattern?
  - [ ] Did you name the tradeoff: code simplicity vs. cache-vendor coupling?
  - [ ] Did you mention TTL and eviction policy in both cases?

---

**Drill 2B — Write-Through vs. Write-Behind**
- **Concept:** Cache write strategies
- **Time:** 10 minutes
- **Prompt:** A shopping cart service writes updates frequently. Write-through causes 50ms write latency due to synchronous DB writes. What is write-behind? What risk does it introduce and how do you quantify the data-loss window?
- **What to produce:** Explanation + data-loss calculation + mitigation
- **Model Answer:** Write-behind (write-back): write to cache immediately, acknowledge to client, then flush to DB asynchronously in batches (every 100ms or 100 writes). Write latency drops to ~1ms. Risk: if cache crashes before flush, those writes are lost. With 100ms flush interval and 100K writes/sec, you can lose up to 10K writes in a crash. Mitigation: use a write-ahead log (WAL) in the cache, or write to a Redis Stream as a durable buffer that the flush worker reads.
- **Self-check:**
  - [ ] Did you quantify the data-loss window (flush interval × write rate)?
  - [ ] Did you propose a mitigation (WAL or durable queue)?
  - [ ] Did you contrast when write-behind is acceptable (cart) vs. unacceptable (payment ledger)?

---

### Topic 3 — Rate Limiting

**Drill 3A — Token Bucket Algorithm**
- **Concept:** Token bucket implementation
- **Time:** 10 minutes
- **Prompt:** Implement a token bucket for 100 requests/sec with a burst capacity of 200. Show the state and the allow/deny algorithm in pseudocode.
- **What to produce:** Data structure + ~20 lines of pseudocode
- **Model Answer:**
```python
# State per client (stored in Redis or in-memory)
bucket = {"tokens": 200, "last_refill_ts": now()}

def allow_request(client_id):
    b = get_bucket(client_id)
    elapsed = now() - b.last_refill_ts
    b.tokens = min(200, b.tokens + elapsed * 100)  # refill at 100/sec, cap at 200
    b.last_refill_ts = now()
    if b.tokens >= 1:
        b.tokens -= 1
        save(client_id, b)
        return ALLOW
    return DENY  # 429 Too Many Requests
```
Token bucket allows bursts up to bucket capacity while enforcing the long-term average. Sliding window log is more precise but stores every request timestamp (O(requests) memory).
- **Self-check:**
  - [ ] Did you show the refill calculation (elapsed × rate)?
  - [ ] Did you cap tokens at the burst limit (not infinity)?
  - [ ] Did you discuss distributed rate limiting with Redis INCR + EXPIRE?

---

**Drill 3B — Sliding Window Counter**
- **Concept:** Fixed window boundary problem
- **Time:** 10 minutes
- **Prompt:** A fixed window counter allows 1000 requests/minute per user. A client sends 1000 at 11:59 and 1000 at 12:00 — effectively 2000 in 60 seconds. Explain the sliding window approximation that fixes this.
- **What to produce:** Formula + pseudocode for weighted sliding window
- **Model Answer:** Sliding window approximation: maintain counters for the current and previous minute windows. If we're 30 seconds into the current minute: `effective_count = current_count + previous_count × (1 - 30/60)`. If `effective_count ≥ 1000`, deny. This smooths the boundary burst. It is an approximation (within ~0.1% error of the exact count) but uses O(1) storage per user vs. O(requests) for exact log-based sliding window.
- **Self-check:**
  - [ ] Did you explain the fixed window boundary problem?
  - [ ] Did you show the weighted approximation formula?
  - [ ] Did you discuss the memory tradeoff (O(1) vs. O(requests))?

---

### Topic 4 — Sharding

**Drill 4A — Range vs. Hash Sharding**
- **Concept:** Sharding strategies
- **Time:** 10 minutes
- **Prompt:** You're sharding a 1TB user table. Compare range sharding (by user_id range) and hash sharding (by hash(user_id)). When is each preferred?
- **What to produce:** Comparison table + recommendation with use case
- **Model Answer:**

| Property | Range Sharding | Hash Sharding |
|---|---|---|
| Distribution | Uneven (hot shards for active ID ranges) | Uniform (hash distributes evenly) |
| Range queries | Efficient (same shard) | Scatter-gather (all shards) |
| Rebalancing | Add shard at high-end of range | Rehash all keys (or consistent hashing) |
| Best for | Time-series data, ordered IDs | User tables, product catalogs |

For a user table with random access patterns, hash sharding. For an event log queried by time range, range sharding on timestamp.
- **Self-check:**
  - [ ] Did you explain the hot-shard problem with range sharding for sequential IDs?
  - [ ] Did you explain that range queries become scatter-gather with hash sharding?
  - [ ] Did you give a concrete use case for each?

---

**Drill 4B — Cross-Shard Queries**
- **Concept:** Handling queries that span shards
- **Time:** 10 minutes
- **Prompt:** Orders table sharded by user_id. An admin needs: "all orders placed in the last 24 hours across all users." How do you handle this efficiently?
- **What to produce:** Three approaches with tradeoffs ranked
- **Model Answer:** (1) Scatter-gather: query all N shards in parallel, merge results. Works for small N (< 20 shards) but latency = slowest shard. (2) Denormalized secondary index: maintain a `recent_orders` table (sharded by time or unsharded) updated via event stream on every order creation. Admin queries this. Eventual — up to a few seconds stale. (3) OLAP warehouse: stream all order events to BigQuery/Redshift; admin queries run there. Decouples analytics from OLTP. Best: option 2 for near-real-time admin dashboards; option 3 for complex analytics queries.
- **Self-check:**
  - [ ] Did you cover scatter-gather and name its latency concern?
  - [ ] Did you propose a denormalized secondary index?
  - [ ] Did you distinguish OLTP admin needs from OLAP analytics?

---

### Topic 5 — Replication

**Drill 5A — Sync vs. Async Replication**
- **Concept:** RPO/RTO tradeoff
- **Time:** 10 minutes
- **Prompt:** A payment service has a primary DB with one replica. Compare synchronous and asynchronous replication. Which for a payment service, and what is each one's RPO?
- **What to produce:** RPO/RTO analysis + recommendation
- **Model Answer:** Synchronous: primary waits for replica to acknowledge before confirming write. RPO = 0 (zero data loss on primary failure). Cost: write latency increases by replica RTT (1–5ms same datacenter, 50–100ms cross-region). Asynchronous: primary confirms immediately, replication in background. RPO = replication lag (seconds to minutes). No write latency overhead. For a payment service: synchronous replication within the same region — 5ms overhead is acceptable, RPO=0 is non-negotiable for financial data. For cross-region DR, async is often used (regional failure is rare enough that minutes of data loss is acceptable).
- **Self-check:**
  - [ ] Did you define RPO and RTO?
  - [ ] Did you quantify the latency cost of sync replication?
  - [ ] Did you distinguish same-region vs. cross-region scenarios?

---

**Drill 5B — Read-Your-Writes Consistency**
- **Concept:** Replication lag user impact
- **Time:** 10 minutes
- **Prompt:** User updates their profile picture, then immediately loads their profile page and sees the old picture. Why? How do you fix it without sending all reads to the primary?
- **What to produce:** Root cause + targeted solution
- **Model Answer:** The update went to the primary. The subsequent read was routed to a replica with replication lag (100–500ms). Solution: read-your-writes consistency. After a write, store in the session/cookie: `last_write_timestamp = T`. For reads within 5 seconds of T, route to the primary. Otherwise, route to replica. This ensures users always read their own writes while still routing 95%+ of reads to replicas (users rarely read immediately after writing). Alternative: sticky sessions — route a given user's reads to the same replica for 5 seconds after a write.
- **Self-check:**
  - [ ] Did you explain why the read hit the replica?
  - [ ] Did you propose the timestamp-based primary routing?
  - [ ] Did you quantify what % of requests still hit the primary (low)?

---

### Topic 6 — Load Balancing

**Drill 6A — Load Balancing Algorithms**
- **Concept:** Round-robin vs. weighted vs. least-connections
- **Time:** 10 minutes
- **Prompt:** Three backend servers: A is twice as fast as B and C (same hardware, A has fewer background jobs). Compare round-robin, weighted round-robin, and least-connections. Which is best here?
- **What to produce:** Algorithm comparison + recommendation
- **Model Answer:** Round-robin: 33% each — wastes A's capacity; A sits idle waiting for B and C. Weighted round-robin: A=50%, B=25%, C=25% — better, but doesn't adapt to request duration variation. Least-connections: routes to server with fewest in-flight requests. A processes faster → always has fewer in-flight → gets more new requests automatically. Best for heterogeneous servers and variable request durations. Recommendation: least-connections, because it adapts to actual throughput rather than static weights.
- **Self-check:**
  - [ ] Did you explain why round-robin underutilizes fast servers?
  - [ ] Did you explain why least-connections is self-adapting?
  - [ ] Did you mention consistent hashing for sticky session use cases?

---

**Drill 6B — L4 vs. L7 Load Balancing**
- **Concept:** Protocol-aware routing
- **Time:** 10 minutes
- **Prompt:** When would you choose L4 (TCP) load balancing over L7 (HTTP) load balancing? Give a concrete use case for each.
- **What to produce:** Comparison with real examples
- **Model Answer:** L4: routes based on TCP connection (IP/port) without inspecting payload. Extremely fast — no HTTP parsing. Use case: load-balancing MySQL connections. L7 doesn't understand MySQL binary protocol; L4 routes raw TCP connections to MySQL replicas. L7: parses HTTP. Can route by URL path (`/api` → service A, `/images` → service B), headers, cookies. Enables SSL termination, A/B testing, sticky sessions. Use case: microservices API gateway routing `/users` to user service and `/orders` to order service, terminating TLS at the load balancer so backend services get plain HTTP.
- **Self-check:**
  - [ ] Did you explain the packet inspection difference?
  - [ ] Did you give a non-HTTP use case for L4 (MySQL, raw TCP protocol)?
  - [ ] Did you mention SSL termination as an L7 capability?

---

### Topic 7 — Message Queues

**Drill 7A — Queue vs. Pub-Sub Topic**
- **Concept:** Consumer group semantics
- **Time:** 10 minutes
- **Prompt:** An order service needs to trigger three downstream actions: inventory update, email notification, analytics logging. Should you use SQS-style queue or Kafka-style topic? Why?
- **What to produce:** Decision with consumer group explanation
- **Model Answer:** SQS queue: one message consumed by one consumer. To fan out to 3 services, you'd need 3 queues or an SNS fan-out layer — added complexity. Kafka topic: one message consumed by multiple consumer groups independently. Inventory, email, and analytics each have their own consumer group reading the same `order.created` topic. They progress independently — analytics lag doesn't block email delivery. For this use case: Kafka topic. Use a queue (SQS) when work units must be processed exactly-once by exactly one worker (background job processing, task queues).
- **Self-check:**
  - [ ] Did you explain consumer group independence?
  - [ ] Did you identify the fan-out complexity problem with queues?
  - [ ] Did you identify when queues are the right choice (work queue pattern)?

---

**Drill 7B — Idempotent Consumer**
- **Concept:** At-least-once delivery problem
- **Time:** 10 minutes
- **Prompt:** A payment confirmation message is consumed, worker sends confirmation email, then crashes before acknowledging. Message is re-delivered → duplicate email sent. How do you prevent this?
- **What to produce:** Idempotency mechanism with deduplication store
- **Model Answer:** This is the at-least-once delivery problem: messages are guaranteed delivered but may come more than once. Make the consumer idempotent. Before sending email: check `email_sent_for(payment_id)` in Redis. If found, skip. Otherwise: send email, then store `email_sent:{payment_id}` in Redis with TTL=24h, then acknowledge the message. Even if re-delivered, the second execution finds the record and skips. SQS FIFO queues provide built-in deduplication via MessageDeduplicationId.
- **Self-check:**
  - [ ] Did you explain why at-least-once causes duplicates?
  - [ ] Did you propose a deduplication store (Redis with TTL)?
  - [ ] Did you handle the ordering of: send → store → ack (not ack before store)?

---

### Topic 8 — CDNs

**Drill 8A — Cache Miss Storm**
- **Concept:** CDN thundering herd
- **Time:** 10 minutes
- **Prompt:** A CDN edge node restarts with empty cache. 10,000 users simultaneously request `/homepage`. All miss CDN and hit your origin server. How do you prevent the origin from getting overwhelmed?
- **What to produce:** Two mitigation strategies with how they work
- **Model Answer:** (1) Request coalescing: CDN forwards only ONE request to origin for simultaneous misses on the same URL, holds other requests, and delivers the cached response to all when origin replies. Supported natively by Cloudflare, Fastly. (2) Origin shield: a single regional "shield" node sits between CDN edges and origin. All CDN edge nodes check the shield before hitting origin. Shield has a warm cache; only shield-to-origin traffic spikes on a miss — not N edge nodes simultaneously.
- **Self-check:**
  - [ ] Did you explain request coalescing (also called request collapsing)?
  - [ ] Did you explain origin shield topology?
  - [ ] Did you mention that this is also called "thundering herd" or "cache stampede"?

---

**Drill 8B — Cache Invalidation**
- **Concept:** Dynamic content invalidation
- **Time:** 10 minutes
- **Prompt:** Product page cached at CDN with TTL=1 hour. Product price changes. How do you update all cached copies within 30 seconds?
- **What to produce:** Three strategies, ranked
- **Model Answer:** (1) CDN purge API: call CDN's purge API with the URL `/products/123` on price change. Cloudflare propagates purge to all edges in ~15 seconds. (2) Surrogate/cache tags: tag the cache entry with `product-123`. On price change, purge all entries tagged `product-123`. Handles the case where `/products/123`, `/category/sneakers`, and `/search?q=shoes` all render product 123. (3) `stale-while-revalidate`: `Cache-Control: max-age=30, stale-while-revalidate=3600`. CDN serves stale for 30s while asynchronously fetching fresh content. No purge needed but content may be stale for 30s. Best for this case: surrogate keys — a price change affects multiple page URLs.
- **Self-check:**
  - [ ] Did you cover the purge API approach?
  - [ ] Did you explain surrogate keys for multi-URL invalidation?
  - [ ] Did you mention `stale-while-revalidate` as a zero-purge option?

---

### Topic 9 — Database Indexes

**Drill 9A — B-Tree vs. Hash Index**
- **Concept:** Index type selection
- **Time:** 10 minutes
- **Prompt:** Indexing a `users` table. Query A: `WHERE email = 'x@y.com'`. Query B: `WHERE created_at BETWEEN '2024-01-01' AND '2024-03-31'`. Which index type for each and why?
- **What to produce:** Recommendation with explanation of each index's limitations
- **Model Answer:** Hash index: O(1) equality lookups. Cannot support range queries — hash function destroys ordering information. Use for Query A (exact email match). B-tree index: ordered tree, O(log N) for equality AND supports ranges, `BETWEEN`, `ORDER BY`, `LIKE 'prefix%'`. Use for Query B (date range). In PostgreSQL, the default index type is B-tree. Hash indexes are only worth the tradeoff if you need slightly faster equality and are 100% certain you'll never need range queries on that column. In practice: always start with B-tree.
- **Self-check:**
  - [ ] Did you explain why hash indexes can't support range queries?
  - [ ] Did you mention that B-tree also supports `ORDER BY` efficiently?
  - [ ] Did you mention composite indexes for multi-column queries?

---

**Drill 9B — Index Selectivity and Covering Indexes**
- **Concept:** When indexes help vs. hurt
- **Time:** 10 minutes
- **Prompt:** You add an index on `status` in an `orders` table (values: 'pending', 'completed', 'failed'). 95% of rows are 'completed'. Why does the query planner ignore this index for `WHERE status='completed'`? What is a covering index?
- **What to produce:** Selectivity explanation + covering index definition with example
- **Model Answer:** Index selectivity = distinct values / total rows ≈ 3 / 1,000,000 = 0.000003. The query `WHERE status='completed'` returns 950K of 1M rows. Reading an index then fetching 950K rows via random I/O is more expensive than a single sequential table scan. The optimizer correctly ignores the index. The index IS useful for low-frequency values ('pending', 'failed'). Covering index: includes all columns the query needs so the DB never reads the actual row. Example: `CREATE INDEX idx ON orders(user_id, status) INCLUDE (amount, created_at)`. Query `SELECT amount, created_at FROM orders WHERE user_id=5 AND status='pending'` is fully answered from the index — no table access, significantly less I/O.
- **Self-check:**
  - [ ] Did you explain selectivity and why the optimizer skips the index?
  - [ ] Did you explain that covering index avoids table row fetches?
  - [ ] Did you show a concrete CREATE INDEX example?

---

### Topic 10 — SQL vs. NoSQL

**Drill 10A — When to Choose NoSQL**
- **Concept:** Access pattern determines storage
- **Time:** 10 minutes
- **Prompt:** User activity feed (events: "liked post X", "followed Y"). Compare PostgreSQL vs. Cassandra. Which, and at what write throughput does the decision flip?
- **What to produce:** Access pattern analysis + quantified threshold
- **Model Answer:** Activity feed pattern: write-heavy (every user action = event), read pattern is `WHERE user_id=X ORDER BY timestamp DESC LIMIT 50`. PostgreSQL: index on `(user_id, timestamp)` handles reads efficiently. At 50K writes/sec, PostgreSQL is manageable with tuning. Cassandra: partition key=`user_id`, clustering key=`timestamp DESC`. Designed for exactly this pattern. Handles 1M+ writes/sec across a cluster with no single write bottleneck. No joins, no transactions. Decision: start with PostgreSQL (simpler to operate). When write throughput consistently exceeds what a single PostgreSQL primary can sustain (typically 30–50K writes/sec), migrate to Cassandra.
- **Self-check:**
  - [ ] Did you analyze the specific read and write patterns?
  - [ ] Did you give a quantitative threshold for the decision (not just "at scale")?
  - [ ] Did you mention Cassandra's tradeoffs (no joins, no transactions)?

---

**Drill 10B — Denormalization**
- **Concept:** When to denormalize
- **Time:** 10 minutes
- **Prompt:** A product page requires joining products, sellers, and reviews tables. At 11.5 product page views/sec (1M/day), is this a problem? At what point does denormalization become necessary?
- **What to produce:** QPS calculation + denormalization strategy with staleness tradeoff
- **Model Answer:** 11.5 QPS with a proper 3-table join using indexes: ~5ms per query. A single DB instance handles this at > 500 QPS. No denormalization needed at this scale. At 10K views/sec on a product page: 3-table join becomes the bottleneck, each taking 5ms = 5ms × 10K = 50,000ms of DB CPU per second. Denormalize: cache assembled product_page document in Redis. Update asynchronously when any source table changes (product, seller, reviews). Tradeoff: seller rating could be minutes stale; invalidate cache via write-through or short TTL (5 minutes). Rule: measure first, denormalize only when you have a measured bottleneck.
- **Self-check:**
  - [ ] Did you compute the actual QPS before concluding it's a problem?
  - [ ] Did you propose a concrete denormalization strategy?
  - [ ] Did you explicitly state the staleness tradeoff?

---

### Topic 11 — CAP Theorem

**Drill 11A — CP vs. AP with Product Impact**
- **Concept:** CAP applied to product decisions
- **Time:** 10 minutes
- **Prompt:** Chat service on a distributed DB. During a network partition, should the system (a) reject writes and stay consistent, or (b) accept writes and risk inconsistency? Justify with product impact.
- **What to produce:** CP vs. AP analysis tied to user experience
- **Model Answer:** CP during partition: reject writes. User sees "message failed to send." Consistent — no stale messages — but message delivery is blocked during any network hiccup. AP during partition: accept writes to whichever partition is reachable. After healing, merge writes (last-write-wins or conflict resolution). Messages may arrive out-of-order but are never blocked. For a chat service: choose AP. Users tolerate slightly out-of-order messages far more than being unable to send messages at all. WhatsApp uses AP semantics. For a payment ledger: choose CP. A failed transaction is better than a double charge or inconsistent balance.
- **Self-check:**
  - [ ] Did you articulate the product impact of each choice (not just "consistent" or "available")?
  - [ ] Did you cite a real-world example for each?
  - [ ] Did you avoid the false claim that CAP means you can only have 2 of 3 — it applies only during partitions?

---

**Drill 11B — PACELC Extension**
- **Concept:** Behavior outside partitions
- **Time:** 10 minutes
- **Prompt:** Explain PACELC and why it's more useful than CAP for day-to-day database design decisions. Apply it to DynamoDB.
- **What to produce:** PACELC definition + DynamoDB classification
- **Model Answer:** CAP addresses behavior during partitions only. PACELC adds: "in the Else (absence of partition), there is a tradeoff between Latency (L) and Consistency (C)." Most systems don't experience partitions most of the time, making the EL vs. EC tradeoff more operationally relevant. DynamoDB: PA/EL — during Partitions, chooses Availability (accepts writes to available replicas). In normal operation, chooses Latency (fast eventually-consistent reads from nearest replica). This is a strong choice for user-facing apps where latency matters. PostgreSQL with sync replication: PC/EC — chooses Consistency in both cases, accepting higher latency. PACELC forces you to specify both scenarios explicitly.
- **Self-check:**
  - [ ] Did you explain the E (else — no partition) part of PACELC?
  - [ ] Did you apply it to a real database with correct classification?
  - [ ] Did you explain why the EL vs. EC tradeoff is more frequently encountered than the partition case?

---

### Topic 12 — Distributed Transactions

**Drill 12A — Two-Phase Commit**
- **Concept:** 2PC protocol and failure modes
- **Time:** 10 minutes
- **Prompt:** Order service must atomically debit a user's wallet AND create an order record across two different databases. Explain 2PC's phases and its critical failure mode.
- **What to produce:** 2PC protocol steps + blocking failure scenario
- **Model Answer:** Phase 1 (Prepare): coordinator sends "prepare" to all participants (wallet DB, order DB). Each locks resources, writes a "prepare" record to its WAL, responds "ready" or "abort." Phase 2 (Commit): if all "ready," coordinator sends "commit" to all; all commit and release locks. If any "abort," coordinator sends "abort" to all. Critical failure: coordinator crashes after receiving all "ready" but before sending "commit." All participants are stuck with locked resources, waiting indefinitely for the coordinator to recover. This is 2PC's blocking problem — participants cannot make progress without the coordinator. Alternative: Saga pattern (local transactions + compensating transactions on failure) — avoids distributed locking.
- **Self-check:**
  - [ ] Did you describe both phases clearly?
  - [ ] Did you identify the coordinator-crash blocking problem specifically?
  - [ ] Did you mention the Saga pattern as the alternative?

---

**Drill 12B — Saga Pattern**
- **Concept:** Compensating transactions
- **Time:** 10 minutes
- **Prompt:** E-commerce order flow: reserve inventory → charge payment → confirm order. Use the Saga pattern. What happens if payment fails?
- **What to produce:** Saga sequence + compensation steps for each failure point
- **Model Answer:**
```
Forward steps:
1. Inventory: reserve(items)       → success → emit InventoryReserved
2. Payment:   charge(user, amount) → success → emit PaymentCharged
3. Order:     confirm(order)       → success → emit OrderConfirmed

Compensation steps (reversed on failure):
- Payment fails:  → run inventory.release(items)
- Order fails:    → run payment.refund(user, amount) → then inventory.release(items)

Choreography: each service listens to events, publishes next step or failure event.
Orchestration: a Saga Orchestrator calls each step explicitly — easier to reason about for complex flows.
```
Saga achieves eventual consistency — not atomicity. At any point, you may see a partial state (inventory reserved, payment not yet charged). Design your data model to handle these intermediate states gracefully.
- **Self-check:**
  - [ ] Did you identify all compensation steps?
  - [ ] Did you distinguish orchestration vs. choreography?
  - [ ] Did you state that Saga provides eventual consistency, not ACID atomicity?

---

### Topic 13 — Idempotency

**Drill 13A — Idempotency Key Design**
- **Concept:** Safe payment retries
- **Time:** 10 minutes
- **Prompt:** A payment API must be idempotent — retrying the same payment must not charge twice. Design the idempotency key mechanism: schema, algorithm, TTL.
- **What to produce:** Complete algorithm with edge cases
- **Model Answer:**
```
POST /payments
Header: Idempotency-Key: <client-generated UUID>

Algorithm:
1. Lookup idempotency_key in Redis
2. If COMPLETED: return stored response (do not re-execute)
3. If IN_PROGRESS: return 409 Conflict (concurrent retry)
4. If NOT FOUND:
   a. Write {key, status=IN_PROGRESS, created_at} → Redis
   b. Execute payment logic
   c. Write {key, status=COMPLETED, response_body} → Redis (TTL=24h)
   d. Return response

Redis key: idempotency:{key} → {status, response, created_at} TTL=24h
```
The client generates the UUID before the first call and reuses it for retries. After 24h, the same key is treated as a new payment (idempotency window expired). The IN_PROGRESS check prevents a race condition where two concurrent retries both pass step 1 and both execute the payment.
- **Self-check:**
  - [ ] Did you handle the IN_PROGRESS concurrent retry case?
  - [ ] Did you set a TTL (and explain why 24h)?
  - [ ] Did you clarify that the client generates the key?

---

**Drill 13B — Idempotent Event Consumers**
- **Concept:** Kafka rebalance duplicate processing
- **Time:** 10 minutes
- **Prompt:** A Kafka consumer processes inventory update events. Due to consumer group rebalance, the same event is processed twice. Two approaches to make the consumer idempotent?
- **What to produce:** Two strategies with tradeoffs
- **Model Answer:** (1) Natural idempotency: design the operation so running it twice produces the same result. Instead of `quantity = quantity - 10` (delta), use `quantity = @new_absolute_value WHERE version = @expected_version` (optimistic locking). If already applied, the version won't match — update is a safe no-op. (2) Deduplication table: before processing, check `processed_events(event_id)`. If found, skip. If not found, process and insert event_id. Must be done atomically in one DB transaction. Pruning: delete events older than Kafka's max retention window. Tradeoff: natural idempotency is simpler and faster; deduplication table works for operations that can't be made naturally idempotent (sending emails, external API calls).
- **Self-check:**
  - [ ] Did you explain natural idempotency (absolute value vs. delta)?
  - [ ] Did you show the deduplication table approach?
  - [ ] Did you mention atomic check-and-insert + TTL/pruning?

---

### Topic 14 — API Design

**Drill 14A — REST vs. gRPC**
- **Concept:** Internal vs. external API protocol
- **Time:** 10 minutes
- **Prompt:** Internal microservices communicate at 50K RPC/sec. Compare REST/JSON and gRPC/Protobuf on payload size, parse overhead, and streaming. Which do you choose for internal communication?
- **What to produce:** Comparison table + recommendation with reasoning

| Property | REST/JSON | gRPC/Protobuf |
|---|---|---|
| Payload size | ~200 bytes (text JSON) | ~50 bytes (binary protobuf) |
| Parse overhead | ~0.5ms JSON parse | ~0.05ms protobuf decode |
| Streaming | No native support | Bidirectional streaming |
| Browser support | Native | Needs grpc-web proxy |
| Code generation | Manual / OpenAPI | Auto from .proto file |
| Error model | HTTP status codes | Rich status + metadata |

- **Model Answer:** At 50K RPC/sec internally: choose gRPC. 4x smaller payloads + 10x faster parsing = meaningful CPU and bandwidth savings at this volume. Strong typing from protobuf catches API contract bugs at compile time. Bidirectional streaming enables real-time server push without polling. Use REST for external/public APIs where browser compatibility and human readability matter more than performance.
- **Self-check:**
  - [ ] Did you quantify the payload size difference?
  - [ ] Did you mention bidirectional streaming as a gRPC differentiator?
  - [ ] Did you recommend REST for public-facing APIs?

---

**Drill 14B — API Pagination**
- **Concept:** Offset vs. cursor pagination
- **Time:** 10 minutes
- **Prompt:** Paginating a user's order history (newest first). Why does offset pagination break at scale? Show cursor-based pagination implementation.
- **What to produce:** Both implementations + failure analysis
- **Model Answer:** Offset: `SELECT ... LIMIT 20 OFFSET 100`. Problem 1: if a new order is inserted between page 1 and page 2 requests, all items shift — page 2 returns a duplicate from page 1. Problem 2: at OFFSET 20,000, DB scans and discards 20,000 rows — O(N) work. Cursor-based: `GET /orders?cursor=<last_seen_order_id>` → `SELECT * FROM orders WHERE user_id=X AND id < {cursor} ORDER BY id DESC LIMIT 20`. Cursor encodes position (last item's ID). Uses an index — O(log N). Stable under concurrent inserts — no duplicates. Downside: can't jump to page 50 directly. Best for infinite scroll and feeds; offset is acceptable for small datasets where direct-page navigation is needed.
- **Self-check:**
  - [ ] Did you explain the duplicate-on-insert problem with offset?
  - [ ] Did you explain the O(N) scan with large offsets?
  - [ ] Did you explain what the cursor encodes and how the WHERE clause uses it?

---

### Topic 15 — Capacity Estimation

**Drill 15A — Multi-Tier Storage Estimation**
- **Concept:** Photo storage with tiering
- **Time:** 10 minutes
- **Prompt:** Instagram: 100M photos uploaded per day. Each stored in 3 sizes (3MB original, 500KB medium, 100KB thumbnail). Estimate yearly storage and S3 cost with storage tiering.
- **What to produce:** Full calculation with cost optimization
- **Model Answer:**
```
Per photo: 3MB + 0.5MB + 0.1MB = 3.6MB
Daily storage: 100M × 3.6MB = 360TB/day
Yearly: 360TB × 365 = 131.4PB ≈ 132PB

S3 Standard: $0.023/GB/month
Gross cost: 132,000,000 GB × $0.023 × 12 = $36.4M/year

Optimization: 90% of photos are rarely accessed (Pareto)
After 90 days, move to S3 Glacier ($0.004/GB/month)
Tiered effective rate ≈ 0.1 × $0.023 + 0.9 × $0.004 = $0.0059/GB/month
Tiered yearly cost: 132,000,000 GB × $0.0059 × 12 ≈ $9.3M/year (vs. $36.4M gross)
```
- **Self-check:**
  - [ ] Did you account for all 3 image sizes?
  - [ ] Did you calculate yearly total (not just daily)?
  - [ ] Did you mention storage tiering (hot vs. cold) for cost optimization?

---

**Drill 15B — QPS and Bandwidth Estimation**
- **Concept:** Read vs. write QPS calculation
- **Time:** 10 minutes
- **Prompt:** Twitter: 500M tweets/day, 300M DAU, 3 sessions/day, 100 tweets loaded per session. Estimate write QPS, read QPS, read/write ratio, and daily read bandwidth.
- **What to produce:** Full calculation with all four outputs
- **Model Answer:**
```
Write QPS:
500M / 86,400 ≈ 5,787 ≈ 6K writes/sec

Read QPS:
Sessions/day: 300M × 3 = 900M
Tweets loaded: 900M × 100 = 90B tweet reads/day
Read QPS: 90B / 86,400 ≈ 1,041,666 ≈ 1M reads/sec

Read/Write ratio: 1M / 6K ≈ 167:1 (extremely read-heavy → justifies heavy caching)

Daily read bandwidth (text):
90B reads × 1KB/tweet = 90TB/day text

Daily read bandwidth (media):
30% of tweets have images (avg 500KB)
But CDN cache hit rate ≈ 99% → origin sees 1%
Media reads from origin: 90B × 0.30 × 500KB × 0.01 = 135TB/day from origin
CDN serves 99%: 90B × 0.30 × 500KB × 0.99 = 13,365TB/day from CDN edge
```
- **Self-check:**
  - [ ] Did you compute both write and read QPS separately?
  - [ ] Did you compute the read/write ratio and interpret it?
  - [ ] Did you separate CDN traffic from origin traffic for media?

---

## Part III: Speed Drills — Estimate in 2 Minutes

Set a 2-minute timer. Show your work. These train estimation reflexes.

---

### Speed Drill 1: Twitter Storage per Year

**Prompt:** *"Twitter sends 500M tweets/day. How much storage per year?"*

**Solution:**
```
Per tweet: 280 chars × 2 bytes ≈ 560 bytes + metadata ≈ 1KB
Daily storage: 500M × 1KB = 500GB/day
Yearly: 500GB × 365 = 182TB/year ≈ 200TB/year raw text

With replication factor 3: 600TB/year
With LZ4 compression (tweets compress ~5:1): 120TB/year effective disk

Key anchor: 500M × 1KB = 500GB/day. Everything else multiplies from there.
```

---

### Speed Drill 2: YouTube Storage Cost

**Prompt:** *"YouTube: 500 hours of video uploaded per minute. Storage cost?"*

**Solution:**
```
Upload rate: 500 hours/minute
Compressed HD video: ~2GB/hour at H.264
YouTube stores 5 quality levels → ~3.5GB total per hour of video

Data uploaded per minute:
500 hours × 3.5GB = 1,750GB = 1.75TB/minute

Per day: 1.75TB × 60 × 24 = 2,520TB ≈ 2.5PB/day
Per year: 2.5PB × 365 ≈ 912PB ≈ 1 exabyte/year

S3 cost: $0.023/GB/month
1EB = 1,000,000TB = 1,000,000,000GB × $0.023 × 12 ≈ $276M/year
(YouTube uses custom hardware at ~1/10th S3 cost = ~$27M/year)

Key insight: multi-resolution transcoding multiplies storage by ~3.5x.
```

---

### Speed Drill 3: WhatsApp Bandwidth

**Prompt:** *"WhatsApp: 100B messages/day. Bandwidth?"*

**Solution:**
```
Average message size (weighted):
  60% text (200 bytes): 0.6 × 200B = 120B
  30% image (100KB):    0.3 × 100KB = 30KB
  10% video (1MB):      0.1 × 1MB = 100KB
Weighted average: ≈ 130KB per message

Daily data: 100B × 130KB = 13 × 10^15 bytes = 13PB/day
Daily bandwidth: 13PB / 86,400 sec = 150GB/sec ≈ 1.2 Tbps

For context: one 10GbE NIC = 10Gbps. Need 120 × 10GbE NICs worth of bandwidth.
WhatsApp uses CDN + end-to-end direct delivery (P2P where possible) to reduce server bandwidth.

Key insight: media (30% of messages) dominates bandwidth due to 500x size difference vs. text.
```

---

### Speed Drill 4: Uber Location Update Writes

**Prompt:** *"Uber: 3M trips/day, 5 location updates/sec per driver. Location update writes/sec?"*

**Solution:**
```
Trips/day: 3M
Average trip duration: 20 minutes
Concurrent trips at any moment:
  3M trips × 20min / 1,440min per day = 41,667 ≈ 42K concurrent trips

Location updates/sec:
  42K drivers × 5 updates/sec = 210K writes/sec

Add riders during pickup (driver + rider both tracked):
  Assume 50% of trips in pickup phase: 210K × 1.5 ≈ 315K writes/sec

Storage per update: (trip_id, lat, long, timestamp) ≈ 50 bytes
Write throughput: 315K × 50B = 15.75MB/sec (very manageable)
Daily storage: 15.75MB/sec × 86,400 = 1.36TB/day of location data

Key insight: daily trips ≠ concurrent trips. Use (avg duration / minutes per day) for concurrency.
```

---

## Part IV: "Fix This Design" Exercises

Each exercise gives you a broken design. Identify every bottleneck or gap, then propose a fixed architecture.

---

### Broken Design 1: Single DB, No Cache, Synchronous Image Processing

**The Broken Design:**
```
Mobile App → API Server → Single PostgreSQL (stores users, posts, images as BLOBs)
                        ↓
             Image resize: done synchronously on API server (5–10 seconds CPU)
```

**Your Task:** Identify all bottlenecks. Fix each one.

**Identified Bottlenecks:**

1. **Images stored as BLOBs in PostgreSQL:** Binary large objects in a relational DB fill storage rapidly, consume DB CPU for I/O, and make backup impractical. Fix: store images in S3/object storage, store only the URL in PostgreSQL.

2. **Synchronous image processing on API thread:** A 5–10 second CPU-bound task blocks the thread. With 100 concurrent uploads, all API threads are occupied. API becomes unresponsive for other requests. Fix: return immediately to client after raw upload, process asynchronously. Publish resize job to SQS; background workers consume and process.

3. **Single database:** No read replicas. All reads + writes go to one node. At 1M DAU with heavy photo browsing, read QPS will saturate the single instance. Fix: add read replica(s); route all SELECT queries to replicas.

4. **No cache:** Every feed load hits the DB. A user's feed changes rarely in 5 minutes. Fix: cache feed in Redis, key=`feed:{user_id}`, TTL=5 minutes. Invalidate on new post.

5. **No CDN:** All image requests hit the API/DB. Fix: serve images from S3 via CloudFront. Images are immutable after upload — infinite CDN TTL is safe.

**Fixed Architecture:**
```
Mobile App
  → API Server (stateless, horizontally scalable)
      → PostgreSQL primary (writes: posts, users, S3 URLs only)
      → PostgreSQL replica (reads: feed queries, user lookups)
      → Redis (feed cache, session store)
      → SQS (image resize job queue)
  → S3 (raw + processed image storage)
      → CloudFront CDN (serves images to clients at edge)
  → Image Processing Workers (resize, thumbnail → write back to S3 + update DB)
```

---

### Broken Design 2: No Rate Limiting, No Auth, No Monitoring

**The Broken Design:**
```
Internet → API Server → Database
```
Public API endpoints:
- `GET /users/{id}` — returns user profile
- `POST /messages` — sends a message (accepts arbitrary body)
- `DELETE /content/{id}` — deletes content

No authentication, no authorization, no rate limiting, no logging, no metrics.

**Your Task:** Identify every gap. Add the missing pieces.

**Identified Gaps + Fixes:**

1. **No Authentication:** Any caller hits any endpoint. Fix: JWT/OAuth2 at the API Gateway. Every request must include a valid Bearer token. Gateway validates and rejects 401 otherwise.

2. **No Authorization:** Even authenticated, user A can delete user B's content with `DELETE /content/456`. Fix: authorization check in service layer — `if content.owner_id != token.user_id: raise 403 Forbidden`.

3. **No Rate Limiting:** One client sends 10M req/sec, taking down the service for everyone. Fix: token bucket at API Gateway — 100 req/min for free tier, 10K req/min for authenticated users. Per-IP limit to block unauthenticated abuse.

4. **No Input Validation:** `POST /messages` with a 1GB body crashes the server. Fix: validate `Content-Length` header (reject > 64KB for messages). Sanitize all string inputs against SQL injection and XSS.

5. **No Monitoring:** Outage discovered from Twitter, not alerts. Fix:
   - Prometheus metrics: `request_count`, `error_rate`, `p99_latency` per endpoint
   - Alerting: error rate > 1% for 5 minutes → PagerDuty
   - Structured logging: every request logs `{request_id, user_id, endpoint, status_code, duration_ms}`

6. **No Circuit Breaker on DB:** If DB goes down, API keeps accepting requests and piling up connections until OOM. Fix: Circuit breaker wrapper on all DB calls. If DB error rate > 50% in 10 seconds, open circuit, return 503 immediately without hitting DB.

**Fixed Architecture:**
```
Internet
  → Cloudflare (DDoS protection, WAF, TLS termination)
  → API Gateway (rate limiting per IP + per user, JWT validation)
  → API Server (business logic, authorization, input validation)
      → PostgreSQL (circuit-breaker protected, connection pool max=50)
  → Prometheus + Grafana (metrics dashboard)
  → ELK / Loki (structured log aggregation)
  → PagerDuty (alert routing)
```

---

### Broken Design 3: Synchronous Microservice Chain (A → B → C → D)

**The Broken Design:**
```
Client → Service A (order)
  → sync HTTP → Service B (inventory)
    → sync HTTP → Service C (payment)
      → sync HTTP → Service D (notification)
```
Each call p99 = 100ms. All calls are synchronous and blocking.

**Your Task:** Identify all failure modes. Redesign with circuit breakers and async where appropriate.

**Failure Modes:**

1. **Cascading failure:** D goes down → C waits (30s timeout) → B waits → A waits → Client gets a 30-second timeout. One downstream service failure propagates upward and destroys the entire chain.

2. **Latency multiplication:** Series p99 = 100ms × 4 = 400ms. Tail latency compounds — if each service has 1% chance of 1s response, the chain has ~4% chance of a 1s+ response (1 − 0.99^4 = 3.94%).

3. **Notification blocking order completion:** Sending a notification (D) is a non-critical side effect. If D fails, the order should still succeed and the notification retried asynchronously.

4. **Retry storms:** If C fails, A retries, B retries — simultaneous retry floods hit C on recovery, causing thundering herd.

**Fixes:**

1. **Circuit breakers on every synchronous call:** Each service wraps downstream calls with a circuit breaker (3-state: Closed/Open/Half-Open). If D errors > 50% in 10s, C's circuit to D opens — fast-fail in < 5ms. Order completes without notification (degraded mode). Circuit re-probes every 30s.

2. **Separate critical path from non-critical:**
   - Critical (synchronous): A → B (inventory reserve) → C (payment charge)
   - Non-critical (asynchronous): After C confirms, A publishes `OrderConfirmed` event to Kafka. D consumes asynchronously — decoupled from order completion.
   - Order total latency: A(50ms) + B(50ms) + C(100ms) = 200ms. Notification delayed by seconds but order completes fast.

3. **Retry with exponential backoff + jitter:** Retries from A to B use: 1s, 2s, 4s backoff + ±500ms random jitter. Jitter desynchronizes retry waves and prevents thundering herd on recovery.

**Fixed Architecture:**
```
Client → Service A (order)
  → sync + circuit breaker → Service B (inventory reserve)
  → sync + circuit breaker → Service C (payment charge)
  → publish to Kafka: OrderConfirmed
      → async → Service D (notification) [non-blocking, retried by Kafka consumer]

Circuit breaker states:
  CLOSED    (normal): requests pass through
  OPEN      (failure, error rate > 50% in 10s): fast-fail, no downstream call
  HALF-OPEN (recovery probe): one test request every 30s; close on success
```
