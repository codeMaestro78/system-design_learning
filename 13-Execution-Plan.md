# Step-by-Step Execution Plan (From Beginner to Mastery)

## Phase 1: Fundamentals
Study:
- `01-Foundations.md`
- `02-Networking-Basics.md`
- `03-Data-and-Storage.md`

Output:
- Written notes for every topic in the 10-step learning format.
- One architecture comparison: small app vs internet-scale app.

Gate to next phase:
- You can explain CAP/PACELC and isolation levels with real examples.

---

## Phase 2: Core Components and Patterns
Study:
- `04-Core-Components.md`
- `05-Architecture-Patterns.md`
- `06-Scaling-Systems.md`

Output:
- Design doc for a medium-scale backend including caching, queue, load balancer, rate limiter.

Gate:
- You can explain bottleneck and failure handling for each component.

---

## Phase 3: Real-World Design Practice
Study:
- `07-Real-World-System-Designs.md`
- `07a` to `07i` files

Output:
- Complete writeup for all 9 systems using the same framework.

Gate:
- You can do one 45-minute mock design with clear tradeoffs.

---

## Phase 4: Build Projects
Study and implement:
- `08-Hands-On-Projects.md`
- `08a` to `08g` files

Output:
- Working implementations with tests, metrics, and docs.

Gate:
- You can explain what failed under load and what fix improved it.

---

## Phase 5: Advanced + Production Readiness
Study:
- `09-Advanced-Distributed-Topics.md`

## Sophisticated Execution Roadmap

### Month 1: Foundations and Mental Models
- Build intuition for latency, QPS, storage growth, and failure.
- Study how a browser request reaches a backend service.
- Compare SQL, document, key-value, search, stream, and object stores.
- Deliverable: design a simple blogging platform at 1k, 100k, and 10M users.

### Month 2: Core Components
- Build and explain cache, rate limiter, queue, idempotency store, and circuit breaker.
- Study real failure modes: cache stampede, retry storm, hot key, poison message.
- Deliverable: improve `nodejs-system-design-lab/` and write tests for each component.

### Month 3: Product Systems
- Design Twitter/X, Instagram, WhatsApp, YouTube, Uber, Netflix, and Search.
- For each design, include schema, APIs, HLD, LLD, failure handling, cost model, and metrics.
- Deliverable: one polished design doc per system.

### Month 4: Distributed Depth
- Study consensus, leader election, stream processing, CDC, multi-region replication, CRDTs, and distributed locks.
- Deliverable: design a multi-region feature flag system and explain consistency choices.

### Month 5: Production Engineering
- Run load tests, profile latency, define SLOs, and create runbooks.
- Deliverable: production-readiness review for each hands-on project.

### Month 6: Interview and Staff-Level Communication
- Practice timed mocks.
- Defend tradeoffs.
- Explain product evolution from MVP to hyperscale.
- Deliverable: 10 recorded mock designs and written retrospectives.

## Portfolio-Grade Deliverables

For each major system, create:

- Requirements and explicit exclusions.
- Capacity estimate.
- API contracts.
- Data model and indexes.
- Architecture diagram.
- Critical path deep dive.
- Failure modes and recovery.
- Observability dashboard.
- Security and abuse plan.
- Cost and scaling plan.
- Future evolution roadmap.

## Rigorous Milestone Gates

### Phase gate: fundamentals
You pass only if you can design a simple service three ways:
- Single-node MVP.
- Horizontally scaled regional service.
- Multi-region resilient service.

### Phase gate: core components
You pass only if you can explain:
- Cache invalidation and stampede prevention.
- Queue retries, visibility timeout, and DLQ.
- Rate limiter fail-open versus fail-closed.
- API gateway responsibilities.
- Search index freshness.

### Phase gate: real systems
Each design doc must include this table:

```text
Concern             Decision                  Tradeoff
Latency             ...
Consistency         ...
Availability        ...
Durability          ...
Cost                ...
Security            ...
Operational risk    ...
```

### Phase gate: production
You pass only if you can write an incident response for:
- Database latency spike.
- Cache outage.
- Queue backlog.
- Regional outage.
- Bad deployment.
- `10-Performance-Engineering.md`
- `11-Production-DevOps.md`
- `12-Interview-and-Senior-Thinking.md`

Output:
- Production review pack: SLOs, alerting strategy, deployment and rollback policy.

---

## Ongoing Weekly Routine
1. One deep topic
2. One system design drill
3. One performance or failure analysis
4. One implementation improvement in hands-on projects

## Final Mastery Checklist
- Can design scalable architectures from first principles.
- Can reason about consistency and failure explicitly.
- Can profile and improve P99 latency.
- Can communicate tradeoffs clearly in interview and production reviews.

---

## Monthly Deep-Dive Cycle

### Week 1
- One foundations/networking deep revision
- One small implementation improvement

### Week 2
- One full design drill (new system)
- One load/performance experiment

### Week 3
- One reliability drill (chaos/failure simulation)
- One observability improvement

### Week 4
- One mock interview + retrospective
- Knowledge gap remediation plan

## Portfolio outcomes (recommended)
- 3 architecture docs with tradeoff matrices
- 7 project repos with load-test reports
- 1 production-readiness checklist per project

---

## 12-Week Study Schedule

---

### Week 1-2: Foundations

**Goal:** Build intuition for the fundamental primitives that appear in every backend system.

| Day   | Topic                    | Activity                                           | Output                                      |
|-------|--------------------------|----------------------------------------------------|---------------------------------------------|
| 1–3   | `01-Foundations.md`      | Read fully, annotate tradeoffs in the margin       | 500-word written summary: latency, CAP, QPS |
| 4–5   | `02-Networking-Basics.md`| Read, then close the doc and draw from memory      | TCP 3-way handshake diagram, no notes       |
| 6–7   | `03-Data-and-Storage.md` | Read comparison sections with focus on indexes     | Compare SQL vs NoSQL for 3 specific schemas |

**Self-check questions — Week 1:**
1. What is the difference between latency and throughput? Give a real example where improving
   one measurably worsens the other.
2. Explain CAP theorem. Which two properties does Postgres prioritize? Which does Cassandra?
3. Describe the TCP 3-way handshake step by step. What happens if the SYN-ACK packet is lost?
4. When would you choose a document store over a relational store? Show a concrete schema example.
5. What is connection pooling and why does it matter at 10K concurrent users?

**Self-check questions — Week 2:**
1. What is the difference between replication and sharding? Can you use both simultaneously?
2. Explain READ COMMITTED vs REPEATABLE READ isolation. Which prevents phantom reads?
3. What happens during a B-tree index lookup? Estimate disk reads for a 1M-row table.
4. What is a write-ahead log (WAL)? Why does Postgres write it before touching data pages?
5. Explain eventual consistency with a concrete example. What does "eventually" actually mean
   in terms of time bounds?

**Week 1–2 exercise — design a blog at 3 scales:**
```
Scale 1 (1K users):
  Single Postgres instance + single Node.js server.
  No caching, no queue. Why: team is small, complexity is the enemy.

Scale 2 (100K users):
  Add Redis cache for read-heavy endpoints (post detail, author profile).
  Add a Postgres read replica for analytics queries.
  Why each component was added and what metric triggered the decision.

Scale 3 (10M users):
  CDN for all static assets and public API responses with cache headers.
  PgBouncer connection pooler in front of Postgres.
  Table partitioning on posts by created_at (monthly partitions).
  Separate auth service (extracted first because it has the cleanest boundary).
  Why: connection exhaustion and table scan latency are the measured bottlenecks.

Write one paragraph per scale explaining the trigger (what breaks) and the fix.
```

---

### Week 3-4: Core Components

**Goal:** Understand the reusable building blocks that appear in every production system design.

| Day   | Topic                       | Activity                                        | Output                                     |
|-------|-----------------------------|-------------------------------------------------|--------------------------------------------|
| 1–3   | `04-Core-Components.md`     | Read fully, focus on failure modes              | Implement LRU cache from scratch           |
| 4–5   | `05-Architecture-Patterns.md`| Focus on Saga, CQRS, event sourcing            | Draw Saga for checkout with all compensations |
| 6–7   | `06-Scaling-Systems.md`     | Focus on consistent hashing and sharding        | Implement consistent hash ring with virtual nodes |

**LRU cache implementation goal:**
```python
# Requirements — must support:
#   get(key)         → O(1) average
#   put(key, value)  → O(1) average, evicts LRU entry when at capacity
# Constraints:
#   No external libraries for the core data structure
#   Use a doubly-linked list + hashmap, or Python's OrderedDict
#   Write 5 unit tests covering: basic get/put, eviction order,
#   capacity=1 edge case, update moves to MRU, miss returns -1
```

**Saga pattern exercise — checkout flow:**
```
Draw the state machine for:
  Step 1: Reserve Inventory
  Step 2: Charge Payment
  Step 3: Ship Order
  Step 4: Send Confirmation Email

For each step, define:
  - The local DB transaction it executes
  - Its compensating transaction (the undo)
  - What happens to already-completed steps if this step fails

Key questions to answer in your diagram:
  - If Charge Payment fails, who releases the inventory?
  - If Ship Order fails after payment succeeds, what happens to the charge?
  - If Confirmation Email fails (non-critical), do you roll back the shipment?
```

**Self-check questions — Week 3–4:**
1. LRU cache: why do you need both a hashmap and a doubly-linked list? Why not just a list?
2. What is a circuit breaker? Name its three states and the condition that triggers each transition.
3. What is the difference between a message queue (SQS style) and an event log (Kafka style)?
   Give a use case where each is the right choice.
4. In the Saga pattern, what is a compensating transaction? Is it an undo, or something different?
5. Consistent hashing: what problem does adding virtual nodes solve? Give a numeric example.

---

### Week 5-6: System Designs A

**Goal:** Practice the complete 45-minute design process on three major consumer systems.

**Daily design template — strictly timed:**
```
[0–15 min]  Requirements + Estimation
            - 3–5 clarifying questions
            - DAU, QPS, storage, fanout estimates

[15–35 min] Architecture + Deep Dive
            - HLD diagram (draw, don't describe)
            - Data model with at least 3 tables and their indexes
            - Critical path traced end-to-end
            - One deep dive on the hardest component

[35–45 min] Failure Modes
            - Three failure scenarios
            - Concrete recovery steps for each
            - What metric would alert you?
```

| Day | System     | Key challenge to focus on                              |
|-----|------------|--------------------------------------------------------|
| 1   | Twitter Feed     | Fan-out on write vs read; celebrity problem       |
| 2   | Instagram        | Media upload pipeline; CDN strategy               |
| 3   | WhatsApp         | Message ordering; delivery receipts; E2E overview |
| 4   | Review Day 1–3   | Find the weakest component, redesign it           |
| 5   | Twitter (repeat) | Focus on notifications and full-text search       |
| 6   | Instagram (repeat) | Focus on Explore / recommendation feed          |
| 7   | WhatsApp (repeat)  | Focus on group messaging at scale               |

---

### Week 7-8: System Designs B

**Systems to cover — one per day:**

| Day | System             | Unique technical challenge                              |
|-----|--------------------|--------------------------------------------------------|
| 1   | YouTube            | Video encoding pipeline; adaptive streaming (HLS/DASH) |
| 2   | Uber               | Geospatial indexing; real-time driver matching; surge  |
| 3   | Netflix            | Content delivery at edge; A/B testing; recommendations |
| 4   | URL Shortener      | Hash collision handling; custom aliases; click analytics|
| 5   | Distributed Cache  | Consistency levels; eviction policies; cluster topology |
| 6   | Search Engine      | Inverted index construction; BM25 ranking; crawl budget|
| 7   | Review + Mock      | Full timed mock on one system, no notes                |

**Week 7–8 depth target — for each system, produce a 2-page doc with:**
```
✓ Schema: at least 3 tables with column types and indexes
✓ Architecture diagram: labeled components and data flow arrows
✓ Critical path: one user action traced end-to-end through every layer
✓ Failure modes: two scenarios with detection and recovery
✓ 10x evolution: what specifically breaks at 10x and what you'd change
```

---

### Week 9-10: Hands-On Projects

**Goal:** Reinforce concepts by running real code and observing real system behavior under load.

| Week | Project         | What to build / run                           | Required test scenario                              |
|------|-----------------|-----------------------------------------------|-----------------------------------------------------|
| 9    | `08a` Mini-Redis    | Run the mini Redis server                 | Test SET, GET, TTL, EXPIRE, DEL with redis-cli      |
| 9    | `08b` URL Shortener | Run the shortener service                 | Create URL, test redirect, hit analytics endpoint   |
| 10   | `08c` Rate Limiter  | Run the rate limiter service              | Boundary attack: 100 req/min limit, send 101        |
| 10   | `08d` Task Queue    | Run worker + producer                     | Submit job, kill worker mid-process, watch retry    |

**Boundary attack test for the rate limiter:**
```bash
# Step 1: Send exactly 100 requests — all should succeed with 200
for i in {1..100}; do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/test
done

# Step 2: Send one more — should get 429 Too Many Requests
curl -v http://localhost:3000/api/test
# Expect: HTTP/1.1 429 Too Many Requests
# Expect: Retry-After header if implemented

# Step 3: Wait for window reset, then verify service recovers
sleep 60
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/test
# Expect: 200

# Step 4: Test the boundary condition — send 100 fast then pause then 100 fast
# Does window reset cleanly? Is there any off-by-one?
```

**For each project, write a short postmortem:**
```
1. What does this component do? (one sentence)
2. What is the most interesting implementation detail you noticed in the code?
3. What broke or behaved unexpectedly when you tested it?
4. What would you change before running this in production?
```

---

### Week 11-12: Mock Interviews + Polish

**Schedule: 2 timed sessions per day.**

| Session         | Duration | Format                                          |
|-----------------|----------|-------------------------------------------------|
| Morning mock    | 45 min   | No notes, treat whiteboard (or paper) as the only output |
| Evening review  | 30 min   | Read notes/recording, identify specific gaps    |

**After every mock, answer these 5 questions in writing before moving on:**
1. What did I struggle to explain clearly, and why?
2. Which calculation did I fumble, skip, or get wrong?
3. Which failure mode did I forget to mention entirely?
4. Where did I over-design early or under-design a critical path?
5. Which specific file in this repo addresses the gap I found?

**Gap → file remediation map:**
```
Unclear on consistency or isolation levels  → 03-Data-and-Storage.md
Forgot failure handling patterns            → 04-Core-Components.md
Weak on distributed system concepts         → 09-Advanced-Distributed-Topics.md
Poor communication or structure             → 12-Interview-and-Senior-Thinking.md
Slow on scale estimation                    → 07-Real-World-System-Designs.md
```

---

## Self-Assessment Checklist by Topic

Rate yourself honestly on each level before moving to the next.
Use: ☐ not yet  |  ✓ can explain  |  ✓✓ can design  |  ✓✓✓ can implement and debug

---

### 1. Networking
- **Beginner:** Explain TCP vs UDP with a concrete use case for each. Walk through a DNS lookup.
- **Intermediate:** Design a system where WebSocket connections are load balanced across 3 servers.
  How do you handle the stickiness requirement?
- **Advanced:** Explain how TCP handles packet loss. What is head-of-line blocking in HTTP/1.1
  and how does HTTP/2 solve it?
- **Expert:** Explain QUIC's advantages over TLS-over-TCP. Describe a scenario where UDP is
  preferable despite its unreliability.

### 2. Storage
- **Beginner:** Explain when to use SQL vs NoSQL. Give one concrete schema example for each.
- **Intermediate:** Design a schema for an e-commerce order system with indexes for the top
  3 access patterns.
- **Advanced:** Explain the LSM-tree structure (Cassandra, RocksDB) vs B-tree (Postgres).
  When does each outperform the other?
- **Expert:** Explain how Postgres MVCC works. What is the cost of dead tuples and how does
  VACUUM address it?

### 3. Caching
- **Beginner:** Explain the difference between cache-aside and write-through caching.
  Which is more common and why?
- **Intermediate:** Design a caching layer for a product catalog with 1M items and 10K writes/day.
  What is your TTL strategy and invalidation approach?
- **Advanced:** Explain cache stampede. Describe three prevention strategies and their tradeoffs.
- **Expert:** Explain how Redis handles eviction under memory pressure. Compare LRU, LFU,
  and volatile-lru policies with a use case for each.

### 4. Messaging
- **Beginner:** Explain why you'd use a message queue instead of a direct API call.
  What does "decoupling" concretely mean?
- **Intermediate:** Design a notification system using a queue. Handle at-least-once delivery
  and idempotency at the consumer.
- **Advanced:** Explain the difference between a queue (SQS) and a log (Kafka). When is replay
  capability a hard requirement?
- **Expert:** Explain Kafka consumer group rebalancing. What is partition lag and what alert
  threshold would you set?

### 5. Scaling
- **Beginner:** Explain horizontal vs vertical scaling. At what point does vertical scaling
  stop being a useful option?
- **Intermediate:** Design a sharding strategy for a user table with 1B rows. How do you handle
  the re-sharding problem when adding capacity?
- **Advanced:** Explain consistent hashing and virtual nodes. Give a numeric example of how
  virtual nodes improve load distribution.
- **Expert:** Explain how DynamoDB handles hot partitions with adaptive capacity. What is
  partition-level request routing?

### 6. Consistency
- **Beginner:** Explain the difference between strong and eventual consistency with a concrete,
  user-visible example.
- **Intermediate:** Design a shopping cart that remains available under a network partition
  and reconciles correctly when connectivity is restored.
- **Advanced:** Explain the difference between read-your-writes, monotonic reads, and
  linearizability. Which does Postgres provide by default?
- **Expert:** Explain how Google Spanner achieves external consistency using TrueTime.
  Why can't you replicate this with NTP?

### 7. Distributed Systems
- **Beginner:** Explain what makes a distributed system fundamentally harder than a
  single-server system. Name three specific failure modes.
- **Intermediate:** Design a distributed lock using Redis. Handle the case where the lock
  holder crashes before releasing.
- **Advanced:** Explain the Raft consensus algorithm. What is a leader election and what
  triggers it?
- **Expert:** Explain Byzantine fault tolerance. When do you actually need it vs crash-fault
  tolerance? Name a real system that uses BFT.

### 8. Performance
- **Beginner:** What is p99 latency? Why does it matter more than average latency for real
  user experience?
- **Intermediate:** Walk through profiling a slow API endpoint: slow query, N+1, missing index,
  connection pool exhaustion. How do you identify each?
- **Advanced:** Explain how a CPU cache miss propagates to database performance. What is
  data locality and how do you design for it?
- **Expert:** Explain flame graph analysis. What does a wide, flat bar at the top of the
  flame graph indicate?

### 9. Production Operations
- **Beginner:** What is an SLO? Write a concrete SLO for a read API that a team could
  actually be paged on.
- **Intermediate:** Write an incident response runbook for a database latency spike.
  Include detection, triage, and mitigation steps.
- **Advanced:** Explain the difference between canary, blue-green, and feature-flag rollout
  strategies. When is each appropriate?
- **Expert:** Describe how to execute a zero-downtime database schema migration on a live
  production system with no maintenance window.

### 10. Security
- **Beginner:** Explain the difference between authentication and authorization with an
  example of each failing independently.
- **Intermediate:** Design rate limiting and API key authentication for a public API.
  What abuse scenarios does each prevent?
- **Advanced:** Explain how a JWT works end-to-end. What are its security tradeoffs
  compared to server-side session tokens?
- **Expert:** Explain SSRF and how to prevent it specifically in a webhook delivery system.
  Explain SQL injection and why parameterized queries fix it at the driver level.

### 11. System Design Process
- **Beginner:** State the 7-step system design interview framework from memory and explain
  why the order matters.
- **Intermediate:** Design a URL shortener end-to-end using all 7 steps within 45 minutes.
- **Advanced:** Articulate a specific tradeoff you made between consistency and availability
  in a design, and justify it against the stated SLO.
- **Expert:** Design the same system at MVP, 10×, and 100× scale. Name exactly what breaks
  at each scale transition and what you'd change.

### 12. Communication
- **Beginner:** Explain eventual consistency to a non-technical product manager in 90 seconds.
- **Intermediate:** Present a system design with clear, explicit structure: requirement → scale
  → design → tradeoff → failure handling.
- **Advanced:** Receive pushback on a design decision. Acknowledge the concern, restate your
  assumptions, compare the alternative, and choose based on stated constraints.
- **Expert:** Lead a design review. Ask probing questions that surface the real constraint
  hiding behind the stated requirement.

---

## 20 Interview Readiness Questions with Model Answers

---

**Q1: What is the CAP theorem and when does it actually apply?**
CAP states that a distributed system can guarantee at most two of Consistency, Availability,
and Partition Tolerance. Since network partitions always happen eventually, you're really
choosing between CP (reject requests during a partition to stay consistent) and AP (serve
possibly stale data to stay available). For a bank account balance, choose CP. For a social
media feed, AP is acceptable — a user seeing a slightly stale timeline is fine.

---

**Q2: How does consistent hashing work and why does it matter for scaling?**
Consistent hashing maps both data keys and server nodes onto a ring using the same hash
function. Each key is owned by the nearest clockwise node. When a node is added or removed,
only the keys on the adjacent arc re-map — not all keys. Without it, adding 1 node to a
9-node cluster rehashes ~90% of keys. With it, only ~10% re-map. Virtual nodes (placing each
physical server at multiple ring positions) improve load balance when servers have unequal load.

---

**Q3: Explain fan-out on write vs fan-out on read. When do you use each?**
Fan-out on write precomputes timelines when a post is created, giving fast reads but expensive
writes that scale with follower count. Fan-out on read queries followed accounts' posts at read
time, keeping writes cheap but making reads expensive at scale. Most large social platforms use
a hybrid: precompute for users with under ~10K followers, merge at read time for celebrities.
The threshold is chosen so the fanout write budget stays manageable.

---

**Q4: What is a distributed lock and when should you use one?**
A distributed lock prevents multiple processes from executing a critical section simultaneously
across machines. Use it for cron jobs that must run on exactly one instance, inventory
reservation to prevent overselling, or leader election. Redis Redlock uses a quorum of N
instances (typically 5) to grant a lock with a TTL. The TTL prevents deadlock if the holder
crashes. The key risk: if the holder's process is paused (GC, slow VM) longer than the TTL,
another node acquires the lock while the first still believes it holds it.

---

**Q5: How do you prevent a thundering herd after a cache miss?**
Three strategies: (1) Request coalescing — the first miss acquires a distributed lock, fetches
from DB, populates the cache; subsequent misses wait on the lock and then hit cache. (2)
Probabilistic early expiry — before TTL expires, each request has a small random chance of
refreshing early, staggering the refresh across the window. (3) Background refresh — a
separate process proactively refreshes keys before they expire so the cache never goes cold.
Request coalescing with a short lock timeout is the most common production approach.

---

**Q6: What is idempotency and how do you implement it for a payment API?**
Idempotency means repeating the same request produces the same result without side effects.
For payments, a client retry on network timeout must not result in a double charge.
Implementation: the client generates a UUID idempotency key and sends it as a header.
The server stores `(idempotency_key → response)` in a DB table using `INSERT OR IGNORE`.
On retry, the server finds the existing record and returns the stored response without
re-executing the payment. The idempotency table is the only record you `INSERT OR IGNORE` on —
the payment record itself is inserted exactly once.

---

**Q7: Explain eventual vs strong consistency with a user-visible example.**
Strong consistency: after a write, every subsequent read from any node returns the new value.
Reading from a single Postgres master gives this guarantee. Eventual consistency: after a write,
reads may temporarily return stale data, but all replicas converge to the same value eventually.
Like DNS — after changing an A record, different resolvers worldwide may return the old IP for
minutes. For a bank account balance, strong consistency is required. For a social media like
count, eventual consistency is fine — a user seeing 1,002 vs 1,003 likes has no impact.

---

**Q8: What is the N+1 query problem and how do you fix it?**
N+1 happens when code fetches 1 parent record, then issues N separate queries to fetch each
child, producing N+1 total DB round-trips. Example: fetch 100 posts (1 query), then for each
post fetch its author separately (100 queries) = 101 queries total. Fix it at the ORM layer
with eager loading (`include`/`joins`). At the API boundary between services, use the DataLoader
pattern: batch and deduplicate all child ID lookups within a single event-loop tick, then
resolve them in a single query.

---

**Q9: How does a CDN work and what can you and can't you cache there?**
A CDN places servers at edge locations globally. User requests are routed to the nearest edge.
If the edge has the content cached, it serves it locally with low latency. If not, it fetches
from origin, caches the response, and serves it. You can cache: static assets (JS, CSS, images),
public API responses with explicit `Cache-Control` headers, and pre-rendered HTML. You cannot
cache: authenticated responses that vary per user, real-time data, or payment/session endpoints.
The key header is `Cache-Control: public, max-age=3600, stale-while-revalidate=60`.

---

**Q10: What is database sharding and what problems does it introduce?**
Sharding partitions data across multiple DB instances by a shard key (e.g. `user_id % N`). Each
shard holds a subset of rows. This solves storage and write throughput limits of a single node.
It introduces: cross-shard queries (joining data across shards requires scatter-gather, which is
slow), re-sharding complexity (adding shards requires migrating data), hot shards (one user's
shard gets disproportionate load), and loss of ACID transactions across shards (requiring Sagas
or 2PC with their respective tradeoffs).

---

**Q11: Explain the Saga pattern for distributed transactions.**
A Saga breaks a multi-service transaction into a sequence of local transactions, each with a
compensating transaction that undoes its work. Example: Checkout saga — (1) Reserve inventory,
(2) Charge payment, (3) Send confirmation. If step 2 fails, execute compensation for step 1
(release inventory). If step 3 fails, compensate steps 2 and 1 (refund, release). Sagas
guarantee eventual consistency but not atomicity — there's a window where partial state is
visible. Use Sagas when steps span services that cannot share a single DB transaction.

---

**Q12: What is a write-ahead log and why does Postgres use one?**
A write-ahead log (WAL) is an append-only file where every change is written before being
applied to the actual data pages. If Postgres crashes mid-write, the WAL is replayed on restart
to recover committed state — guaranteeing durability without requiring every write to fsync the
data page immediately. Postgres also uses the WAL for streaming replication: replica servers
continuously receive WAL records and replay them to stay in sync. Change data capture (CDC)
tools like Debezium read from the WAL to stream changes to downstream systems without polling.

---

**Q13: How do you design a rate limiter that works across multiple API servers?**
Each API server cannot track limits independently — users would bypass limits by hitting
different servers. The solution is a centralized counter in Redis. For each request, atomically
increment a counter keyed by `{user_id}:{window}` and compare to the limit. Use `INCR` +
`EXPIRE` for fixed windows, or a sorted set with member timestamps for accurate sliding windows.
If Redis goes down: fail-open for general endpoints, fail-closed for auth and payment endpoints.
Each server can maintain a local in-memory fallback to provide basic protection during Redis outages.

---

**Q14: What is operational transformation and why is it needed for collaborative editing?**
When two users edit the same document simultaneously, a last-write-wins merge corrupts the
document. Operational Transformation (OT) transforms each incoming operation based on the
concurrent operations that have already been applied, adjusting character positions to produce
a correct merge. If User A deletes the character at position 5 and User B concurrently inserts
at position 6, B's insert must be adjusted to position 5 (shifted left by A's deletion). The
OT server is the single leader per document — it serializes all operations and computes the
transforms before broadcasting to all clients.

---

**Q15: What is the difference between a message queue and an event log?**
A message queue (SQS, RabbitMQ) distributes work: each message is consumed once by one consumer,
then deleted. Multiple consumers compete. Good for task distribution (send email, process image).
An event log (Kafka, Kinesis) is ordered and durable: multiple consumer groups independently
read the same events at their own pace and can replay from any offset. Old events are retained
for a configured period. Good for event sourcing, audit trails, CDC pipelines, and multiple
downstream consumers with different processing speeds. Choose a queue for work distribution;
choose a log when replay or multiple independent consumers are requirements.

---

**Q16: How does exponential backoff with jitter work and why is jitter critical?**
Exponential backoff waits `2^attempt` seconds between retries: 2s, 4s, 8s, 16s. Without jitter,
if 1000 clients all fail simultaneously (e.g. during a server restart), they all retry at exactly
the same intervals — creating synchronized thundering herds that hammer the recovering server in
waves. With full jitter: `wait = random(0, min(cap, 2^attempt))`. Retries now spread uniformly
across the interval, reducing server load by orders of magnitude. AWS recommends full jitter.
The tradeoff is higher average latency for individual clients, which is acceptable given the
improvement in aggregate server behavior.

---

**Q17: What is a circuit breaker and when should it open?**
A circuit breaker wraps calls to an external dependency and tracks failure rate. In CLOSED state,
requests pass through and failures are counted. When failures exceed a threshold (e.g. 50% in
10 seconds), it OPENS: subsequent requests fail immediately without calling the downstream
service, giving it time to recover. After a timeout, it moves to HALF-OPEN: one probe request
is allowed. If it succeeds, the breaker resets to CLOSED; if it fails, it returns to OPEN.
Without a circuit breaker, slow upstream calls block your thread pool and cascade the failure
to your service even though your code is healthy.

---

**Q18: How would you design search for a large dataset?**
For simple search up to ~10M rows: Postgres full-text search with `tsvector` columns and GIN
indexes. For large scale: Elasticsearch or OpenSearch with an inverted index. Writes go to the
primary DB first, then asynchronously indexed in Elasticsearch via a CDC pipeline (Debezium +
Kafka). This means search results are eventually consistent — typically seconds behind the DB.
The Elasticsearch mapping is denormalized: store all fields needed to render results in the
index so search results require no DB join. For relevance: BM25 scoring by default, boosted
by recency or engagement signals.

---

**Q19: How do you execute a zero-downtime database migration?**
For adding a nullable column: `ALTER TABLE ADD COLUMN` with no default runs fast (metadata
change only) and takes only a brief exclusive lock. For backfilling existing rows: do it in
batches of 1,000–10,000 rows with a `WHERE id BETWEEN` filter, never in a single transaction
— a long transaction holds a lock that blocks all reads and writes. For adding NOT NULL: only
after the backfill is complete. For renaming a column: run old and new names in parallel, write
to both, backfill old→new, migrate reads to the new name, then drop the old. Never use a long
DDL transaction in a single migration on a live, traffic-bearing table.

---

**Q20: How do you decide between synchronous and asynchronous processing?**
Use synchronous when the user needs the result to continue: authentication, payment
authorization, form validation. The API response must contain the outcome. Use asynchronous
when the operation is slow, the user does not need to wait, or the step can fail and retry
independently: sending emails, generating PDFs, processing uploaded images, webhook delivery.
The handshake pattern: the synchronous API returns immediately with a job ID and `202 Accepted`;
the client polls `GET /jobs/{id}/status` or receives a push notification (webhook or WebSocket)
when done. Core rule: never let a slow or flaky third-party call sit in your synchronous
request path.

---

## Progress Tracking Template

Copy this table into a separate file (e.g. `progress.md`) and update it each week.

```markdown
# System Design Progress Tracker

## Weekly Log

| Week | Dates | Topics Covered | Mock Designs Done | Key Gap Found | Gap Fixed? |
|------|-------|---------------|-------------------|---------------|------------|
| 1    |       |               |                   |               |            |
| 2    |       |               |                   |               |            |
| 3    |       |               |                   |               |            |
| 4    |       |               |                   |               |            |
| 5    |       |               |                   |               |            |
| 6    |       |               |                   |               |            |
| 7    |       |               |                   |               |            |
| 8    |       |               |                   |               |            |
| 9    |       |               |                   |               |            |
| 10   |       |               |                   |               |            |
| 11   |       |               |                   |               |            |
| 12   |       |               |                   |               |            |

## Phase Gates

| Gate                | Criteria                                                           | Status | Date Passed |
|---------------------|--------------------------------------------------------------------|--------|-------------|
| Foundations         | Explain CAP, isolation levels, TCP with real examples              | ☐      |             |
| Core Components     | Explain LRU, circuit breaker, queue retries, rate limiter          | ☐      |             |
| System Designs      | Complete one 45-min mock with clear tradeoffs and failure handling | ☐      |             |
| Hands-On Projects   | Explain what broke under load in each of the 4 projects            | ☐      |             |
| Production Ready    | Write incident runbook for 5 failure modes                         | ☐      |             |
| Interview Ready     | Two consecutive mocks with no major gaps flagged                   | ☐      |             |

## Systems Designed

| System            | HLD Done | Schema Done | Failure Modes | 10x Evolution |
|-------------------|----------|-------------|---------------|---------------|
| Twitter Feed      | ☐        | ☐           | ☐             | ☐             |
| Instagram         | ☐        | ☐           | ☐             | ☐             |
| WhatsApp          | ☐        | ☐           | ☐             | ☐             |
| YouTube           | ☐        | ☐           | ☐             | ☐             |
| Uber              | ☐        | ☐           | ☐             | ☐             |
| Netflix           | ☐        | ☐           | ☐             | ☐             |
| URL Shortener     | ☐        | ☐           | ☐             | ☐             |
| Distributed Cache | ☐        | ☐           | ☐             | ☐             |
| Search Engine     | ☐        | ☐           | ☐             | ☐             |
| Feature Flag      | ☐        | ☐           | ☐             | ☐             |
| Payment Webhooks  | ☐        | ☐           | ☐             | ☐             |
| Rate Limiter      | ☐        | ☐           | ☐             | ☐             |

## Self-Assessment by Topic  (update monthly)

| Topic           | Current Level                                          | Target | Key Gap |
|-----------------|--------------------------------------------------------|--------|---------|
| Networking      | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| Storage         | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| Caching         | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| Messaging       | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| Scaling         | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| Consistency     | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| Distributed Sys | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| Performance     | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| Production Ops  | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| Security        | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| System Design   | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |
| Communication   | ☐ Beginner  ☐ Intermediate  ☐ Advanced  ☐ Expert       |        |         |

## Mock Interview Log

| Date | System Designed | Duration | Top 2 Struggles | Score (1–5) |
|------|----------------|----------|-----------------|-------------|
|      |                |          |                 |             |
|      |                |          |                 |             |
|      |                |          |                 |             |
|      |                |          |                 |             |
|      |                |          |                 |             |
|      |                |          |                 |             |
|      |                |          |                 |             |
|      |                |          |                 |             |
```
