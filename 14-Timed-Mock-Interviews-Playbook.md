# Timed Mock Interviews Playbook (45–60 Minutes Weekly)

## Goal
Turn system design knowledge into interview performance under time pressure.

## Interview Simulation Formats

## 45-minute format (most common)
1. 5 min: clarify requirements + constraints
2. 5 min: estimate scale
3. 15 min: high-level design
4. 10 min: deep dive (data model, critical path)
5. 10 min: bottlenecks, tradeoffs, failure handling

## 60-minute format (senior-heavy)
1. 8 min: requirements and assumptions
2. 7 min: scale and SLOs
3. 20 min: HLD + API + data model
4. 15 min: deep dives (consistency, caching, queues)
5. 10 min: resilience, evolution plan, cost

---

## Weekly Mock Plan

1. Week A: Social (Twitter/Instagram)
2. Week B: Communication (WhatsApp/Slack)
3. Week C: Media (YouTube/Netflix)
4. Week D: Infra (URL shortener/cache/queue/search)

Repeat cycle with increasing depth.

---

## Pre-Mock Checklist (5 minutes before start)
1. Pick one prompt.
2. Set timer.
3. Open blank page only.
4. Define success criteria:
   - clear structure
   - realistic scale
   - explicit tradeoffs
   - failure plan

---

## During Mock: Golden Script
Use this exact structure aloud:

1. "Let me confirm requirements and constraints."
2. "I’ll estimate rough scale before architecture."
3. "I’ll present baseline design, then deep dive critical path."
4. "Then I’ll cover bottlenecks, tradeoffs, and failures."

---

## Scoring Rubric (0–5 each)
1. Requirements clarity
2. Estimation realism
3. Architecture completeness
4. Data model/API quality
5. Consistency reasoning
6. Failure handling
7. Tradeoff communication
8. Senior-level prioritization

**Target:** average >= 4 before top-tier interviews.

---

## Post-Mock Review Template (15 minutes)
1. What was unclear?
2. Where did I hand-wave?
3. Which tradeoff did I not quantify?
4. What would break first in my design?
5. One concrete improvement for next mock.

---

## Difficulty Progression

## Level 1 (beginner)
- URL shortener
- Rate limiter
- Notification service

## Level 2 (intermediate)
- Twitter timeline
- Chat system
- Log aggregation

## Level 3 (advanced)
- Uber matching
- YouTube
- Search engine

---

## Common Failure Patterns and Fixes
1. **Problem:** jumping to architecture too early  
   **Fix:** force 5 minutes requirements first.
2. **Problem:** no scale estimation  
   **Fix:** always compute QPS + storage growth.
3. **Problem:** no failure strategy  
   **Fix:** include timeout/retry/idempotency/degraded mode block.
4. **Problem:** weak communication  
   **Fix:** explicitly compare 2 options before choosing.

---

## Practice Prompt Bank
1. Design Slack channels and message history.
2. Design Google Docs collaborative editing backend.
3. Design ride matching service for Uber.
4. Design recommendation feed service.
5. Design global feature flag service.

## Sophisticated Mock Program

### Weekly rotation
- Week 1: social feed and graph.
- Week 2: realtime messaging and presence.
- Week 3: media upload/playback.
- Week 4: marketplace/location.
- Week 5: infrastructure systems.
- Week 6: multi-region and disaster recovery.

### Output after every mock
- One design diagram.
- One capacity estimate.
- One API and schema section.
- One bottleneck section.
- One failure-mode section.
- One self-critique.

### Advanced interviewer pushbacks
Practice answering:
- "What changes at 10x traffic?"
- "Which data can be stale?"
- "How do you recover from regional failure?"
- "What do you monitor?"
- "How do you reduce cost?"
- "How would you migrate without downtime?"

### Senior scoring dimensions
- Constraint-driven decisions.
- Clear evolution path.
- Production operability.
- Security and abuse awareness.
- Tradeoff honesty.

## Rigorous Mock Evaluation Sheet

```text
Prompt:
Assumptions:
Scale:
Core entities:
Hot path:
Architecture:
Consistency:
Failure handling:
Security:
Metrics:
10x evolution:
Weakest part:
```

### Automatic fail signals
- No scale estimate.
- No data model.
- No failure handling.
- No consistency discussion.
- Architecture has components with no purpose.
- Uses "Kafka/Redis/microservices" without explaining why.

---

## Part II: Complete Timed Interview Scripts (45-Minute Format)

Each script below is a **full simulation**: interviewer prompt → timestamped phases → model answers → follow-up Q&A → common mistakes.

---

### Script 1: Design a Notification System for a Food Delivery App

**Interviewer Prompt:** *"Design a notification system for a food delivery app like DoorDash. Users should receive updates when their order is confirmed, picked up, and delivered."*

---

#### [0:00–5:00] Phase 1 — Requirements Clarification

**What you say:**

> "Before I start designing, let me clarify a few things.
>
> Functional requirements:
> - Users receive push, SMS, and email for order lifecycle events (confirmed, picked up, arriving, delivered, cancelled)
> - Delivery partners receive push for new order assignments
> - Restaurants receive notifications for incoming orders
> - Users can configure notification preferences (enable/disable each channel)
>
> Non-functional requirements:
> - Notifications delivered within 5 seconds of the triggering event
> - System handles at least 500K concurrent active orders
> - At-least-once delivery: missing a notification is worse than a duplicate
> - Availability: 99.9%
>
> Out of scope: marketing/promotional notifications, in-app notification feed, email template management.
>
> Is that aligned with what you're thinking?"

---

#### [5:00–10:00] Phase 2 — Capacity Estimation

**What you say:**

> "Let me estimate scale.
> - DoorDash scale: ~2M orders/day
> - Each order triggers ~4 notifications (confirmed, picked up, arriving, delivered)
> - Total notifications/day: 8M
> - Peak factor: lunch + dinner rush = 5x average
> - Average rate: 8M / 86,400 ≈ 93/sec
> - Peak rate: 93 × 5 ≈ 465 notifications/sec
> - Payload per notification: ~2KB
> - Daily volume: 8M × 2KB = 16GB/day
> - Channel split: push 80%, SMS 15%, email 5%
> - Twilio SMS limit: ~1,000/sec per account at peak SMS demand = 70/sec; likely fine, but we should queue and smooth"

---

#### [10:00–25:00] Phase 3 — High-Level Design

**What you say:**

```
Order Service --> Kafka (order-events) --> Notification Coordinator
                                               |-> Push Worker  --> FCM / APNs
                                               |-> SMS Worker   --> Twilio
                                               |-> Email Worker --> SendGrid
                                          Preference DB (Redis cache)
                                          Delivery Tracking DB
```

> "Key components:
>
> 1. **Event Producer**: Order service publishes events (`order.confirmed`, `order.picked_up`, `order.delivered`) to Kafka topic `order-events`.
>
> 2. **Notification Coordinator**: Stateless workers consume Kafka events, look up user preferences from Preference DB (Redis-cached, TTL=1hr), construct payload, and route to channel-specific workers.
>
> 3. **Preference Service**: Per-user settings (push/SMS/email enabled, quiet hours). Cached in Redis.
>
> 4. **Channel Workers**: Separate per channel — different rate limits, retry policies, and failure modes. Coupling them creates head-of-line blocking.
>
> 5. **Delivery Tracking DB**: Records `(notification_id, user_id, channel, status, sent_at, delivered_at)`. Used for deduplication and retry.
>
> Data model:
> ```sql
> notifications(id, order_id, user_id, event_type, channel, status, sent_at, delivered_at)
> user_preferences(user_id, push_enabled, sms_enabled, email_enabled, quiet_hours_start, quiet_hours_end)
> ```
> APIs:
> ```
> POST /notifications/send        (internal, triggered by events)
> GET  /notifications/status/{id} (delivery status lookup)
> PUT  /users/{id}/preferences    (update notification settings)
> ```"

---

#### [25:00–35:00] Phase 4 — Deep Dive: Reliability and Deduplication

**What you say:**

> "The critical path is reliability. A user who misses a 'driver arrived' notification is a bad experience.
>
> **Deduplication:** Idempotency key = `{order_id}:{event_type}:{channel}`. Before sending, check Delivery Tracking DB. If already sent successfully, skip. Safe to retry.
>
> **Retry logic:** If FCM returns 5xx, retry with exponential backoff: 1s → 2s → 4s, max 3 retries. After 3 failures, route to Dead Letter Queue. Alert fires if DLQ depth > 100.
>
> **Quiet hours:** Non-urgent notifications (marketing) suppressed 10PM–8AM. Order lifecycle events always go through — user opted in by placing the order.
>
> **At-least-once guarantee:** Kafka consumer commits offset only after notification is written to Delivery Tracking DB. If process crashes after calling FCM but before committing offset, event is re-processed. FCM's deduplication (using Message-ID) handles duplicate sends."

---

#### [35:00–45:00] Phase 5 — Bottlenecks, Tradeoffs, Failure Handling

**What you say:**

> "**Bottlenecks:**
> 1. SMS rate limits — queue SMS and smooth the send rate; use multiple Twilio sub-accounts
> 2. Preference cache miss — pre-fill cache when order is placed (warm on order creation)
> 3. FCM outage — fall back to SMS for high-priority events; queue push for later delivery
>
> **Failure scenarios:**
> - Kafka lag: scale coordinator partitions + consumer workers horizontally
> - Twilio outage: switch to backup provider (Vonage, MessageBird)
> - Preference DB down: fail open — send on all channels (slight over-notification is safer than silence)
>
> **Tradeoff I made explicitly:** Separate workers per channel vs. one unified worker. I chose separate because channel-specific retry and rate-limit logic stays isolated. Coupling them means a Twilio outage blocks FCM retries."

---

#### Interviewer Follow-Up Questions

**Q: "How would you handle notification ordering — if 'picked up' arrives before 'confirmed'?"**

> "Kafka partitioned by `order_id` guarantees ordering within a partition. All events for one order land on the same partition and are consumed in order. If push and SMS are sent near-simultaneously, they carry the same message — millisecond differences are acceptable. If strict cross-channel ordering mattered, we'd use a distributed lock per `order_id` before dispatching."

**Q: "How do you know notifications are actually working end-to-end?"**

> "Metrics I'd instrument:
> - `notifications_sent_total` by channel + event_type (counter)
> - `notification_delivery_latency_p99` per channel (histogram)
> - `notification_failure_rate` by channel (gauge)
> - DLQ depth — alert if > 100
> - Delivery receipts: FCM and APNs provide async delivery callbacks; store in Delivery Tracking DB
>
> Alert: if delivery rate for any channel drops below 95% for 5 consecutive minutes → page on-call."

---

#### Common Mistakes and How to Avoid Them

| Mistake | Why It Matters | Fix |
|---|---|---|
| Calling FCM synchronously in the order service | Couples order creation latency to notification delivery | Always decouple via Kafka |
| No deduplication | Retry storms send duplicate notifications | Idempotency key per (order, event, channel) |
| Single channel worker | FCM outage kills SMS too | Separate workers per channel |
| Ignoring Twilio rate limits | Twilio rejects burst SMS | Queue + smooth the rate |
| No delivery receipt tracking | Can't answer "did user get it?" | Store FCM/APNs callbacks in DB |

---

### Script 2: Design a Distributed Cache

**Interviewer Prompt:** *"Design a distributed cache system, like Memcached or Redis Cluster."*

---

#### [0:00–5:00] Phase 1 — Requirements Clarification

**What you say:**

> "Let me clarify scope.
>
> Functional: GET/SET with TTL, eviction (LRU), horizontal scaling without downtime, replication for HA.
>
> Non-functional: P99 read < 1ms, P99 write < 5ms, 99.99% availability, eventual consistency is acceptable (cache is not source of truth), target: 10TB total, 1M reads/sec.
>
> Questions: Simple key-value strings only, or complex structures (lists, sorted sets)? Persistence needed? General-purpose or optimized for a specific pattern?"

---

#### [5:00–10:00] Phase 2 — Capacity Estimation

**What you say:**

> "Scale:
> - 1M reads/sec, 100K writes/sec → 10:1 ratio, typical for caches
> - Average key-value size: 1KB
> - Total data: 10TB
> - Memory per node: 256GB → need 10TB / 256GB ≈ 40 nodes; add 20% headroom → 50 nodes
> - Network: 1M req/sec × 1KB = 1GB/sec aggregate → handled by 10GbE NICs
> - Replication factor 2 → 100 nodes total
> - Consistent hashing with 150 virtual nodes per physical node"

---

#### [10:00–25:00] Phase 3 — High-Level Design

**What you say:**

```
Client Library (consistent hashing ring)
    |-> Node 1 (primary + replica for different shards)
    |-> Node 2
    |-> ...Node 50
ZooKeeper/etcd (cluster topology, leader election)
```

> "**Data Partitioning — Consistent Hashing:**
> Ring with 2^32 positions. Each physical node owns 150 virtual nodes. Key is hashed (MurmurHash3), walks clockwise to first vnode. When a node is added/removed, only K/N keys remapped (K=total keys, N=nodes). Modulo hashing remaps all keys on change.
>
> **Client-Side Routing:** Client library holds ring topology. No proxy hop needed. Library handles hashing, connection pooling, failover to replica.
>
> **Replication:** Each shard has 1 primary, 1 replica. Writes go to primary, async replicated to replica. Reads from primary by default, replica on primary failure.
>
> **Eviction:** Approximated LRU — sample 5 random keys, evict least recently used. True LRU with doubly-linked list is O(1) but carries massive pointer overhead at cache scale.
>
> Internal node entry: `{key: string, value: bytes, ttl: unix_expiry, last_accessed: timestamp}`"

---

#### [25:00–35:00] Phase 4 — Deep Dive: Node Failures and Hot Keys

**What you say:**

> "**Node failure:** Client library pings each node every 1s. Three consecutive failures → node marked down. Reads re-route to replica. ZooKeeper coordinator promotes replica to primary, broadcasts updated topology within 5 seconds.
>
> **Split-brain prevention:** ZooKeeper election ensures only one coordinator can trigger promotion. Prevents two coordinators promoting different replicas simultaneously.
>
> **Cache stampede:** Popular key expires → 1,000 simultaneous misses all hit the DB. Mitigation: probabilistic early expiration (before TTL, a small probability triggers refresh). Or: distributed lock on the key — first thread fetches from DB, others wait on the lock.
>
> **Hot keys:** One key receiving 10% of traffic → one node becomes a hotspot. Solution: replicate hot key to N nodes with suffix `hot_key:{0..N}`, client randomly picks which copy to read. Library handles this transparently."

---

#### [35:00–45:00] Phase 5 — Tradeoffs and Production Considerations

**What you say:**

> "**Tradeoffs made:**
> 1. Eventual vs. strong consistency → chose eventual. Cache is a performance layer; DB is always authoritative.
> 2. Client-side routing vs. proxy routing → client-side is faster (no extra hop) but requires smart client library in every language. Proxy (Twemproxy) simplifies clients but adds latency.
> 3. Approximated LRU vs. true LRU → approximated uses 10x less memory per key. At cache scale, memory efficiency matters more than perfect eviction order.
>
> **Production additions:**
> - Slow-query log: log any operation > 1ms
> - Memory fragmentation alerting: RSS/used_memory > 1.3 triggers defrag
> - Key expiry monitoring: mass-expiry of keys = stampede risk → stagger TTLs with jitter
> - RDB snapshot every 5 minutes to S3 for warm restart after full cluster outage"

---

#### Interviewer Follow-Up Questions

**Q: "How do you handle cache invalidation?"**

> "Three patterns: (1) TTL-based — simple but stale for TTL duration. (2) Write-through — app writes to cache and DB simultaneously, consistent but doubles write latency. (3) Cache-aside with delete-on-write — on DB write, delete the cache key; next read repopulates. I prefer cache-aside + TTL as safety net. The delete handles 99% of staleness; TTL catches edge cases like a failed delete."

**Q: "What's different between your design and Redis Cluster?"**

> "Redis Cluster uses gossip protocol for membership — not ZooKeeper. It partitions into 16,384 fixed hash slots instead of consistent hashing. Simpler to operate but less flexible for non-uniform key distributions. My virtual-node approach handles hotspot nodes better by allowing finer-grained redistribution."

---

#### Common Mistakes and How to Avoid Them

| Mistake | Fix |
|---|---|
| Modulo hashing for node selection | Full remap on node change; use consistent hashing |
| Ignoring cache stampede | Add probabilistic refresh or distributed lock |
| Treating cache as source of truth | DB is always authoritative; cache is a read-performance layer |
| Forgetting eviction policy | Define what happens when memory is full — system must not crash |

---

### Script 3: Design a Job Scheduling System (Cron-as-a-Service)

**Interviewer Prompt:** *"Design a job scheduling system — users can schedule jobs to run at specific times or on a cron expression, similar to AWS CloudWatch Events."*

---

#### [0:00–5:00] Phase 1 — Requirements Clarification

**What you say:**

> "Functional requirements:
> - Users define jobs: cron expression (e.g., `0 */6 * * *`), target (HTTP endpoint or queue message), metadata
> - Jobs fire at most once per scheduled time (exactly-once preferred)
> - Minimum resolution: 1 minute
> - Jobs have retry policies (up to 3 retries on failure)
> - Job history: last 100 executions per job
>
> Non-functional:
> - Job fires within 30 seconds of scheduled time (low jitter)
> - Handle 10M registered jobs
> - 99.9% availability
> - At-least-once execution — missing a fire is worse than firing twice
>
> Out of scope: sub-minute scheduling, DAG workflow orchestration (Airflow-level)"

---

#### [5:00–10:00] Phase 2 — Capacity Estimation

**What you say:**

> "Scale:
> - 10M jobs registered
> - Average fire rate: once/hour → 10M / 60 = ~167K jobs due per minute on average
> - Thundering herd: `0 0 * * *` (midnight daily) could fire 40% of all daily jobs = 4M simultaneously
> - Execution: HTTP call in ~100ms → 10K executor threads handle 100K jobs/sec
> - Storage: 10M jobs × 1KB metadata = 10GB; history 10M × 100 × 2KB = 2TB
> - Components needed: scheduler nodes, executor workers, job metadata DB, job history DB"

---

#### [10:00–25:00] Phase 3 — High-Level Design

**What you say:**

```
API Layer
  -> Job Store (PostgreSQL: job definitions, next_run_at)
  -> Scheduler (polls due jobs via SKIP LOCKED)
  -> Kafka (job-executions topic)
  -> Executor Workers (HTTP calls, queue publishes)
  -> Job History DB (Cassandra/TimescaleDB)
  -> Retry Scheduler (handles failed executions with backoff)
```

> "**Job Store schema:**
> ```sql
> jobs(id, user_id, cron_expr, target_type, target_url, payload,
>      retry_count, enabled, next_run_at, last_scheduled_at, created_at)
> INDEX: (enabled, next_run_at)  -- scheduler's primary query
> ```
>
> **Scheduler (the heart of the system):**
> Runs on multiple nodes. Every 30 seconds:
> ```sql
> SELECT id FROM jobs
> WHERE enabled = true AND next_run_at <= NOW() + interval '30s'
> FOR UPDATE SKIP LOCKED
> LIMIT 1000;
> ```
> `SKIP LOCKED` is PostgreSQL's distributed lock for queues — multiple scheduler nodes run simultaneously without double-scheduling the same job.
>
> After selecting: publish `job_id` to Kafka, update `next_run_at` to next cron tick.
>
> **Executor Workers:** Consume from Kafka, call target URL, write result to Job History DB.
>
> **Exactly-once:** Executor marks job `IN_FLIGHT` before executing, then `COMPLETED`/`FAILED` after. If `IN_FLIGHT` for > 5 minutes (crash assumed), scheduler re-triggers."

---

#### [25:00–35:00] Phase 4 — Deep Dive: Thundering Herd at Midnight

**What you say:**

> "The midnight problem: 40% of daily jobs have `0 0 * * *`. That's 4M jobs firing simultaneously.
>
> **Solution: Jitter + Queue Smoothing**
> 1. When user registers a daily/hourly cron, add random jitter ±5 minutes to `next_run_at`. Documented as 'jobs run approximately at scheduled time.'
> 2. Kafka absorbs the burst. Executors pull at their processing rate — no thundering herd hits the target services.
> 3. Per-target rate limiting: max 10 req/sec to any single target host to prevent DDoS-ing the user's own service.
>
> **Concurrent execution policy:** If a job is due every 5 minutes but takes 7 minutes, next execution fires while current is still running. User sets `concurrent=false` to skip next execution while current is in-flight. Scheduler checks `IN_FLIGHT` status before enqueuing."

---

#### [35:00–45:00] Phase 5 — Failure Handling

**What you say:**

> "Failure scenarios:
> - Scheduler node crashes: SKIP LOCKED prevents duplication; other nodes pick up due jobs
> - Kafka consumer lag: scale executor workers horizontally; alert if lag > 10K messages
> - Job Store unavailable: jobs are delayed but not lost; scheduler catches up on DB recovery
> - Target always fails: after max retries, mark FAILED, notify user via webhook/email
>
> Single-region: multi-AZ PostgreSQL with synchronous replica (RPO=0). For 99.99%, add standby region with async replication — accept up to 30s of missed schedules during regional failover (rare, acceptable)."

---

#### Interviewer Follow-Up Questions

**Q: "What if the user's HTTP endpoint takes 30 seconds to respond?"**

> "Executor fires the HTTP request with a 10-second timeout. Logs timeout as a failure, retries per policy. For long-running jobs where the endpoint just kicks off async work, user's endpoint should return 202 Accepted immediately and call back our webhook API with the result when done."

**Q: "How do you handle a job definition change while a job is in-flight?"**

> "Job changes (cron expression, target URL) are versioned. A `job_version` column increments on every update. The Kafka message carries the version at schedule time. Executor compares: if version in message != current job version, re-fetch latest config. If the job was disabled mid-execution, executor completes current execution (idempotent) and stops scheduling future runs."

---

#### Common Mistakes and How to Avoid Them

| Mistake | Fix |
|---|---|
| `SELECT` without `SKIP LOCKED` | Double-scheduling same job across scheduler nodes |
| No jitter for mass daily crons | Thundering herd at midnight destroys target services |
| Marking job complete before execution | Crash after mark = silently lost execution |
| No job history/audit log | Users can't debug why their job didn't run |

---

### Script 4: Design a Real-Time Gaming Leaderboard (Top 100 Globally)

**Interviewer Prompt:** *"Design a leaderboard for a mobile game. It shows the top 100 players globally, updated in real-time as scores change."*

---

#### [0:00–5:00] Phase 1 — Requirements Clarification

**What you say:**

> "Functional:
> - Players earn scores via game events (scores are additive, not replaced)
> - Global leaderboard shows top 100: rank, username, score, avatar
> - Player can query their own rank even if outside top 100
> - Leaderboard updates within 5 seconds of a score change
> - Weekly leaderboard resets + all-time leaderboard
>
> Non-functional:
> - 50M active players globally
> - Score updates: 100K/sec at peak (major in-game events)
> - Leaderboard reads: 1M/sec (shown every time player opens app)
> - Read latency: < 50ms
>
> Out of scope: friend leaderboards, regional leaderboards (add in Phase 2)"

---

#### [5:00–10:00] Phase 2 — Capacity Estimation

**What you say:**

> "Scale:
> - 50M players × 16 bytes/player (score=8B + user_id=8B) = 800MB — fits in Redis!
> - Score updates: 100K/sec → Redis ZINCRBY O(log N) → log(50M) ≈ 26 ops — very fast
> - Leaderboard reads: 1M/sec → ZREVRANGE O(log N + 100) per call
> - Top 100 response: 100 × 200 bytes (user_id + score + username + avatar_url) = 20KB/response
> - With 10 Redis read replicas: 100K reads/sec each = 1M total — feasible"

---

#### [10:00–25:00] Phase 3 — High-Level Design

**What you say:**

```
Game Server -> Score Update API
                -> Kafka -> Score Processor
                              -> Redis Sorted Set: leaderboard:global
                              -> PostgreSQL: scores (durable)
Client App  -> Leaderboard API
                -> Redis: leaderboard:top100:snapshot (pre-computed)
                -> Redis ZREVRANK: player's own rank
```

> "**Core data structure — Redis Sorted Set:**
> - `ZINCRBY leaderboard:global {delta} {player_id}` → update score, O(log N)
> - `ZREVRANGE leaderboard:global 0 99 WITHSCORES` → top 100, O(log N + 100)
> - `ZREVRANK leaderboard:global {player_id}` → player's rank, O(log N)
>
> **Caching the top 100:** A background job reads top 100 from sorted set every 1 second and stores in `leaderboard:top100:snapshot`. API servers read from snapshot. Stale by at most 1 second — meets our 5-second SLA.
>
> **Data model:**
> ```
> Redis ZSET: leaderboard:global -> {player_id: score}
> Redis HASH: player:{id} -> {username, avatar_url, last_updated}
> PostgreSQL: scores(player_id, score, updated_at)  -- source of truth
>             score_history(player_id, delta, event_type, created_at)
> ```"

---

#### [25:00–35:00] Phase 4 — Deep Dive: Scaling Reads

**What you say:**

> "1M leaderboard reads/sec is the hot path. The top 100 changes at most a few times per second.
>
> **Strategy:** Cache the snapshot in Redis with 10 read replicas. Each replica handles 100K reads/sec. API servers are stateless — round-robin to replicas.
>
> **Player's own rank:** `ZREVRANK` is O(log N) and user-specific — can't be globally cached. Handle 50K unique player rank queries/sec on primary. Redis can sustain ~100K ops/sec on a single node — we're fine. Add read replica if this becomes a bottleneck.
>
> **Score update pipeline:** Game server emits event to Kafka. Score processor consumes, applies `ZINCRBY` to Redis primary (write path only), and writes to PostgreSQL asynchronously (durability)."

---

#### [35:00–45:00] Phase 5 — Durability, Weekly Leaderboard, Failures

**What you say:**

> "**Durability:** Redis is in-memory. If it crashes, leaderboard is lost. PostgreSQL is the source of truth. On Redis restart, warm from PostgreSQL: pre-compute sorted scores in a SQL query and bulk-load into Redis sorted set. Recovery from 50M scores: ~30 minutes. Mitigate: RDB snapshots every 5 minutes to S3.
>
> **Weekly leaderboard:** Separate sorted set `leaderboard:weekly:{YYYY-WW}`. On Sunday midnight, snapshot to S3, create fresh key. Score events write to both global and current weekly set.
>
> **Failures:**
> - Redis primary down: Sentinel promotes replica (< 30s). Stale by replica lag (< 1s acceptable).
> - Score processor down: Kafka retains events. On recovery, replays missed score updates. Idempotency key: `{player_id}:{event_id}` prevents double-counting scores.
> - Cheating/score manipulation: server validates max delta per event server-side (e.g., ≤ 10K per event). Scores from untrusted clients never written directly."

---

#### Interviewer Follow-Up Questions

**Q: "How would you add regional leaderboards (top 100 per country)?"**

> "Maintain per-region sorted sets: `leaderboard:region:US`, `leaderboard:region:IN`. Player tagged with region at registration. Score updates go to both global and regional set. Write traffic doubles (~200K/sec) — still feasible. Reads per region are lower volume — one Redis shard per region."

**Q: "What if a player's score update conflicts — two game servers increment simultaneously?"**

> "Redis `ZINCRBY` is atomic. Both increments are applied sequentially by Redis. No conflict. However, if idempotency fails (same game event processed twice), the score double-counts. We prevent this with an event deduplication check in the Score Processor before applying the increment."

---

#### Common Mistakes and How to Avoid Them

| Mistake | Fix |
|---|---|
| SQL `ORDER BY score DESC LIMIT 100` on 50M rows | O(N log N) per read — too slow at 1M reads/sec; use Redis sorted set |
| Not caching the top 100 snapshot | Top 100 recomputed on every read — wastes Redis CPU |
| No PostgreSQL backing store | Leaderboard lost on Redis restart |
| No score delta validation | Players submit fabricated deltas; server must validate per-event max |

---

### Script 5: Design a File Upload Service (Like S3 Multipart Upload)

**Interviewer Prompt:** *"Design a file upload service that supports large file uploads up to 5GB, with resumability if the connection drops."*

---

#### [0:00–5:00] Phase 1 — Requirements Clarification

**What you say:**

> "Functional:
> - Upload files up to 5GB
> - Resumable: if connection drops at 50%, client resumes from byte 50%
> - Files retrievable by unique URL after upload
> - Uploads expire if not completed within 24 hours
>
> Non-functional:
> - 10K concurrent uploads at any time
> - File retrieval via CDN, latency < 100ms for metadata
> - Durability: 99.999999999% (11 nines)
> - Availability: 99.99%
>
> Out of scope: file sharing permissions, virus scanning (add async), versioning"

---

#### [5:00–10:00] Phase 2 — Capacity Estimation

**What you say:**

> "Scale:
> - 10K concurrent uploads, average file size 500MB → 5TB in-flight
> - Upload bandwidth: if average upload takes 10 min → 5TB / 600s ≈ 8.3 GB/sec aggregate
> - 100K completed uploads/day × 500MB avg = 50TB/day new data
> - Storage growth: 50TB × 365 = 18.25PB/year
> - Chunk size: 50MB per part → 5GB file = 100 parts
> - Cleanup: incomplete multipart uploads older than 24 hours charged by S3; background job aborts them"

---

#### [10:00–25:00] Phase 3 — High-Level Design

**What you say:**

> "**Multipart upload flow:**
>
> Step 1: Client calls Initiate Upload API → gets `upload_id` + pre-signed S3 URLs per part
> Step 2: Client uploads each part directly to S3 (bypasses app server entirely — critical for bandwidth)
> Step 3: Client calls Complete Upload API with list of ETags → we call S3 `CompleteMultipartUpload` → S3 assembles file
>
> ```
> Client -> Upload Service (API) -> DynamoDB (upload state)
>                                -> S3 (object storage)
>         CDN (CloudFront) <- S3 (serves downloads)
> ```
>
> **Initiate Upload:**
> ```
> POST /uploads/initiate
> {filename, size, content_type}
> Response: {upload_id, parts: [{part_number, presigned_url, byte_range}, ...]}
> ```
>
> **Upload State in DynamoDB:**
> ```
> uploads(upload_id, user_id, filename, total_parts, completed_parts[], status, created_at, expires_at)
> ```
>
> After each part lands in S3, S3 Event Notification triggers Lambda → marks part as completed in DynamoDB.
>
> **Complete Upload:**
> `POST /uploads/{upload_id}/complete` with ETag list → verify all parts received → call S3 CompleteMultipartUpload → generate CDN URL → return to client."

---

#### [25:00–35:00] Phase 4 — Deep Dive: Resumability

**What you say:**

> "Resumability is the key differentiator.
>
> **Client-side:** Client stores `upload_id` and completed parts locally (local file, IndexedDB). On failure, client calls:
> ```
> GET /uploads/{upload_id}/status
> Response: {completed_parts: [1,3,5], missing_parts: [2,4,6,...,100]}
> ```
> Client re-uploads only missing parts. DynamoDB is the authoritative record.
>
> **Presigned URL expiry:** URLs expire in 1 hour. If client needs more time, it requests a refresh:
> ```
> POST /uploads/{upload_id}/refresh-urls?parts=2,4,6
> ```
>
> **Cleanup:** Background job hourly finds `status=IN_PROGRESS AND expires_at < NOW()` → calls S3 `AbortMultipartUpload` → deletes DynamoDB record → S3 reclaims storage for orphaned parts.
>
> **Direct-to-S3 upload** is the critical architecture decision: app server never touches the bytes. With 10K concurrent 500MB uploads, routing through app servers would require 8.3 GB/sec of bandwidth on them — impossible to scale. Pre-signed URLs let S3 absorb all upload bandwidth."

---

#### [35:00–45:00] Phase 5 — Durability, CDN, Post-Processing

**What you say:**

> "**Durability — 11 nines:**
> S3 automatically stores objects across ≥3 AZs with replication factor 3+. For cross-region: S3 Cross-Region Replication (CRR) to a backup region. 15-minute RPO for regional disaster.
>
> **Serving files:** Files are private by default. Download via short-lived (1hr) presigned GET URL. CloudFront CDN caches content at edge after first access.
>
> **Post-processing (async):** After upload completes, S3 event → SQS → Lambda/ECS job for: transcode video to multiple resolutions, extract thumbnail, run ClamAV virus scan. If malicious: quarantine in S3, delete, notify user. This is always async — never blocks the upload completion response.
>
> **Content deduplication:** Client computes SHA-256 before upload, sends in initiate request. If hash exists in our metadata DB, return existing file URL — skip upload entirely."

---

#### Interviewer Follow-Up Questions

**Q: "How do you handle a partially uploaded file where the client loses their upload_id?"**

> "The upload_id is tied to the user's session. Client calls `GET /uploads?status=in_progress` — returns all in-progress uploads for that user. Client can resume any of them. We store `user_id` in the upload record specifically for this recovery case."

**Q: "What if the same byte range is uploaded twice?"**

> "S3 multipart upload accepts the same part number multiple times — the last upload wins. DynamoDB marks the part as completed with its ETag. If a duplicate upload arrives, DynamoDB is updated with the new ETag (idempotent). CompleteMultipartUpload uses the latest ETags, so only one copy of each part is included in the final assembled file."

---

#### Common Mistakes and How to Avoid Them

| Mistake | Fix |
|---|---|
| Streaming large files through app server | Bandwidth bottleneck; pre-signed URLs for direct-to-S3 upload |
| No resumability state tracking | Client must restart from 0% on connection drop |
| Not cleaning up incomplete multipart uploads | S3 charges for orphaned parts; background job to abort stale uploads |
| Synchronous virus scanning on hot path | Blocks upload completion for 10–30s; always async post-upload |

---

## Part III: Calibration Guide — Where Are You Right Now?

Know exactly which level you're performing at so you know what to drill next.

---

### Level 1 — Not Ready

**Common profile:** Early-career engineers, first-time interviewers, or self-taught engineers who haven't done many mock interviews.

**What you typically say:**
- "I'd use a database... maybe add Kafka and Redis."
- "We can scale horizontally." (without saying what, how, or when)
- Draws boxes without explaining the data flow between them

**What you miss:**
- Cannot estimate QPS with actual numbers — says "it depends" and moves on
- No data model: says "we store user data in the database" without schema
- Jumps to architecture after 90 seconds of requirements
- When asked "what if the database goes down?" — silence or "we use a replica"
- Uses Kafka/Redis/microservices without explaining the why
- Does not ask clarifying questions proactively

**Signs you're at Level 1:**
- You spend most of 45 minutes drawing boxes
- You can't explain what flows between components (the arrows on the diagram)
- When the interviewer pushes back, you agree immediately without defending
- You cannot complete a capacity estimate end-to-end
- You skip failure handling entirely until prompted

**How to level up to Level 2:**
1. Memorize the 45-minute format cold: 5 requirements → 5 estimation → 15 HLD → 10 deep dive → 10 bottlenecks
2. Practice estimation daily: for every service you use, estimate its QPS and storage
3. For every component you draw, write one sentence: "This component does X, stores Y, talks to Z over W"
4. Memorize 3 failure modes per component type (DB, cache, queue, external API)
5. Complete 10 mock interviews on Level 1 systems: URL shortener, rate limiter, notification service

---

### Level 2 — L4 Engineer

**Common profile:** Engineers with 1–3 years of experience. Can complete a design but leaves gaps.

**What you typically say:**
- "For storage I'll use PostgreSQL with an index on user_id and created_at."
- "We need Kafka here because notification sending is slow and we don't want to block order creation."
- "If the cache is down, we fall back to the database."

**What you miss:**
- Estimation too round: says "about 1000 QPS" without showing math
- Failure handling is shallow: "we retry" without retry policy, backoff, or DLQ
- Does not quantify tradeoffs: "SQL is slower than NoSQL here" — by how much? at what scale?
- Data model exists but missing critical indexes or partition keys
- Waits for interviewer to ask about each topic — doesn't drive
- Does not proactively raise consistency model for their design

**Signs you're at Level 2:**
- You complete a full design in 45 minutes — that's real progress
- You can answer most follow-up questions
- You struggle with "what happens at 10x traffic?" or "what's the weakest part?"
- Your failure handling section appears only when prompted

**How to level up to Level 3:**
1. Always show estimation math, every step: DAU → requests/user/day → QPS → storage/day → storage/year
2. For every tradeoff, state cost of both options: latency, cost, operational complexity, consistency
3. Add a "failure section" proactively before the interviewer asks
4. Practice "what at 10x traffic?" for 5 different systems until it's automatic
5. Study consistency models: know exactly when to use eventual vs. read-your-writes vs. linearizable
6. After every mock, ask yourself: "What did I not address until the interviewer prompted me?"

---

### Level 3 — L5 Engineer

**Common profile:** Mid-senior engineers with 4–7 years of experience. Drives the design, handles tradeoffs proactively.

**What you typically say:**
- "I'll use consistent hashing with 150 virtual nodes so when we add a node, only K/N keys need remapping."
- "Fanout-on-write gives O(1) read at O(N) write cost. Given our read-heavy traffic, I'd start there and add fanout-on-read for users with > 10K followers."
- "I'll set up a DLQ with an alert if depth exceeds 100 — that signals a systemic failure."
- Proactively: "One failure mode I'm worried about is the cache stampede when the hot key expires. Here's how I handle it..."

**What you miss:**
- Operational concerns: deployment strategy, alert thresholds, on-call runbooks, rollback plan
- Cross-cutting concerns: security (auth, input validation, rate limiting), cost optimization
- System evolution: "How does this design change at 100x in 2 years?"
- Occasionally over-engineers: proposes complex solutions before checking if simpler ones fit

**Signs you're at Level 3:**
- Interviewers say "good, let's go deeper" and you have more substance to offer
- You drive the conversation without waiting for prompts
- Failure scenarios are raised naturally with quantified impact
- Tradeoffs are always explicit and tied to the stated constraints

**How to level up to Level 4:**
1. Add an "operations" section to every design: what metrics do you alert on? What does the runbook say?
2. Practice cost analysis: estimate monthly AWS bill for your design
3. Discuss evolution explicitly: "At 10x I'd shard the DB. At 100x I'd move to a globally distributed DB."
4. Study real postmortems: AWS, Cloudflare, GitHub, Slack incident reports
5. Practice making bold tradeoff calls: "I'm choosing to sacrifice consistency here and here's the product impact that makes it acceptable."

---

### Level 4 — L6+ / Staff Engineer

**Common profile:** Very senior engineers. They simplify, question assumptions, and drive the room.

**What you typically say:**
- "Before I start, let me identify the single hardest problem. It's not the storage — it's the consistency model for concurrent writes. Let me drive toward that."
- "I intentionally made this component stateless so it deploys anywhere and restarts without ceremony. State lives here and only here."
- "Actually, I'd push back on microservices here. The operational overhead of 5 services for this scale isn't worth it. A modular monolith is faster to operate for 3 years."
- "Let me draw the failure modes first, then work backward to the architecture that survives them."

**What distinguishes this level:**
- Simplifies rather than adding complexity — actively removes unnecessary components
- Makes consistency/availability tradeoffs with product impact explicitly articulated
- Thinks about operational toil and team ownership, not just technical correctness
- Surfaces implicit requirements the interviewer didn't mention
- Knows when NOT to use Kafka, Redis, microservices — and says so clearly
- Security, compliance, cost are treated as first-class design constraints

**Signs you're at Level 4:**
- Interviewers say "interesting, I hadn't considered that"
- You politely disagree with the interviewer's suggestion and are right
- You scope the interview yourself: "I'll focus on X — that's the hardest part; Y is straightforward"
- You propose monitoring and failure drills as part of the architecture, not as afterthoughts

**Maintaining Level 4:**
- Read distributed systems papers: Dynamo, Spanner, Kafka, Raft, Chord
- Contribute to production architecture reviews at work
- Study failure modes from real incidents; build postmortem muscle
- Mentor others — explaining forces clarity on your own understanding

---

## Part IV: Post-Interview Debrief Template

Run this within **15 minutes** of ending any practice session. Track answers over time to find patterns in your gaps.

```text
POST-MOCK DEBRIEF
=================
Date:
Prompt:
Time taken:
Calibration level I performed at (1-4):

REQUIREMENTS PHASE
------------------
1. Did I clarify before designing?               [ ] Yes  [ ] No  [ ] Partially
2. Requirements I missed:
3. Assumptions I incorrectly made:
4. Would my design change if I had clarified?    [ ] Yes  [ ] No  (explain):

ESTIMATION PHASE
----------------
5. Did I estimate scale before architecting?     [ ] Yes  [ ] No
6. Was my math reasonable?                       [ ] Yes  [ ] Off by >10x
7. Did I use a peak factor?                      [ ] Yes  [ ] No
8. What I'd estimate differently:

DESIGN PHASE
------------
9.  Did I cover the happy path end-to-end?       [ ] Yes  [ ] No
10. Did I cover the failure path?                [ ] Yes  [ ] Partially  [ ] No
11. Did I proactively raise tradeoffs?           [ ] Yes  [ ] Only when asked  [ ] No
12. Did I explain WHY each component exists?     [ ] Yes  [ ] Some  [ ] No
13. Did I discuss the data model?                [ ] Yes  [ ] Skipped
14. Did I discuss the API?                       [ ] Yes  [ ] Skipped
15. Did I raise consistency model?               [ ] Yes  [ ] No

COMMUNICATION
-------------
16. Did I drive the interview or react to it?    [ ] Drove  [ ] Reacted
17. Did I use concrete numbers?                  [ ] Yes  [ ] Sometimes  [ ] No
18. Did I summarize at the end?                  [ ] Yes  [ ] No
19. When pushed back, did I defend or immediately capitulate?  [ ] Defended  [ ] Capitulated

GAPS IDENTIFIED
---------------
20. One concept I was fuzzy on:
21. One component I couldn't explain clearly:
22. The hardest follow-up question I got:
23. What would I answer differently:

ACTION ITEMS FOR NEXT SESSION
------------------------------
24. One concept to drill before next mock:
25. One reading or resource to review:
26. One communication habit to practice:
```

**How to use this over time:** After 10 sessions, tally your `[ ] No` answers across all 26 questions. The question with the most "No" answers is your biggest skill gap. Design next week's drills around that specific gap.
