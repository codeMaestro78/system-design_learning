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

---

## Part II: Complete Lab — Build a Mini Twitter in Python

This lab builds a simplified Twitter clone step-by-step. Each step adds one concept. You will see firsthand how a system breaks and how each fix addresses a specific bottleneck.

**Prerequisites:** Python 3.10+, `pip install redis fastapi uvicorn httpx`

---

### Step 1 — Single-User Tweet Storage (SQLite)

Goal: store and retrieve tweets for one user. No complexity yet.

```python
# step1_tweets.py
import sqlite3
import time
from datetime import datetime

DB_PATH = "twitter.db"

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS tweets (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id   INTEGER NOT NULL,
            content   TEXT NOT NULL,
            created_at REAL NOT NULL
        )
    """)
    # Index for fast per-user retrieval, newest first
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_tweets_user_time
        ON tweets(user_id, created_at DESC)
    """)
    conn.commit()
    conn.close()

def post_tweet(user_id: int, content: str) -> int:
    """Insert a tweet. Returns the new tweet id."""
    if len(content) > 280:
        raise ValueError("Tweet exceeds 280 characters")
    conn = sqlite3.connect(DB_PATH)
    cur = conn.execute(
        "INSERT INTO tweets (user_id, content, created_at) VALUES (?, ?, ?)",
        (user_id, content, time.time())
    )
    tweet_id = cur.lastrowid
    conn.commit()
    conn.close()
    return tweet_id

def get_tweets(user_id: int, limit: int = 20) -> list[dict]:
    """Retrieve the last `limit` tweets for a user."""
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id, content, created_at FROM tweets "
        "WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
        (user_id, limit)
    ).fetchall()
    conn.close()
    return [{"id": r[0], "content": r[1], "created_at": r[2]} for r in rows]

if __name__ == "__main__":
    init_db()
    uid = post_tweet(user_id=1, content="Hello, mini Twitter!")
    print(f"Posted tweet id={uid}")
    print(get_tweets(user_id=1))
```

**What you observe:** Single-user reads and writes work instantly. SQLite is fast for < 100K rows. The index on `(user_id, created_at)` is the secret — without it, every feed load is a full table scan.

**Exercise:** Add 100K tweets for user_id=1 using a loop. Measure query time with and without the index using `EXPLAIN QUERY PLAN`.

---

### Step 2 — Add Follower Graph (Adjacency List in SQLite)

Goal: user A can follow user B. We store this as a directed edge.

```python
# step2_followers.py  (extends step1)
import sqlite3

DB_PATH = "twitter.db"

def init_follower_table():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS follows (
            follower_id  INTEGER NOT NULL,
            followee_id  INTEGER NOT NULL,
            PRIMARY KEY (follower_id, followee_id)
        )
    """)
    # Index for "who does user X follow?" lookup (used in fan-out)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_follows_follower
        ON follows(follower_id)
    """)
    # Index for "who follows user X?" lookup (celebrity check)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_follows_followee
        ON follows(followee_id)
    """)
    conn.commit()
    conn.close()

def follow(follower_id: int, followee_id: int):
    """User follower_id follows followee_id."""
    if follower_id == followee_id:
        raise ValueError("Cannot follow yourself")
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)",
        (follower_id, followee_id)
    )
    conn.commit()
    conn.close()

def unfollow(follower_id: int, followee_id: int):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "DELETE FROM follows WHERE follower_id = ? AND followee_id = ?",
        (follower_id, followee_id)
    )
    conn.commit()
    conn.close()

def get_followers(user_id: int) -> list[int]:
    """Return list of user_ids who follow user_id."""
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT follower_id FROM follows WHERE followee_id = ?", (user_id,)
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]

def get_following(user_id: int) -> list[int]:
    """Return list of user_ids that user_id follows."""
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT followee_id FROM follows WHERE follower_id = ?", (user_id,)
    ).fetchall()
    conn.close()
    return [r[0] for r in rows]

if __name__ == "__main__":
    init_follower_table()
    # User 1 follows users 2, 3, 4
    for uid in [2, 3, 4]:
        follow(follower_id=1, followee_id=uid)
    print("User 1 follows:", get_following(1))
    print("Followers of user 2:", get_followers(2))
```

**What you observe:** The follower graph is a simple adjacency list. `get_followers()` is the key operation for fan-out — it tells us who to notify when user X posts a tweet.

**Exercise:** Insert 1 million follow edges for user_id=1 (simulating a celebrity). Time `get_followers(1)`. This is the celebrity problem.

---

### Step 3 — Fan-Out on Write (Copy Tweet to Followers' Timelines)

Goal: when user X posts, immediately copy the tweet to every follower's timeline table.

```python
# step3_fanout.py  (extends steps 1 and 2)
import sqlite3
import time

DB_PATH = "twitter.db"

def init_timeline_table():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS timelines (
            user_id    INTEGER NOT NULL,
            tweet_id   INTEGER NOT NULL,
            author_id  INTEGER NOT NULL,
            created_at REAL NOT NULL,
            PRIMARY KEY (user_id, tweet_id)
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_timeline_user_time
        ON timelines(user_id, created_at DESC)
    """)
    conn.commit()
    conn.close()

def post_tweet_with_fanout(author_id: int, content: str) -> int:
    """
    Post a tweet AND fan out to all followers' timelines.
    This is the fan-out-on-write pattern.
    """
    conn = sqlite3.connect(DB_PATH)
    ts = time.time()

    # 1. Insert the tweet
    cur = conn.execute(
        "INSERT INTO tweets (user_id, content, created_at) VALUES (?, ?, ?)",
        (author_id, content, ts)
    )
    tweet_id = cur.lastrowid

    # 2. Get all followers
    followers = conn.execute(
        "SELECT follower_id FROM follows WHERE followee_id = ?", (author_id,)
    ).fetchall()

    # 3. Insert into each follower's timeline
    timeline_rows = [
        (follower[0], tweet_id, author_id, ts) for follower in followers
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO timelines (user_id, tweet_id, author_id, created_at) "
        "VALUES (?, ?, ?, ?)",
        timeline_rows
    )

    # 4. Also add to author's own timeline
    conn.execute(
        "INSERT OR IGNORE INTO timelines (user_id, tweet_id, author_id, created_at) "
        "VALUES (?, ?, ?, ?)",
        (author_id, tweet_id, author_id, ts)
    )
    conn.commit()
    conn.close()
    return tweet_id

def get_home_timeline(user_id: int, limit: int = 20) -> list[dict]:
    """
    Fetch the home timeline for user_id.
    O(1) lookup — no join needed because fan-out already populated timelines.
    """
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("""
        SELECT t.id, t.user_id, t.content, t.created_at
        FROM timelines tl
        JOIN tweets t ON t.id = tl.tweet_id
        WHERE tl.user_id = ?
        ORDER BY tl.created_at DESC
        LIMIT ?
    """, (user_id, limit)).fetchall()
    conn.close()
    return [
        {"tweet_id": r[0], "author_id": r[1], "content": r[2], "created_at": r[3]}
        for r in rows
    ]

if __name__ == "__main__":
    init_timeline_table()
    # User 2 and 3 follow user 1
    # (assumes step2 follows are already in DB)
    tweet_id = post_tweet_with_fanout(author_id=1, content="Fan-out test tweet!")
    print(f"Tweet {tweet_id} fanned out")
    print("User 2 timeline:", get_home_timeline(user_id=2))
```

**What you observe:** Home timeline reads are O(1) — just a simple indexed lookup. But writes are now O(followers). For a user with 1M followers, one tweet triggers 1M timeline inserts synchronously. This is the celebrity problem.

**Exercise:** Time `post_tweet_with_fanout` for a user with 1K followers vs. 100K followers. At what follower count does the write latency become unacceptable?

---

### Step 4 — Add Redis Cache for Hot Timelines

Goal: cache the most recent 200 tweets of each user's timeline in Redis. Reads are now microseconds.

```python
# step4_redis_cache.py  (extends step3)
import redis
import sqlite3
import json
import time

DB_PATH = "twitter.db"
CACHE_TTL = 300          # 5 minutes
TIMELINE_MAX_LENGTH = 200  # Keep last 200 tweets in cache

r = redis.Redis(host="localhost", port=6379, decode_responses=True)

def cache_key(user_id: int) -> str:
    return f"timeline:{user_id}"

def get_home_timeline_cached(user_id: int, limit: int = 20) -> list[dict]:
    """
    Try Redis cache first. Fall back to SQLite on miss.
    Read-aside (cache-aside) pattern.
    """
    key = cache_key(user_id)
    # LRANGE returns up to `limit` items from the Redis list (newest first)
    cached = r.lrange(key, 0, limit - 1)

    if cached:
        return [json.loads(item) for item in cached]

    # Cache miss: fetch from SQLite and populate cache
    print(f"[CACHE MISS] user_id={user_id}")
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("""
        SELECT t.id, t.user_id, t.content, t.created_at
        FROM timelines tl
        JOIN tweets t ON t.id = tl.tweet_id
        WHERE tl.user_id = ?
        ORDER BY tl.created_at DESC
        LIMIT ?
    """, (user_id, TIMELINE_MAX_LENGTH)).fetchall()
    conn.close()

    tweets = [
        {"tweet_id": r[0], "author_id": r[1], "content": r[2], "created_at": r[3]}
        for r in rows
    ]

    if tweets:
        pipe = r.pipeline()
        pipe.delete(key)
        for tweet in tweets:
            pipe.rpush(key, json.dumps(tweet))
        pipe.ltrim(key, 0, TIMELINE_MAX_LENGTH - 1)
        pipe.expire(key, CACHE_TTL)
        pipe.execute()

    return tweets[:limit]

def push_tweet_to_cache(user_id: int, tweet: dict):
    """
    Push a new tweet to the front of the user's cached timeline.
    Called during fan-out so the cache stays warm.
    """
    key = cache_key(user_id)
    # Only update cache if it already exists (don't cold-start cache on every tweet)
    if r.exists(key):
        pipe = r.pipeline()
        pipe.lpush(key, json.dumps(tweet))          # push to front (newest first)
        pipe.ltrim(key, 0, TIMELINE_MAX_LENGTH - 1) # cap at 200
        pipe.expire(key, CACHE_TTL)                 # reset TTL
        pipe.execute()

def invalidate_timeline_cache(user_id: int):
    """Force cache invalidation for a user's timeline."""
    r.delete(cache_key(user_id))

if __name__ == "__main__":
    import time

    # Warm test: first read is a miss, second is a hit
    start = time.perf_counter()
    tweets = get_home_timeline_cached(user_id=2, limit=20)
    cold = time.perf_counter() - start
    print(f"Cold read: {cold*1000:.2f}ms, {len(tweets)} tweets")

    start = time.perf_counter()
    tweets = get_home_timeline_cached(user_id=2, limit=20)
    warm = time.perf_counter() - start
    print(f"Warm read: {warm*1000:.2f}ms, {len(tweets)} tweets")
```

**What you observe:** Cold read (SQLite join) takes 10–50ms. Warm Redis read takes < 1ms. The cache-aside pattern is visible: miss → SQLite → populate Redis → return.

**What breaks:** Cache and DB can diverge. A tweet posted between cache population and next read will be missed until TTL expires (5 minutes) or `push_tweet_to_cache` is called. This is eventual consistency between cache and DB.

---

### Step 5 — Async Fan-Out via Background Task Queue

Goal: instead of fanning out synchronously (blocking the tweet API for seconds), enqueue a job and return immediately.

```python
# step5_async_fanout.py  (extends steps 3 and 4)
import queue
import threading
import sqlite3
import time
import json
import redis

DB_PATH = "twitter.db"
r = redis.Redis(host="localhost", port=6379, decode_responses=True)

# In-process task queue (in production: use Redis Streams or SQS)
fanout_queue: queue.Queue = queue.Queue(maxsize=10_000)

def post_tweet_async(author_id: int, content: str) -> dict:
    """
    Post tweet to DB immediately, enqueue fan-out job, return fast.
    The caller gets a response in < 5ms regardless of follower count.
    """
    conn = sqlite3.connect(DB_PATH)
    ts = time.time()
    cur = conn.execute(
        "INSERT INTO tweets (user_id, content, created_at) VALUES (?, ?, ?)",
        (author_id, content, ts)
    )
    tweet_id = cur.lastrowid
    conn.commit()
    conn.close()

    # Enqueue fan-out job — non-blocking
    try:
        fanout_queue.put_nowait({
            "author_id": author_id,
            "tweet_id": tweet_id,
            "content": content,
            "created_at": ts,
        })
    except queue.Full:
        # Queue full = backpressure. Log and drop (or use DLQ in production).
        print(f"[WARN] Fanout queue full. Tweet {tweet_id} fan-out dropped.")

    return {"tweet_id": tweet_id, "queued_at": ts}

def fanout_worker():
    """
    Background thread: consumes fan-out jobs and distributes tweets
    to followers' timelines and their Redis caches.
    """
    print("[Worker] Fan-out worker started")
    while True:
        try:
            job = fanout_queue.get(timeout=1)
        except queue.Empty:
            continue

        author_id  = job["author_id"]
        tweet_id   = job["tweet_id"]
        ts         = job["created_at"]
        tweet_obj  = {
            "tweet_id": tweet_id,
            "author_id": author_id,
            "content": job["content"],
            "created_at": ts
        }

        conn = sqlite3.connect(DB_PATH)
        followers = conn.execute(
            "SELECT follower_id FROM follows WHERE followee_id = ?", (author_id,)
        ).fetchall()

        # Write to timelines table in batch
        timeline_rows = [(f[0], tweet_id, author_id, ts) for f in followers]
        if timeline_rows:
            conn.executemany(
                "INSERT OR IGNORE INTO timelines "
                "(user_id, tweet_id, author_id, created_at) VALUES (?, ?, ?, ?)",
                timeline_rows
            )
        conn.commit()
        conn.close()

        # Push to each follower's Redis cache if it exists
        from step4_redis_cache import push_tweet_to_cache
        for (follower_id,) in followers:
            push_tweet_to_cache(follower_id, tweet_obj)

        fanout_queue.task_done()

# Start background worker thread
worker_thread = threading.Thread(target=fanout_worker, daemon=True)
worker_thread.start()

if __name__ == "__main__":
    # Test: post a tweet; observe it returns immediately
    start = time.perf_counter()
    result = post_tweet_async(author_id=1, content="Async fan-out tweet!")
    elapsed = time.perf_counter() - start
    print(f"POST returned in {elapsed*1000:.2f}ms: {result}")
    print("Fan-out happening in background...")
    time.sleep(2)  # Wait for background worker
    print("Done. Check timelines.")
```

**What you observe:** `post_tweet_async` returns in < 5ms regardless of how many followers user has. The fan-out happens asynchronously. This decouples write latency from follower count.

**What breaks:** Timeline is eventually consistent. A follower's feed may not show the new tweet for a few hundred milliseconds (queue processing time). For most social media applications this is acceptable.

---

### Step 6 — Add Rate Limiting (Token Bucket in Redis)

Goal: prevent any single user from posting more than 10 tweets/minute.

```python
# step6_rate_limiter.py
import redis
import time

r = redis.Redis(host="localhost", port=6379, decode_responses=True)

RATE_LIMIT   = 10    # max requests
WINDOW_SEC   = 60    # per 60 seconds
BURST_LIMIT  = 15    # max burst (bucket capacity)
REFILL_RATE  = RATE_LIMIT / WINDOW_SEC  # tokens per second = 10/60 ≈ 0.167

def check_rate_limit(user_id: int) -> tuple[bool, dict]:
    """
    Token bucket rate limiter using Redis.
    Returns (allowed: bool, info: dict)
    """
    key = f"ratelimit:tweets:{user_id}"
    now = time.time()

    # Lua script for atomic read-modify-write (prevents race conditions)
    lua_script = """
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local refill_rate = tonumber(ARGV[2])
    local burst_limit = tonumber(ARGV[3])
    local ttl = tonumber(ARGV[4])

    local data = redis.call('HMGET', key, 'tokens', 'last_refill')
    local tokens = tonumber(data[1]) or burst_limit
    local last_refill = tonumber(data[2]) or now

    -- Refill tokens since last check
    local elapsed = now - last_refill
    tokens = math.min(burst_limit, tokens + elapsed * refill_rate)

    if tokens >= 1 then
        tokens = tokens - 1
        redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
        redis.call('EXPIRE', key, ttl)
        return {1, math.floor(tokens)}  -- allowed, remaining
    else
        redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
        redis.call('EXPIRE', key, ttl)
        return {0, 0}  -- denied
    end
    """

    script = r.register_script(lua_script)
    result = script(keys=[key], args=[now, REFILL_RATE, BURST_LIMIT, WINDOW_SEC * 2])

    allowed = bool(result[0])
    remaining = int(result[1])
    return allowed, {"allowed": allowed, "tokens_remaining": remaining}

def rate_limited_post(user_id: int, content: str) -> dict:
    """Post a tweet, enforcing rate limit."""
    allowed, info = check_rate_limit(user_id)
    if not allowed:
        return {"error": "Rate limit exceeded", "retry_after": "60s", **info}

    # Proceed with posting (call step5_async_fanout.post_tweet_async here)
    print(f"[OK] User {user_id} posted. {info['tokens_remaining']} tokens remaining.")
    return {"status": "ok", **info}

if __name__ == "__main__":
    print("Simulating burst of 20 rapid posts by user 42...")
    for i in range(20):
        result = rate_limited_post(user_id=42, content=f"Tweet {i}")
        print(f"  Post {i+1}: {result}")
```

**What you observe:** The first 15 requests (burst limit) are allowed. Then requests 16–20 are denied with 429. The Lua script ensures atomicity — no race condition between reading and decrementing the token count in Redis.

**Key concept:** The Lua script runs atomically on the Redis server side. No two concurrent requests can both read the same `tokens` value and both decrement it — Redis executes Lua scripts single-threaded.

---

### Step 7 — Measure: At What Follower Count Does Fan-Out Break?

Goal: empirically find the breaking point of synchronous fan-out.

```python
# step7_benchmark_fanout.py
import sqlite3
import time
import random
import string

DB_PATH = "twitter.db"

def create_followers(author_id: int, follower_count: int):
    """Insert follower_count followers for author_id."""
    conn = sqlite3.connect(DB_PATH)
    # Use IDs starting from 100_000 to avoid collision with existing users
    rows = [
        (100_000 + i, author_id)
        for i in range(follower_count)
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)",
        rows
    )
    conn.commit()
    conn.close()
    print(f"Created {follower_count} followers for user {author_id}")

def benchmark_sync_fanout(author_id: int, follower_counts: list[int]):
    """
    Measure synchronous fan-out write latency at various follower counts.
    """
    print(f"\n{'Followers':>12} | {'Fanout ms':>10} | {'Writes/sec':>12}")
    print("-" * 40)

    for count in follower_counts:
        # Create followers for this test
        create_followers(author_id, count)

        # Time the synchronous fan-out
        content = "benchmark tweet " + "".join(random.choices(string.ascii_lowercase, k=10))
        start = time.perf_counter()

        conn = sqlite3.connect(DB_PATH)
        ts = time.time()
        cur = conn.execute(
            "INSERT INTO tweets (user_id, content, created_at) VALUES (?, ?, ?)",
            (author_id, content, ts)
        )
        tweet_id = cur.lastrowid

        followers = conn.execute(
            "SELECT follower_id FROM follows WHERE followee_id = ?", (author_id,)
        ).fetchall()

        rows = [(f[0], tweet_id, author_id, ts) for f in followers]
        conn.executemany(
            "INSERT OR IGNORE INTO timelines (user_id, tweet_id, author_id, created_at) "
            "VALUES (?, ?, ?, ?)",
            rows
        )
        conn.commit()
        conn.close()

        elapsed_ms = (time.perf_counter() - start) * 1000
        writes_per_sec = count / (elapsed_ms / 1000) if elapsed_ms > 0 else 0
        print(f"{count:>12,} | {elapsed_ms:>10.1f} | {writes_per_sec:>12,.0f}")

        # Cleanup followers for next test
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "DELETE FROM follows WHERE followee_id = ? AND follower_id >= 100000",
            (author_id,)
        )
        conn.commit()
        conn.close()

if __name__ == "__main__":
    benchmark_sync_fanout(
        author_id=1,
        follower_counts=[100, 1_000, 10_000, 50_000, 100_000, 500_000, 1_000_000]
    )
    print("""
Interpretation:
  - < 1,000 followers: fan-out in < 10ms — synchronous is fine
  - 10,000 followers: fan-out in ~100ms — borderline (API timeout risk)
  - 100,000+ followers: fan-out in > 1s — must be async (Step 5)
  - 1,000,000 followers (celebrity): fan-out in > 10s — use hybrid strategy:
      fan-out for normal users, fan-on-read for users with > 10K followers
""")
```

**Expected output (approximate, varies by hardware):**
```
     Followers |  Fanout ms |   Writes/sec
----------------------------------------
           100 |        1.2 |       83,333
         1,000 |        8.5 |      117,647
        10,000 |       82.1 |      121,803
        50,000 |      410.3 |      121,862
       100,000 |      821.0 |      121,802
       500,000 |    4,105.0 |      121,802
     1,000,000 |    8,210.0 |      121,802
```

**Key insight:** Fan-out is linear in follower count. At 1M followers, synchronous fan-out takes ~8 seconds. This is why real Twitter uses async fan-out (Step 5) and hybrid fan-on-read for celebrities.

---

## Part III: Load Testing Lab

Goal: measure P50/P95/P99 latency, throughput, and error rate under concurrent load. Identify where the bottleneck is.

```python
# load_test.py
"""
Async load tester using asyncio + httpx.
Usage:
  python load_test.py --url http://localhost:8000/tweets --concurrency 50 --total 1000
"""
import asyncio
import httpx
import time
import argparse
import statistics
import json
from collections import Counter

async def single_request(
    client: httpx.AsyncClient,
    url: str,
    payload: dict,
    results: list
):
    start = time.perf_counter()
    try:
        resp = await client.post(url, json=payload, timeout=10.0)
        elapsed_ms = (time.perf_counter() - start) * 1000
        results.append({"latency_ms": elapsed_ms, "status": resp.status_code})
    except Exception as e:
        elapsed_ms = (time.perf_counter() - start) * 1000
        results.append({"latency_ms": elapsed_ms, "status": 0, "error": str(e)})

async def load_test(url: str, concurrency: int, total: int):
    results = []
    payload = {"user_id": 1, "content": "Load test tweet x" * 5}

    semaphore = asyncio.Semaphore(concurrency)  # cap concurrent in-flight requests

    async def bounded_request(client):
        async with semaphore:
            await single_request(client, url, payload, results)

    print(f"Load test: {total} requests, concurrency={concurrency}")
    print(f"Target: {url}\n")

    async with httpx.AsyncClient() as client:
        wall_start = time.perf_counter()
        tasks = [bounded_request(client) for _ in range(total)]
        await asyncio.gather(*tasks)
        wall_elapsed = time.perf_counter() - wall_start

    # Analysis
    latencies = [r["latency_ms"] for r in results]
    status_counts = Counter(r["status"] for r in results)
    errors = sum(1 for r in results if r["status"] == 0 or r["status"] >= 500)

    latencies.sort()
    p50 = latencies[int(len(latencies) * 0.50)]
    p95 = latencies[int(len(latencies) * 0.95)]
    p99 = latencies[int(len(latencies) * 0.99)]
    p999 = latencies[int(len(latencies) * 0.999)] if len(latencies) >= 1000 else latencies[-1]
    throughput = total / wall_elapsed

    print(f"Results ({total} requests in {wall_elapsed:.2f}s):")
    print(f"  Throughput:  {throughput:.1f} req/sec")
    print(f"  Error rate:  {errors/total*100:.2f}% ({errors} errors)")
    print(f"  Status codes: {dict(status_counts)}")
    print(f"  Latency:")
    print(f"    P50:   {p50:.1f}ms")
    print(f"    P95:   {p95:.1f}ms")
    print(f"    P99:   {p99:.1f}ms")
    print(f"    P99.9: {p999:.1f}ms")
    print(f"    Max:   {max(latencies):.1f}ms")
    print(f"    Mean:  {statistics.mean(latencies):.1f}ms")

    # Bottleneck diagnosis
    print("\nBottleneck diagnosis:")
    if p99 > 1000:
        print("  [!] P99 > 1s — likely DB or queue saturation")
    if p99 / p50 > 10:
        print("  [!] P99/P50 ratio > 10x — high tail latency variance (GC pauses? lock contention?)")
    if errors / total > 0.01:
        print("  [!] Error rate > 1% — connection pool exhausted or timeouts")
    if throughput < concurrency * 10:
        print("  [!] Throughput low relative to concurrency — likely CPU or I/O bound")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8000/tweets")
    parser.add_argument("--concurrency", type=int, default=50)
    parser.add_argument("--total", type=int, default=1000)
    args = parser.parse_args()
    asyncio.run(load_test(args.url, args.concurrency, args.total))
```

**FastAPI server to test against:**

```python
# server.py  (run with: uvicorn server:app --workers 4)
from fastapi import FastAPI
import sqlite3
import time

app = FastAPI()
DB_PATH = "twitter.db"

@app.post("/tweets")
def post_tweet(body: dict):
    user_id = body.get("user_id", 1)
    content = body.get("content", "")
    conn = sqlite3.connect(DB_PATH)
    cur = conn.execute(
        "INSERT INTO tweets (user_id, content, created_at) VALUES (?, ?, ?)",
        (user_id, content, time.time())
    )
    tweet_id = cur.lastrowid
    conn.commit()
    conn.close()
    return {"tweet_id": tweet_id}

@app.get("/timeline/{user_id}")
def get_timeline(user_id: int, limit: int = 20):
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id, content, created_at FROM tweets "
        "WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
        (user_id, limit)
    ).fetchall()
    conn.close()
    return [{"id": r[0], "content": r[1], "created_at": r[2]} for r in rows]
```

**Load Test Exercise — Add Index, Compare Results:**

```bash
# Step 1: Run baseline (no index on tweets.user_id)
python load_test.py --url http://localhost:8000/timeline/1 --concurrency 50 --total 2000

# Step 2: Add index
sqlite3 twitter.db "CREATE INDEX IF NOT EXISTS idx_tweets_user ON tweets(user_id, created_at DESC);"

# Step 3: Re-run same load test
python load_test.py --url http://localhost:8000/timeline/1 --concurrency 50 --total 2000
```

**Expected observation:**
- Without index: P99 = 200–500ms (full table scan on 100K rows)
- With index: P99 = 5–20ms (index seek → 20 rows)
- Throughput improvement: 5–20x for read-heavy workloads

**How to identify the bottleneck:**

| Symptom | Likely Cause | Diagnostic Command |
|---|---|---|
| High P99, low P50 | Lock contention or GC pauses | `top` + check thread count |
| Error rate climbing | Connection pool exhausted | `lsof \| grep ESTABLISHED \| wc -l` |
| Throughput plateaus with more concurrency | CPU-bound (single-core bottleneck) | `htop` → look for single CPU at 100% |
| Throughput plateaus but CPU is idle | I/O-bound (disk or DB wait) | `iostat -x 1` → check await time |
| Memory grows linearly | Memory leak or unbounded cache | `watch -n1 'ps aux \| grep python'` |

---

## Part IV: Observability Lab

Goal: add production-grade metrics, structured logging, and request tracing to a FastAPI service.

### 4A — Prometheus Metrics (Request Count, Latency Histogram, In-Flight Gauge)

```python
# observability_server.py
# pip install prometheus-client fastapi uvicorn
from fastapi import FastAPI, Request, Response
from prometheus_client import (
    Counter, Histogram, Gauge,
    generate_latest, CONTENT_TYPE_LATEST
)
import time
import sqlite3
import uuid

app = FastAPI()
DB_PATH = "twitter.db"

# ─── Prometheus Metrics ─────────────────────────────────────────────────────

REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests",
    labelnames=["method", "endpoint", "status_code"]
)

REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency in seconds",
    labelnames=["method", "endpoint"],
    # Buckets optimized for web APIs (ms range)
    buckets=[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0]
)

IN_FLIGHT_REQUESTS = Gauge(
    "http_requests_in_flight",
    "Number of HTTP requests currently being processed",
    labelnames=["endpoint"]
)

DB_QUERY_LATENCY = Histogram(
    "db_query_duration_seconds",
    "Database query latency",
    labelnames=["query_name"]
)

TWEET_POST_ERRORS = Counter(
    "tweet_post_errors_total",
    "Total tweet post failures",
    labelnames=["error_type"]
)

# ─── Middleware ──────────────────────────────────────────────────────────────

@app.middleware("http")
async def metrics_and_logging_middleware(request: Request, call_next):
    # Attach a correlation ID to every request
    correlation_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    request.state.correlation_id = correlation_id

    endpoint = request.url.path
    method = request.method

    IN_FLIGHT_REQUESTS.labels(endpoint=endpoint).inc()
    start = time.perf_counter()

    try:
        response = await call_next(request)
        status_code = response.status_code
    except Exception as exc:
        status_code = 500
        raise exc
    finally:
        elapsed = time.perf_counter() - start
        IN_FLIGHT_REQUESTS.labels(endpoint=endpoint).dec()
        REQUEST_COUNT.labels(
            method=method, endpoint=endpoint, status_code=status_code
        ).inc()
        REQUEST_LATENCY.labels(method=method, endpoint=endpoint).observe(elapsed)

        # Structured log entry (JSON format for log aggregators like ELK / Loki)
        import json
        log_entry = {
            "ts": time.time(),
            "correlation_id": correlation_id,
            "method": method,
            "path": endpoint,
            "status": status_code,
            "duration_ms": round(elapsed * 1000, 2),
        }
        print(json.dumps(log_entry))  # In production: send to stdout → log aggregator

    response.headers["X-Request-ID"] = correlation_id
    return response

# ─── Endpoints ───────────────────────────────────────────────────────────────

@app.get("/metrics")
def metrics():
    """Prometheus scrape endpoint."""
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

@app.post("/tweets")
async def post_tweet(request: Request, body: dict):
    correlation_id = request.state.correlation_id
    user_id = body.get("user_id", 1)
    content = body.get("content", "")

    if len(content) > 280:
        TWEET_POST_ERRORS.labels(error_type="content_too_long").inc()
        return Response(status_code=400, content='{"error": "too long"}',
                        media_type="application/json")

    # Measure DB write latency separately
    with DB_QUERY_LATENCY.labels(query_name="insert_tweet").time():
        conn = sqlite3.connect(DB_PATH)
        cur = conn.execute(
            "INSERT INTO tweets (user_id, content, created_at) VALUES (?, ?, ?)",
            (user_id, content, time.time())
        )
        tweet_id = cur.lastrowid
        conn.commit()
        conn.close()

    import json
    print(json.dumps({
        "event": "tweet_posted",
        "correlation_id": correlation_id,
        "tweet_id": tweet_id,
        "user_id": user_id,
    }))
    return {"tweet_id": tweet_id}

@app.get("/timeline/{user_id}")
async def get_timeline(user_id: int, request: Request, limit: int = 20):
    correlation_id = request.state.correlation_id

    with DB_QUERY_LATENCY.labels(query_name="select_timeline").time():
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT id, content, created_at FROM tweets "
            "WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit)
        ).fetchall()
        conn.close()

    import json
    print(json.dumps({
        "event": "timeline_fetched",
        "correlation_id": correlation_id,
        "user_id": user_id,
        "tweet_count": len(rows),
    }))
    return [{"id": r[0], "content": r[1], "created_at": r[2]} for r in rows]
```

### 4B — Tracing a Slow Request Through Logs

```python
# trace_slow_request.py
"""
Simulate a slow request and show how correlation IDs let you trace it
end-to-end across all log lines.
"""
import httpx
import uuid
import time

BASE_URL = "http://localhost:8000"

def make_request_with_tracing(user_id: int, content: str):
    """
    Every request gets a unique correlation_id.
    Pass it in the header so it appears in all log lines for this request.
    """
    correlation_id = str(uuid.uuid4())

    print(f"\n[CLIENT] Starting request. correlation_id={correlation_id}")
    start = time.perf_counter()

    resp = httpx.post(
        f"{BASE_URL}/tweets",
        json={"user_id": user_id, "content": content},
        headers={"X-Request-ID": correlation_id}
    )

    elapsed_ms = (time.perf_counter() - start) * 1000
    print(f"[CLIENT] Response: status={resp.status_code}, latency={elapsed_ms:.1f}ms")
    print(f"[CLIENT] To find all logs for this request, search: correlation_id={correlation_id}")
    return resp.json()

if __name__ == "__main__":
    # Normal request
    make_request_with_tracing(user_id=1, content="Normal tweet")

    # Large content (will fail validation)
    make_request_with_tracing(user_id=1, content="x" * 300)
```

**How to query logs in production:**

```bash
# If logs go to stdout → ELK / Loki / CloudWatch:
# Find all log lines for a specific request:
grep '"correlation_id": "abc-123"' app.log | jq .

# Find all slow requests (> 100ms):
cat app.log | jq 'select(.duration_ms > 100)'

# Find all 500 errors in last hour:
cat app.log | jq 'select(.status == 500)'

# Find the slowest DB queries:
cat app.log | jq 'select(.event == "db_query" and .duration_ms > 50)'
```

**What to alert on (Prometheus alerting rules):**

```yaml
# prometheus_alerts.yml
groups:
  - name: mini_twitter
    rules:
      - alert: HighErrorRate
        expr: |
          rate(http_requests_total{status_code=~"5.."}[5m])
          / rate(http_requests_total[5m]) > 0.01
        for: 5m
        annotations:
          summary: "Error rate > 1% for 5 minutes"

      - alert: HighP99Latency
        expr: |
          histogram_quantile(0.99,
            rate(http_request_duration_seconds_bucket[5m])
          ) > 1.0
        for: 5m
        annotations:
          summary: "P99 latency > 1 second"

      - alert: SlowDBQueries
        expr: |
          histogram_quantile(0.95,
            rate(db_query_duration_seconds_bucket[5m])
          ) > 0.1
        for: 2m
        annotations:
          summary: "P95 DB query latency > 100ms — check for missing indexes"
```

**Lab Exercise — Full Observability Workflow:**
1. Start the server: `uvicorn observability_server:app --reload`
2. Run the load tester for 60 seconds: `python load_test.py --total 5000 --concurrency 30`
3. While running, open `http://localhost:8000/metrics` — see live counters ticking
4. Identify the slowest endpoint using `db_query_duration_seconds` histogram
5. Add the missing index, re-run, observe `db_query_duration_seconds` drop immediately
6. Check logs: find a specific slow request by its `correlation_id`
