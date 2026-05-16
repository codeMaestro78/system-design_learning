# Part 10: Interview + Senior Engineering Thinking

## 1) How to approach system design interviews

### Framework
1. Clarify requirements (functional + non-functional)
2. Estimate scale
3. Define APIs and data model
4. Present HLD
5. Deep dive one critical path
6. Discuss bottlenecks + scaling
7. Failure handling and tradeoffs

### Interview signal
Interviewers evaluate reasoning quality, not architecture buzzwords.

---

## 2) How to communicate tradeoffs

Always compare options:
- Option A: faster now, lower complexity
- Option B: stronger guarantees, higher cost
- Decision tied to constraints and SLOs

Use language:
"Given X traffic and Y correctness requirement, I choose Z because..."

---

## 3) Common mistakes
- Jumping to solution before requirements
- Ignoring estimation
- No failure story
- No consistency reasoning
- Over-designing early

---

## 4) How senior engineers think
- Design for change, not static perfection.
- Keep blast radius small.
- Prefer operable systems over theoretically elegant but fragile ones.
- Bias toward clear ownership and reliable interfaces.

---

## 5) Communication template for whiteboard/live interview
```text
Assumptions -> Requirements -> Scale -> HLD -> Deep Dive -> Tradeoffs -> Failure Plan
```

## Practice prompts
1. Design Slack channels with message history.
2. Design payment webhook retry system.
3. Design feature flag service with low-latency reads.

## Sophisticated Senior-Thinking Roadmap

### What senior interviewers look for
- You clarify scope before architecture.
- You quantify scale before choosing storage.
- You separate hot paths from async paths.
- You identify the first bottleneck.
- You state consistency contracts.
- You explain failure handling without hand-waving.
- You make cost-aware and team-aware choices.

### Senior communication structure
```text
Product promise
  -> Requirements
  -> Scale
  -> Data model
  -> Baseline architecture
  -> Critical path
  -> Bottlenecks
  -> Failure handling
  -> Security
  -> Evolution
```

### Example strong framing
"For the first version, I would keep this as a modular monolith with a relational database because the team is small and the transaction boundary is still simple. I would introduce a queue for notifications immediately because email delivery should not block checkout. Once order volume grows, I would split the payment adapter and inventory reservation paths behind idempotent APIs."

### Real-world examples to practice
- Payment webhook delivery.
- Feature flag service.
- Multi-tenant metrics platform.
- Global file upload service.
- Realtime collaboration document.

### Design exercise
Explain the same system at three levels:
- 2-minute executive summary.
- 10-minute engineering design review.
- 45-minute interview deep dive.

## Rigorous Interview Rubric

### Scoring dimensions
```text
Dimension              Weak answer                         Strong answer
Requirements           jumps to boxes                      clarifies scope and exclusions
Scale                  vague "large scale"                 calculates QPS/storage/fanout
Data model             generic DB choice                   schema/indexes/access patterns
Architecture           buzzword diagram                    justified components and flows
Consistency            ignored                             per-feature consistency contract
Failure handling       "we retry"                          timeout, retry budget, idempotency, DLQ
Operations             absent                              metrics, alerts, deploy, rollback
Tradeoffs              no alternatives                     compares options and chooses
```

### Senior-level close
End every design with:
- The simplest version I would ship first.
- The first bottleneck I expect.
- The first failure I would rehearse.
- The metric I would watch daily.
- The next architecture change at 10x traffic.

---

## Senior-Level Communication Patterns

### High-signal phrasing
- "Given X constraint, I prioritize Y because..."
- "The failure mode here is..., so I add..."
- "If scale doubles, first bottleneck is likely..., and mitigation is..."

### When interviewer pushes back
Respond with:
1. acknowledge concern
2. restate assumptions
3. present alternative and cost
4. choose based on stated priority

### Whiteboard anti-fragility
If you forgot a detail:
- explicitly mark assumption,
- continue flow,
- revisit and refine with tradeoff.

### Final 2-minute close template
1. recap architecture
2. recap key tradeoffs
3. recap failure handling
4. mention next scaling evolution

---

## Complete Interview Walkthrough: Design a Feed System (45 minutes simulated)

---

### [0-3 min] Clarify Requirements

**What you say:**
> "Before designing, let me clarify scope. Are we building Twitter-style public feed, or Facebook-style friend feed? Do we need real-time updates or eventual consistency? Read-heavy or write-heavy? Any geographic constraints?"

**Interviewer evaluates:**
- Does the candidate ask the right questions?
- Do they separate product requirements from technical ones?
- Are they asking about constraints that actually change the architecture?

**Common mistake:** Jumping straight to "We need Kafka and Redis" without asking what the product is.
This signals that you have a memorized answer, not a thinking process.

**What to clarify before drawing a single box:**
- Feed type: public / friend / algorithmic ranking?
- Freshness requirement: real-time (<1s), near-real-time (<10s), eventual (<60s)?
- Read:write ratio?
- Regions: single-region or global deployment?
- Post types: text only, or media (images, video)?

---

### [3-8 min] Scale Estimation

**What you say:**
> "Let's say 100M DAU. Each user reads feed 5 times/day = 500M feed reads/day = 5,800 reads/sec average,
> 30K/sec peak. 10% post = 10M posts/day = 116 writes/sec. Average user has 200 followers =
> 10M posts/day × 200 = ~2B fanout writes/day. That's the critical number."

**Detailed calculation:**
```
DAU:                    100M
Feed reads/user/day:    5
Total feed reads/day:   500M
Avg reads/sec:          500M / 86,400 ≈ 5,800
Peak reads/sec:         ~30,000  (assume 5x average)

Posting users/day:      10% of DAU = 10M
Posts/sec:              10M / 86,400 ≈ 116
Avg followers/user:     200
Fanout writes/day:      10M × 200 = 2B
Fanout writes/sec:      ~23,000
```

**Interviewer evaluates:**
- Can they calculate fanout correctly?
- Do they spot that fanout writes are the hard problem, not direct writes?
- Do they distinguish average vs peak load?

**Common mistake:** Only counting direct writes (116/sec), forgetting that each write fans out to
followers (23K/sec). This 200× multiplier is what breaks naive architectures.

---

### [8-18 min] Data Model + API

**Core tables:**
```sql
-- Users
CREATE TABLE users (
  id         BIGINT PRIMARY KEY,
  username   VARCHAR(50)  UNIQUE NOT NULL,
  follower_count BIGINT   DEFAULT 0,
  created_at TIMESTAMP    DEFAULT NOW()
);

-- Posts
CREATE TABLE posts (
  id         BIGINT PRIMARY KEY,
  author_id  BIGINT       REFERENCES users(id),
  content    TEXT         NOT NULL,
  media_url  VARCHAR(500),
  created_at TIMESTAMP    DEFAULT NOW()
);
CREATE INDEX idx_posts_author_time ON posts(author_id, created_at DESC);

-- Social graph
CREATE TABLE followers (
  follower_id  BIGINT REFERENCES users(id),
  followee_id  BIGINT REFERENCES users(id),
  created_at   TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY  (follower_id, followee_id)
);
CREATE INDEX idx_followers_followee ON followers(followee_id);

-- Pre-computed per-user timeline (fan-out on write target)
CREATE TABLE timeline (
  user_id    BIGINT REFERENCES users(id),
  post_id    BIGINT REFERENCES posts(id),
  author_id  BIGINT,
  created_at TIMESTAMP,
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX idx_timeline_user_time ON timeline(user_id, created_at DESC);
```

**3 core API endpoints:**
```
POST /posts
  Body:     { content: string, media_url?: string }
  Response: { post_id: string, created_at: timestamp }
  Auth:     Bearer token required

GET /feed/{user_id}?cursor=<timestamp>&limit=20
  Response: { posts: [...], next_cursor: timestamp, has_more: bool }
  Note:     cursor-based pagination, not offset — stable under concurrent writes

GET /posts/{post_id}/likes
  Response: { count: int, liked_by_me: bool, top_likers: [...] }
```

**Why cursor over offset:** At 30K reads/sec, `OFFSET N` on Postgres requires scanning N rows.
Cursor-based (`WHERE created_at < cursor`) uses the index and is O(log n).

---

### [18-32 min] High-Level Architecture

```
                        ┌─────────────┐
                        │   Clients   │
                        │ (Web/Mobile)│
                        └──────┬──────┘
                               │ HTTPS
                        ┌──────▼──────┐
                        │ API Gateway │
                        │(Auth + R/L) │
                        └──────┬──────┘
                               │
                  ┌────────────▼────────────┐
                  │       Feed Service       │
                  │  (stateless, N replicas) │
                  └────┬──────────────┬──────┘
                       │              │
        ┌──────────────▼──┐     ┌─────▼──────────────┐
        │   Post DB        │     │  Timeline Cache     │
        │   (Postgres)     │     │  (Redis Sorted Set) │
        │   source of      │     │  score = timestamp  │
        │   truth          │     │  member = post_id   │
        └──────────────────┘     └─────────────────────┘
                       │
               ┌───────▼────────┐
               │  Fanout Worker │
               │  (Kafka / SQS) │
               └────────────────┘
```

**Fan-out on write (push model):**
- When a user posts, immediately write post_id to every follower's timeline in Redis.
- Feed read = single `ZREVRANGE` call. Very fast, O(log n + k).
- Problem: celebrity with 10M followers = 10M Redis writes on one post.

**Fan-out on read (pull model):**
- When a user opens the feed, query posts from everyone they follow.
- No pre-computation, feed is always fresh.
- Problem: at 100M DAU, you're joining followers + posts on every read. Too slow.

**Decision for 100M DAU:** Fan-out on write for regular users, with celebrity carve-out (next section).

---

### [32-40 min] Deep Dive: Handle Celebrity Problem

**Problem statement:**
- Naive fanout: celebrity with 10M followers = 10M Redis writes every post.
- If celebrity posts 10 times/day: 100M Redis writes/day from one account.
- At peak, a celebrity tweets during a live event: millions of writes in seconds.
- Redis pipeline does ~100K ops/sec per node. 10M writes = 100 seconds of backlog. Unacceptable.

**Solution: Hybrid Fan-out**
```
On POST /posts:
  if author.follower_count < CELEBRITY_THRESHOLD (e.g. 10,000):
    → fan-out on write: push post_id to all follower timelines in Redis
  else:
    → skip Redis fanout: store post in Post DB only, flag author as "celebrity"

On GET /feed/{user_id}:
  1. Fetch pre-computed timeline from Redis   (fan-out-on-write users)
  2. Fetch list of celebrity accounts user follows
  3. For each celebrity: query Post DB for their recent N posts
  4. Merge results sorted by timestamp
  5. Return unified, paginated feed
```

**Pseudocode:**
```python
CELEBRITY_THRESHOLD = 10_000

def get_feed(user_id, cursor, limit=20):
    # Step 1: pre-computed timeline from Redis sorted set
    timeline_posts = redis.zrevrangebyscore(
        f"timeline:{user_id}",
        max=cursor,
        min="-inf",
        start=0,
        num=limit * 2          # fetch extra to cover merge gaps
    )

    # Step 2: celebrity accounts this user follows
    celebrity_ids = db.query("""
        SELECT f.followee_id FROM followers f
        JOIN users u ON f.followee_id = u.id
        WHERE f.follower_id = %s
          AND u.follower_count >= %s
    """, user_id, CELEBRITY_THRESHOLD)

    # Step 3: fetch recent celebrity posts from DB
    celebrity_posts = []
    for celeb_id in celebrity_ids:
        posts = db.query("""
            SELECT id, created_at FROM posts
            WHERE author_id = %s AND created_at < %s
            ORDER BY created_at DESC LIMIT %s
        """, celeb_id, cursor, limit)
        celebrity_posts.extend(posts)

    # Step 4: merge and sort descending by timestamp
    all_posts = timeline_posts + celebrity_posts
    all_posts.sort(key=lambda p: p.created_at, reverse=True)
    return all_posts[:limit]
```

**Tradeoff:** Slightly more complex read path. But writes remain bounded regardless of follower count,
and the DB queries for celebrities are indexed and fast.

---

### [40-45 min] Tradeoffs + Close

**What to say word-for-word:**

> "The simplest version I'd ship: fan-out on read with Postgres. Add Redis timeline cache when
> p99 feed latency exceeds 200ms. Add the hybrid celebrity logic only when a single account's
> fanout is causing measurable write backpressure."

> "First bottleneck I expect: DB read load from popular users' posts being fetched simultaneously
> by thousands of followers on feed open."

> "Metric I'd watch daily: p99 feed load latency. Also Kafka fan-out queue depth — if it grows
> monotonically, writes are outpacing workers and we need to scale consumers."

> "At 10x (1B DAU): split read/write DB replicas, shard timeline Redis by user_id mod N,
> add geographic sharding for regional latency SLOs."

**Why the close matters:** You are not just designing for today. You are showing the interviewer
that you think in phases and know the specific levers to pull at each scale transition.

---

## 5 System Design Prompts with Structured Answer Outlines

---

### Prompt A: Feature Flag Service

**Requirements clarification:**
- Who writes flags: engineers only, or product managers via a UI?
- Targeting: simple on/off, or per-user / percentage / segment rollout?
- Latency requirement: flag evaluation runs on every API request — must be < 1ms.
- Consistency: OK if a user sees the old flag value for 10 seconds? (Usually yes.)

**Scale estimates:**
```
API calls/sec:       1,000,000  (1M evaluations/sec)
Total flags:         10,000
Flag writers:        50 engineers
Reads : Writes       ~1,000,000 : 1    (extremely read-heavy)
```

**Key insight — control plane vs data plane:**
```
Control Plane  (low traffic, high consistency):
  Engineer writes flag → stored in Postgres → change propagated out

Data Plane  (high traffic, ultra-low latency):
  API server evaluates flag → must be in-memory local, NOT a network call
  Even 1ms Redis round-trip × 1M req/sec = 1,000 server-seconds added latency/sec
```

**Data model:**
```sql
CREATE TABLE feature_flags (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  enabled     BOOLEAN   DEFAULT FALSE,
  rollout_pct SMALLINT  DEFAULT 0,        -- 0–100 percentage rollout
  targeting   JSONB,                      -- { "user_ids": [...], "regions": [...] }
  created_by  VARCHAR(50),
  created_at  TIMESTAMP DEFAULT NOW(),
  updated_at  TIMESTAMP DEFAULT NOW()
);

CREATE TABLE flag_audit_log (
  id         BIGSERIAL PRIMARY KEY,
  flag_id    UUID      REFERENCES feature_flags(id),
  changed_by VARCHAR(50),
  old_value  JSONB,
  new_value  JSONB,
  changed_at TIMESTAMP DEFAULT NOW()
);
```

**Architecture:**
```
Engineer writes flag
  → Control-plane API
  → Postgres (source of truth)
  → Publishes change event to Redis Pub/Sub

SDK embedded in each application server:
  → Subscribes to Redis Pub/Sub channel
  → Maintains in-memory map of all flags
  → Evaluates flags locally — zero network I/O per evaluation
  → Polls Postgres every 30s as a safety net for missed events
```

**Flag evaluation — critical path (must be < 1ms):**
```python
def is_enabled(flag_name: str, user_id: str) -> bool:
    flag = LOCAL_FLAG_CACHE.get(flag_name)
    if not flag:
        return False           # default-off: safe failure

    if not flag.enabled:
        return False

    if flag.rollout_pct == 100:
        return True

    # Consistent bucket: same user always lands in the same bucket
    bucket = hash(f"{flag_name}:{user_id}") % 100
    return bucket < flag.rollout_pct
```

**Failure modes:**
- SDK can't reach Postgres on startup → load last-known-good snapshot from local disk cache.
- Redis Pub/Sub drops a message → 30-second poll catches drift; max staleness is bounded.
- Flag misconfiguration → audit log enables instant rollback; gradual rollout limits blast radius.

---

### Prompt B: Payment Webhook Retry System

**Why webhooks fail:**
- Customer's server is temporarily down (deploy, restart, crash).
- Customer's server returns 5xx (bug in their handler).
- Network timeout: our request times out before their server responds.
- Customer's server is slow: responds in 30s, we timeout at 10s.

**Requirements:**
- At-least-once delivery: must not silently drop webhooks.
- Exponential backoff: avoid hammering a failing endpoint.
- Customer-configurable timeout: default 10s, customer can configure 5–30s.
- Dead-letter after N failures: move to dead queue, alert customer via email/dashboard.
- Signature: HMAC-SHA256 in header so customer can verify authenticity.

**Retry schedule:**
```
Attempt 1:  immediate
Attempt 2:  1 minute  after failure
Attempt 3:  5 minutes
Attempt 4:  30 minutes
Attempt 5:  2 hours
Attempt 6:  12 hours
Attempt 7:  24 hours
→ Dead Letter Queue — notify customer, expose manual retry UI
```

**State machine:**
```
             ┌──────────┐
             │  PENDING │  created, not yet attempted
             └────┬─────┘
                  │ worker picks up
             ┌────▼──────┐
             │ IN-FLIGHT │  HTTP request in progress
             └────┬──────┘
         ┌────────┼──────────┐
      2xx│     4xx│       5xx│ / timeout
    ┌────▼───┐ ┌──▼──────┐ ┌─▼────────┐
    │DELIVER-│ │INVALID  │ │  FAILED  │  will retry
    │  ED    │ │(no retry│ └────┬─────┘
    └────────┘ └─────────┘      │ after max_attempts
                            ┌───▼──────┐
                            │   DEAD   │
                            └──────────┘
```

**Task queue schema:**
```sql
CREATE TABLE webhook_deliveries (
  id              UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID      NOT NULL,
  endpoint_url    VARCHAR(500) NOT NULL,
  payload         JSONB     NOT NULL,
  state           VARCHAR(20)  DEFAULT 'PENDING',
  attempt_count   INT       DEFAULT 0,
  max_attempts    INT       DEFAULT 7,
  next_attempt_at TIMESTAMP DEFAULT NOW(),
  last_error      TEXT,
  created_at      TIMESTAMP DEFAULT NOW(),
  delivered_at    TIMESTAMP
);
-- Index only pending/failed rows due for retry
CREATE INDEX idx_webhook_next_attempt
  ON webhook_deliveries(next_attempt_at)
  WHERE state IN ('PENDING', 'FAILED');
```

**Idempotency key in request headers:**
```
POST /customer-endpoint
Headers:
  X-Webhook-ID:        <uuid-of-this-delivery>
  X-Webhook-Timestamp: 1710000000
  X-Webhook-Signature: sha256=<hmac-sha256-of-payload>
```
Customer stores processed `X-Webhook-ID` values and deduplicates on retry.

**Worker pseudocode:**
```python
def process_due_webhooks():
    rows = db.query("""
        SELECT * FROM webhook_deliveries
        WHERE state IN ('PENDING', 'FAILED')
          AND next_attempt_at <= NOW()
        LIMIT 100
        FOR UPDATE SKIP LOCKED
    """)

    for row in rows:
        try:
            resp = http.post(row.endpoint_url, json=row.payload, timeout=10)
            if 200 <= resp.status_code < 300:
                db.update(row.id, state='DELIVERED', delivered_at=NOW())
            elif 400 <= resp.status_code < 500:
                db.update(row.id, state='INVALID')  # do not retry 4xx
            else:
                schedule_retry(row)
        except TimeoutError as e:
            schedule_retry(row, error=str(e))

def schedule_retry(row, error=None):
    delays_sec = [0, 60, 300, 1800, 7200, 43200, 86400]
    next_attempt = row.attempt_count + 1
    if next_attempt >= row.max_attempts:
        db.update(row.id, state='DEAD', last_error=error)
        notify_customer(row)
    else:
        delay = delays_sec[next_attempt]
        db.update(row.id,
            state='FAILED',
            attempt_count=next_attempt,
            next_attempt_at=NOW() + delay,
            last_error=error)
```

---

### Prompt C: Distributed Rate Limiter Deep Dive

After your initial design, the interviewer probes with follow-up questions. Here are the exact
questions and strong answers.

**"What if Redis goes down?"**
- **Option A (fail-open):** Allow all requests. Risk: abuse during outage window.
- **Option B (fail-closed):** Reject all requests. Risk: your product goes down too.
- **Option C (local fallback):** Each API server maintains an in-memory rate limiter as fallback.
  Less accurate (can't coordinate across servers) but keeps the service alive.
- **Strong answer:**
  > "I'd fail-open for general endpoints where abuse risk is tolerable. I'd fail-closed for
  > auth and payment endpoints where abuse is immediately damaging. During a Redis outage,
  > a brief burst on the general API is a smaller blast radius than rejecting legitimate
  > checkouts or logins."

**"How do you handle clock skew between servers?"**
- Problem: if Server A thinks it's 12:00:00.000 and Server B thinks it's 12:00:00.500,
  sliding window calculations disagree.
- Solution: always use the Redis server's clock via the `TIME` command, not client-side time.
  Redis is single-threaded so its clock is the authoritative reference.
- Never trust client-supplied timestamps (`X-Forwarded-For` time fields) for rate limiting.

**"What about hot partitions? One user hammering a single key?"**
- Problem: if the key is `rate_limit:{user_id}`, a single aggressive user concentrates all
  Redis operations on one key.
- Clarification: Redis is single-threaded per-key, so one hot key doesn't block other keys.
  The real risk is memory bandwidth from one client saturating a network link.
- Solution for multi-tenant cardinality explosion: shard the counter across N sub-keys:
  `rate_limit:{user_id}:{shard 0-9}`, read all N and sum. Reduces per-key pressure.

**"Token bucket vs sliding window log vs fixed window — when do you choose each?"**
```
Fixed window:     Simple. Allows up to 2× burst at the window boundary edge.
Sliding window:   Accurate. Memory cost = O(requests in window) per user.
Token bucket:     Smooth bursts allowed up to capacity. Good for user-facing APIs.
Leaky bucket:     Strict constant rate, queues excess. Good for protecting downstream DB.
```
> "Token bucket for user-facing APIs — allows small natural bursts for good UX.
> Leaky bucket for calls to downstream services — smooths spikes, protects the DB."

---

### Prompt D: Real-Time Collaborative Document (Google Docs)

**Key challenge:** Two users edit simultaneously. Naive last-write-wins corrupts the document.

**Why you can't use locks:**
- A user holds the document open for minutes or hours.
- You cannot hold a lock for the entire editing session.
- You need optimistic concurrency with deterministic conflict resolution.

**Operational Transformation (OT) — simple example:**
```
Initial state:  "Hello World"

User A (at position 5):  DELETE 1 char  →  removes space  →  "HelloWorld"
User B (at position 6):  INSERT "!"     →  "Hello !World"

Both operations happen simultaneously.

Without OT:  applying both naively produces garbage.

With OT:
  A's DELETE shifts every position after index 5 by -1.
  B's INSERT at position 6 must be transformed:
    transform(insert(pos=6, char="!"), delete(pos=5, count=1))
    → delete.pos < insert.pos, so:  insert.pos -= delete.count  →  insert.pos = 5
  Result:  "Hello!World"  ✓

Transform rule for this case:
  if concurrent_delete.pos < my_insert.pos:
      my_insert.pos -= concurrent_delete.count
```

**CRDT as an alternative:**
- CRDTs (Conflict-free Replicated Data Types) use algebraic structures that always merge
  correctly without a central coordinator.
- Simpler to prove correct than OT but historically had performance issues.
- Modern implementations (Yjs, Automerge) are fast enough for production.
- Google Docs uses OT. Figma uses CRDTs.

**Architecture:**
```
                ┌────────────────────────┐
Clients ──WS───►│   WebSocket Gateway    │
(A, B, C...)    │   (sticky sessions)    │
                └──────────┬─────────────┘
                           │ raw operations + parent_version
                ┌──────────▼─────────────┐
                │      OT Server         │
                │  (single leader per    │
                │   document shard)      │
                └──────────┬─────────────┘
                           │ transformed + applied ops
                ┌──────────▼─────────────┐
                │    Document Store      │
                │  Append-only op log    │  ← NOT current state
                │  Snapshot every 100ops │
                └────────────────────────┘
```

**Why store operations, not current state:**
- Undo/redo requires the full operation history.
- Conflict resolution requires replaying operations from a common ancestor.
- Current state is derived: latest snapshot + replay of all ops since that snapshot.

**Key implementation detail:** Each operation carries a `parent_version` (the server version it
was based on when the client started the edit). The OT server uses this to determine which
concurrent operations need to be transformed against before applying.

---

### Prompt E: Multi-Tenant Metrics Platform

**Isolation options and tradeoffs:**
```
Option                       Isolation   Cost     Complexity
Shared DB, shared table      Low         Low      Low
Shared DB, per-tenant schema Medium      Medium   Medium
Separate DB per tenant       High        High     High
```
**Best answer:** Start with shared DB + `tenant_id` on every table, enforced with row-level
security at the DB layer. Offer a dedicated DB as a premium tier for compliance-sensitive tenants.

**The cardinality explosion problem:**
- Prometheus-style metric: `http_requests_total{service="api", region="us-east", user_id="u12345"}`
- If `user_id` has 1M unique values, you have 1M unique time series for a single metric name.
- Each unique label combination = a separate time series = separate storage row and index entry.
- At 1M users × 100 metric names = 100M active time series. Storage and query cost explodes.

**Solution — pre-aggregate before storing:**
```
Bad:   store raw { user_id: "u1", latency_ms: 45 }
       store raw { user_id: "u2", latency_ms: 60 }
       ...1M rows per minute

Good:  store aggregated { service: "api", p50: 45, p99: 120, count: 50_000 }
       ...1 row per minute per service

Rule: never store high-cardinality identifiers (user_id, session_id, request_id)
      as metric labels. Use them in distributed traces (sampled) instead.
```

**ClickHouse for columnar analytics:**
- Row-store (Postgres): reading the `p99_latency` column across 1M rows requires reading
  every full row (all columns) from disk.
- ClickHouse (columnar): each column is stored contiguously. Reading `p99_latency` across
  1M rows reads only that column's data pages.
- Compression: 10–15× better for numeric time series (similar adjacent values compress well).
- Query speed: 100× faster for aggregations (SUM, AVG, quantile) over large datasets.
- Trade-off: ClickHouse is append-optimized. Not suitable for transactional updates or point deletes.

**Multi-tenant query isolation:**
```sql
-- Every query is automatically scoped to tenant via WHERE tenant_id = ?
SELECT
    toStartOfHour(timestamp)       AS hour,
    quantile(0.99)(latency_ms)     AS p99
FROM metrics
WHERE tenant_id  = {tenant_id}
  AND metric_name = 'http_request_latency'
  AND timestamp  >= NOW() - INTERVAL 24 HOUR
GROUP BY hour
ORDER BY hour;
```

---

## Senior Vocabulary: Weak vs Strong Phrasing

The words you choose signal your experience level as much as the architecture you draw.

| # | Scenario | Weak Phrasing | Strong Phrasing |
|---|----------|--------------|-----------------|
| 1 | Choosing a database | "I'll use Postgres because it's reliable." | "Given our access pattern — point reads by user_id with occasional range scans by date — Postgres with a composite index on (user_id, created_at) handles this well. If we cross 10M rows per table, I'd revisit partitioning." |
| 2 | Handling failures | "We'll retry if it fails." | "We use exponential backoff with jitter, cap at 3 attempts, and route failures to a dead-letter queue. Idempotency keys prevent double-processing on retry." |
| 3 | Cache invalidation | "We'll clear the cache when data changes." | "We use write-through with a 5-minute TTL as a safety net. On write, we DEL the key before committing the DB change — not after — to avoid a race where a stale read re-populates the cache between the write and the delete." |
| 4 | Scale concern | "This won't scale." | "At current QPS this works fine, but at 10× we'll hit connection pool exhaustion on Postgres. I'd add a read replica and PgBouncer at that point. Want me to design for 10× now, or treat it as a documented next step?" |
| 5 | Consistency | "We need strong consistency." | "Checkout and inventory deduction need to be atomic — I'd use a DB transaction here. Notification delivery can tolerate eventual consistency since a 10-second email delay doesn't affect correctness." |
| 6 | Technology choice | "Let's use Kafka." | "We need durable async processing with replay, which rules out SQS. Kafka fits if we own the infra; Kinesis if we want managed. Given team size and ops burden, I'd start with Kinesis and migrate when replay becomes a hard requirement." |
| 7 | Complexity | "That's too complex." | "The marginal benefit doesn't justify the operational complexity at our current scale. I'd defer it and document it as a known scaling lever to pull at 100×." |
| 8 | Starting a design | "OK so we need a load balancer, a backend, then a database..." | "Let me start with the user-facing promise: sub-100ms feed loads for 100M users. That shapes the read path first. Then I'll work backward to the write path and fanout model." |
| 9 | Interviewer pushback | "Oh yeah, you're right, that won't work." | "That's a valid concern. If the bottleneck is X, then Y is indeed a problem. One mitigation is Z — the tradeoff is added latency on the write path. Given our SLO, that's acceptable. Does that address your concern?" |
| 10 | Closing a design | "So yeah, that's basically the system." | "To close: the simplest version I'd ship is [A]. The first failure I'd rehearse is [B]. The first bottleneck I expect at 10× is [C], and the mitigation is [D]. Happy to go deeper on any component." |

---

## Anti-Patterns and Recovery

Even experienced engineers hit walls during interviews. What separates senior candidates is
the ability to recover smoothly and systematically.

---

### Anti-Pattern 1: Jumping to Architecture Without Requirements

**What it looks like:**
> "OK so for Twitter, we need Kafka for fanout, Redis for caching timelines, and Cassandra for..."

**Why it's a red flag:** The interviewer doesn't know if you can think about product requirements
or constraints. You might be solving the wrong problem with a memorized answer.

**Recovery script:**
> "Actually, let me pause — I jumped ahead. Let me clarify requirements first.
> Are we building a public tweet feed or a private-follow model? Do we need real-time delivery
> or eventual consistency? This changes the architecture significantly."

**Then:** proceed with clarification → estimation → architecture in order. The pause and pivot
itself is a positive signal.

---

### Anti-Pattern 2: Naming Technologies Without Justification

**What it looks like:**
> "We need Redis for caching, Kafka for messaging, Elasticsearch for search,
> and Kubernetes for orchestration."

**Why it's a red flag:** You sound like you're reciting a tech stack, not reasoning about
requirements. Any senior interviewer will probe: "Why Kafka and not SQS?" If you have no
data-driven answer, it's a serious red flag.

**Recovery script:**
> "Let me justify that Kafka choice. We need durable async processing with replay capability —
> if a consumer falls behind, we must replay messages. SQS doesn't support replay.
> If we don't need replay, SQS is simpler to operate and cheaper.
> Given this is a first version with a small team, I'd actually start with SQS
> and migrate to Kafka when replay becomes a hard requirement."

---

### Anti-Pattern 3: Ignoring Failure Modes

**What it looks like:**
You describe the happy path perfectly. The interviewer asks "What happens when your cache goes
down?" and you say "We'd fall back to the database."

**Why it's a red flag:** "Fall back to the database" sounds simple but hides: thundering herd
(all clients hit DB simultaneously), latency spike (cache miss is 100× slower), and connection
pool exhaustion (DB can't handle full load without cache).

**Recovery script:**
> "Good catch. Cache failure isn't graceful by default. If cache goes down, the read load
> shifts entirely to the database, which at our QPS it cannot handle alone. So I'd add:
> (1) a circuit breaker so we stop retrying a dead cache immediately,
> (2) read replicas to absorb the load shift,
> (3) rate limiting on the DB read path to shed load gracefully rather than cascade-fail."

---

### Anti-Pattern 4: Over-Engineering the First Version

**What it looks like:**
> "For the first version, I'd build microservices: separate services for users, posts,
> notifications, search, and recommendations, each with its own database and Kafka bus."

**Why it's a red flag:** This fails operationally at small scale. You need 5 teams to maintain
5 services, distributed tracing to debug, and 5× deployment complexity — before you've proven
product-market fit.

**Recovery script:**
> "Actually, I should scope this differently. For version one with a small team, I'd keep this
> as a modular monolith. The modules are internally separated (user domain, post domain,
> notification domain) but deployed as one process. I'd introduce async queuing only for
> notifications, since email sending shouldn't block the API response. The split into separate
> services happens when we have team ownership to justify the overhead — not before."

---

### Anti-Pattern 5: Freezing on a Hard Follow-Up Question

**What it looks like:**
Interviewer asks: "How would you handle split-brain in your distributed lock?"
You stare for 30 seconds and say "I'm not sure..."

**Why it's a red flag:** You've shown that you don't have a strategy for unknown problems,
which is most of what senior engineers actually face.

**Recovery script — use this exact four-step structure:**

1. **Buy time professionally:**
   > "That's a good edge case. Let me think through it out loud."

2. **State what you know:**
   > "Split-brain means two nodes both believe they hold the lock, which leads to double-processing
   > — dangerous for inventory or payment deduction."

3. **Reason from first principles:**
   > "To prevent that, the lock must be granted by a majority quorum. You need acknowledgment from
   > 3 of 5 nodes before the lock is considered held. Redis Redlock implements this pattern."

4. **Acknowledge the gap honestly if needed:**
   > "I'm less certain about the exact handling when a lock holder is paused by a GC pause longer
   > than the TTL. My instinct is a TTL-based expiry prevents indefinite hold, but I'd review the
   > Redlock paper before implementing this in production."

**This shows:** You can reason under pressure. You know your knowledge boundaries. You're honest,
systematic, and would be safe to work with in production.
