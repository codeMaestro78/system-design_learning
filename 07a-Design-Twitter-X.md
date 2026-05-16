# Design Twitter/X (Comprehensive)

## 1) Intuition
Twitter is a write-heavy + fanout-heavy system where the hardest problem is delivering a low-latency personalized home timeline under huge skew (celebrity accounts with 100M+ followers writing one tweet that must reach all followers).

**Core challenge:** Fanout is fundamentally at war with latency. Writing to 100M timelines takes minutes; reading from 100M author timelines takes seconds. The hybrid fanout design is the resolution.

---

## 2) Functional Requirements
- Post tweet (text up to 280 chars, optional media links)
- Follow/unfollow users
- Home timeline (tweets from people you follow)
- User timeline (tweets from one specific user)
- Like, reply, retweet
- Search tweets and hashtag trends
- Notifications (likes, replies, follows)

---

## 3) Non-Functional Requirements
- **Availability:** 99.99% (52 min downtime/year)
- **Consistency:** Eventual OK for timelines; durable tweet write before ack
- **Timeline latency:** P95 < 300ms for home timeline
- **Tweet post latency:** P95 < 200ms
- **Scale:** 200M DAU, 500M tweets/day, 50B timeline reads/day

---

## 4) Capacity Estimation

```python
# Twitter-scale capacity math
users = {
    "DAU": 200_000_000,
    "avg_followers_per_user": 200,
    "celebrity_users": 50_000,       # > 1M followers
    "celebrity_avg_followers": 5_000_000
}

tweets = {
    "tweets_per_day": 500_000_000,   # 500M tweets/day
    "tweets_per_second_avg": 5_787,  # 500M / 86400
    "tweets_per_second_peak": 17_000, # 3x peak factor
    "avg_tweet_size_bytes": 500,      # text + metadata
}

fanout = {
    # Writes when normal user posts:
    "normal_user_followers": 200,
    "writes_per_tweet": 200,  # write to 200 timeline stores
    
    # Writes if celebrity posts and we do naive fanout:
    "celebrity_followers": 5_000_000,
    "celebrity_fanout_writes": 5_000_000,  # impossible in real time
    
    # Hybrid fanout estimate:
    "avg_fanout_writes_per_tweet": 200,  # celebrities use fanout-on-read
    "total_fanout_writes_per_day": 500_000_000 * 200,  # 100B writes/day
}

reads = {
    "timeline_reads_per_day": 50_000_000_000,  # 50B
    "timeline_reads_per_second_avg": 578_703,
    "timeline_reads_per_second_peak": 1_736_110,  # 3x peak
}

storage = {
    "tweet_storage_per_day_gb": (500_000_000 * 500) / (1024**3),  # ~230 GB/day
    "tweet_storage_per_year_tb": 230 * 365 / 1024,  # ~82 TB raw
    "with_replication_tb": 82 * 3,  # ~246 TB with 3x replication
    "media_storage": "Separate object storage (S3), 90% of storage costs"
}
```

**Infrastructure sizing:**
```text
App servers:     ~700 (1M peak QPS / 1500 QPS per server)
Timeline cache:  ~200 Redis nodes (50B reads/day, 1M cached timelines)
DB clusters:     ~50 PostgreSQL shards (tweet storage, sharded by tweet ID)
Fanout workers:  ~500 (100B fanout writes/day burst)
Search index:    ~100 Elasticsearch shards
```

---

## 5) APIs

### Tweet API
```
POST /v1/tweets
Content-Type: application/json
Authorization: Bearer {jwt_token}

Request:
{
    "text": "Hello world! This is my tweet #hello",
    "reply_to_tweet_id": null,  // null for new tweet, string for reply
    "media_keys": ["media_key_1234"]  // uploaded separately via media API
}

Response 201 Created:
{
    "id": "tweet_1234567890",
    "text": "Hello world! This is my tweet #hello",
    "author_id": "user_123",
    "created_at": "2024-01-15T10:30:00Z",
    "public_metrics": {
        "like_count": 0,
        "retweet_count": 0,
        "reply_count": 0
    }
}
```

### Timeline API
```
GET /v1/timeline/home?max_results=20&pagination_token=cursor_xyz
Authorization: Bearer {jwt_token}

Response 200 OK:
{
    "data": [
        {
            "id": "tweet_9876",
            "text": "...",
            "author_id": "user_456",
            "created_at": "2024-01-15T10:29:00Z",
            "author": { "id": "user_456", "name": "Alice", "username": "alice" }
        }
    ],
    "meta": {
        "next_token": "cursor_abc",  // null if no more results
        "result_count": 20
    }
}
```

### Follow API
```
POST /v1/users/{user_id}/following
Body: { "target_user_id": "user_789" }

DELETE /v1/users/{user_id}/following/{target_user_id}
```

---

## 6) Data Model

```sql
-- Core entities
CREATE TABLE users (
    id          VARCHAR(20) PRIMARY KEY,  -- "user_123456789"
    handle      VARCHAR(15) UNIQUE NOT NULL,  -- "@alice"
    display_name VARCHAR(50) NOT NULL,
    email       VARCHAR(255) UNIQUE NOT NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    follower_count  INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0
);

-- Tweets: sharded by tweet_id (time-sortable ID like snowflake)
-- Each shard handles a range of tweet IDs
CREATE TABLE tweets (
    id          BIGINT PRIMARY KEY,  -- Snowflake ID: timestamp + worker + seq
    author_id   VARCHAR(20) NOT NULL,
    body        VARCHAR(280) NOT NULL,
    media_keys  TEXT[],              -- References to media objects in object storage
    reply_to_id BIGINT,              -- NULL for original tweets
    retweet_of_id BIGINT,           -- NULL for original tweets
    created_at  TIMESTAMP NOT NULL,
    like_count  INTEGER DEFAULT 0,  -- eventually consistent counter
    retweet_count INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0
);
CREATE INDEX idx_tweets_author_created ON tweets(author_id, created_at DESC);

-- Follow graph: sharded by follower_id
CREATE TABLE follows (
    follower_id  VARCHAR(20) NOT NULL,
    followee_id  VARCHAR(20) NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX idx_follows_followee ON follows(followee_id);

-- Timeline entries: denormalized, sharded by user_id
-- Stored in Redis (sorted set) + Cassandra for durability
-- Redis: timeline:{user_id} ZADD score=timestamp member=tweet_id
CREATE TABLE timeline_entries (
    user_id     VARCHAR(20) NOT NULL,
    tweet_id    BIGINT NOT NULL,
    inserted_at TIMESTAMP NOT NULL,
    PRIMARY KEY (user_id, tweet_id)
);

-- Engagement: eventually consistent, can use Cassandra counters
CREATE TABLE tweet_engagement (
    tweet_id    BIGINT NOT NULL,
    user_id     VARCHAR(20) NOT NULL,
    action      VARCHAR(10) NOT NULL,  -- 'like', 'retweet', 'bookmark'
    created_at  TIMESTAMP NOT NULL,
    PRIMARY KEY (tweet_id, user_id, action)
);
```

### Snowflake ID generation
```python
# Twitter's Snowflake ID: 64-bit time-sortable unique ID
# Bits: [41 timestamp ms][10 worker ID][12 sequence]

class SnowflakeIDGenerator:
    """
    Generates unique, time-sortable 64-bit IDs.
    No central coordination needed (each worker generates independently).
    
    Layout (64 bits):
    - 1 bit: always 0 (sign bit)
    - 41 bits: milliseconds since epoch (gives 69 years)
    - 10 bits: worker/machine ID (1024 workers)
    - 12 bits: sequence number per millisecond (4096 per ms per worker)
    
    Result: 1024 workers * 4096 IDs/ms = 4.1M IDs/ms = 4.1B IDs/second!
    """
    EPOCH = 1288834974657  # Twitter epoch: Nov 4, 2010 01:42:54 UTC
    WORKER_ID_BITS = 10
    SEQUENCE_BITS = 12
    MAX_SEQUENCE = (1 << SEQUENCE_BITS) - 1  # 4095
    MAX_WORKER_ID = (1 << WORKER_ID_BITS) - 1  # 1023
    
    def __init__(self, worker_id: int):
        assert 0 <= worker_id <= self.MAX_WORKER_ID
        self.worker_id = worker_id
        self.sequence = 0
        self.last_timestamp = -1
    
    def next_id(self) -> int:
        timestamp = self._current_ms()
        
        if timestamp == self.last_timestamp:
            self.sequence = (self.sequence + 1) & self.MAX_SEQUENCE
            if self.sequence == 0:
                timestamp = self._wait_next_ms(timestamp)
        else:
            self.sequence = 0
        
        self.last_timestamp = timestamp
        
        return (
            ((timestamp - self.EPOCH) << (self.WORKER_ID_BITS + self.SEQUENCE_BITS)) |
            (self.worker_id << self.SEQUENCE_BITS) |
            self.sequence
        )
    
    def _current_ms(self) -> int:
        return int(time.time() * 1000)
    
    def _wait_next_ms(self, current_ms: int) -> int:
        while current_ms <= self.last_timestamp:
            current_ms = self._current_ms()
        return current_ms

generator = SnowflakeIDGenerator(worker_id=42)
tweet_id = generator.next_id()
# tweet_id: 1715612321990152192 (sortable by time!)
```

---

## 7) High-Level Design (HLD)

```text
Mobile/Web Client
    |
    v
[Global CDN / WAF]       <- Edge: DDoS protection, TLS, static assets
    |
    v
[Global Load Balancer]   <- DNS-based geo routing
    |
    v
[API Gateway]            <- Auth (JWT), Rate limiting (100 tweets/hr), Routing
    |
    +-------------+------------------+
    |             |                  |
    v             v                  v
[Tweet Service] [Timeline Service] [Follow Service]
    |                |                    |
    v                v                    v
[Tweet DB]     [Timeline Cache]    [Follow Graph DB]
[Outbox]       [Timeline Store]
    |
    v
[Event Bus (Kafka)]
    |
    +----------+----------+----------+
    |          |          |          |
    v          v          v          v
[Fanout]  [Search]  [Notif.]  [Analytics]
[Workers] [Indexer] [Workers] [Pipeline]
```

---

## 8) Low-Level Design (LLD)

### Tweet Service
```python
class TweetService:
    def __init__(self):
        self.db = TweetDB()
        self.media_store = MediaStore()
        self.event_bus = KafkaProducer()
        self.id_gen = SnowflakeIDGenerator(worker_id=get_worker_id())
    
    async def post_tweet(
        self,
        author_id: str,
        text: str,
        media_keys: list = None,
        reply_to_id: int = None,
        idempotency_key: str = None
    ) -> dict:
        
        # 1. Check idempotency (duplicate request protection)
        if idempotency_key:
            existing = await self.db.get_by_idempotency_key(idempotency_key)
            if existing:
                return existing
        
        # 2. Input validation
        if len(text) > 280:
            raise TweetTooLongError()
        if await self.content_filter.is_spam(text):
            raise SpamDetectedError()
        
        # 3. Generate tweet ID
        tweet_id = self.id_gen.next_id()
        
        # 4. Save tweet + publish event atomically (transactional outbox)
        async with self.db.transaction():
            tweet = await self.db.insert_tweet({
                "id": tweet_id,
                "author_id": author_id,
                "body": text,
                "media_keys": media_keys or [],
                "reply_to_id": reply_to_id,
                "created_at": datetime.utcnow()
            })
            
            # Store in outbox (same transaction)
            await self.db.insert_outbox({
                "event_type": "TWEET_CREATED",
                "payload": json.dumps({
                    "tweet_id": str(tweet_id),
                    "author_id": author_id,
                    "text": text,
                    "created_at": tweet["created_at"].isoformat()
                })
            })
        
        return tweet
```

### Hybrid Fanout Worker
```python
class HybridFanoutWorker:
    CELEBRITY_THRESHOLD = 1_000_000  # Users with > 1M followers use read-fanout
    BATCH_SIZE = 5000  # Timeline write batch size
    
    async def handle_tweet_created(self, event: dict):
        author_id = event["author_id"]
        tweet_id = event["tweet_id"]
        timestamp = float(event["created_at_ts"])
        
        follower_count = await self.user_cache.get_follower_count(author_id)
        
        if follower_count > self.CELEBRITY_THRESHOLD:
            # Celebrity: store as "celebrity post" - followers fetch on read
            await self.celebrity_post_store.add(author_id, tweet_id, timestamp)
            return
        
        # Regular user: write to all follower timelines
        await self._fanout_to_followers(author_id, tweet_id, timestamp)
    
    async def _fanout_to_followers(
        self, 
        author_id: str, 
        tweet_id: str, 
        timestamp: float
    ) -> None:
        # Paginate through followers in batches
        cursor = None
        while True:
            followers, cursor = await self.follow_service.get_followers(
                author_id, cursor=cursor, limit=self.BATCH_SIZE
            )
            
            if not followers:
                break
            
            # Batch write to Redis timelines
            pipe = self.redis.pipeline()
            for follower_id in followers:
                timeline_key = f"timeline:{follower_id}"
                # Sorted set: score=timestamp, member=tweet_id
                pipe.zadd(timeline_key, {tweet_id: timestamp})
                # Keep only last 800 tweets per timeline
                pipe.zremrangebyrank(timeline_key, 0, -801)
                pipe.expire(timeline_key, 7 * 24 * 3600)  # 7 day TTL
            
            await pipe.execute()
```

### Timeline Service (with hybrid read)
```python
class TimelineService:
    async def get_home_timeline(
        self,
        user_id: str,
        cursor: str = None,
        limit: int = 20
    ) -> dict:
        
        max_score = float(cursor) if cursor else "+inf"
        
        # Step 1: Get pre-computed timeline from Redis
        tweet_ids = await self.redis.zrevrangebyscore(
            f"timeline:{user_id}",
            max=max_score,
            min="-inf",
            start=0,
            num=limit * 2,  # Overfetch for celebrity merge
            withscores=True
        )
        
        # Step 2: Get celebrity tweets (merged at read time)
        celebrity_ids = await self.get_followed_celebrities(user_id)
        celebrity_tweets = []
        for celebrity_id in celebrity_ids:
            tweets = await self.celebrity_post_store.get_recent(
                celebrity_id, 
                since=time.time() - 7 * 86400  # Last 7 days
            )
            celebrity_tweets.extend(tweets)
        
        # Step 3: Merge and sort by timestamp
        all_entries = list(tweet_ids) + celebrity_tweets
        all_entries.sort(key=lambda e: e[1], reverse=True)  # Sort by score/timestamp
        
        # Take top N
        page = all_entries[:limit]
        
        # Step 4: Batch fetch tweet data
        tweet_id_list = [entry[0] for entry in page]
        tweets = await self.tweet_service.batch_get_tweets(tweet_id_list)
        
        # Step 5: Apply ranking (recency + engagement signals)
        ranked = await self.ranking_service.rank(tweets, user_id)
        
        next_cursor = str(page[-1][1]) if len(page) == limit else None
        
        return {
            "data": ranked[:limit],
            "meta": {"next_token": next_cursor}
        }
```

---

## 9) Critical Flows

### Post tweet flow (end-to-end)
```text
1. Client sends POST /v1/tweets
2. API Gateway: validates JWT, checks rate limit (100 tweets/hr)
3. Tweet Service:
   a. Check idempotency key
   b. Run spam filter (ML classifier, < 10ms)
   c. Generate Snowflake ID
   d. BEGIN TRANSACTION
      - INSERT tweet into tweet_db (sharded by tweet_id)
      - INSERT into outbox table
   e. COMMIT
   f. Return tweet to client (response in ~50ms)
4. Outbox worker reads outbox, publishes to Kafka "tweet-events" topic
5. Fanout worker consumes from Kafka:
   - If author has < 1M followers: push tweet_id to all follower timelines in Redis
   - If celebrity: mark as celebrity post (lazy fanout on read)
6. Search indexer consumes from Kafka: indexes tweet for search
7. Notification worker: notifies @mentions, reply threads

Timeline read flow:
1. Client sends GET /v1/timeline/home?max_results=20
2. API Gateway: validates JWT
3. Timeline Service:
   a. Read pre-computed timeline from Redis (sorted set, O(log n))
   b. Merge celebrity tweets (from celebrity post store)
   c. Sort by timestamp + apply ranking model
   d. Batch fetch tweet details from tweet cache
   e. Return response in ~30ms (cache hit path)
```

---

## 10) Bottlenecks + Scaling

### Celebrity fanout
```text
Problem: Taylor Swift has 100M followers. She posts one tweet.
         If we write to 100M timelines: 100M Redis writes at 10K writes/sec = 2.8 hours!

Solution: Hybrid fanout
- Maintain list of celebrity accounts (> 1M followers)
- Don't fanout celebrities writes at all
- On timeline read: merge celebrity posts into pre-computed timeline
- Cost: extra ~10 Redis reads per timeline request (one per followed celebrity)
  But: most users follow < 5 celebrities, so cost is low
```

### Hot tweet reads
```text
Problem: Breaking news tweet gets 10M reads in 10 minutes
         = 16,000 reads/second for ONE tweet

Solution: Multi-tier caching
- Local in-process cache per app server (top 1000 tweets, 1min TTL)
- Redis cache (tweet detail, 5min TTL)
- Database read (only on cache miss)

Expected: 99% cache hit rate for viral tweets
```

### Timeline cache miss
```text
Problem: 5% of users open app after months of inactivity
         Redis timeline expired, need to rebuild from scratch

Solution: Lazy timeline reconstruction
- On cache miss: query follow graph, get recent tweets from each followee
- Rebuild timeline sorted set in Redis
- Expensive but rare (idle users returning)
- SLO: P99 < 2 seconds for cold timeline load
```

---

## 11) Failure Handling

```text
Failure                Impact                      Mitigation
--------------------------------------------------------------------
Fanout lag             Stale timelines (minutes)   Hybrid fanout: read from author
                                                   timeline as fallback
Ranking service down   Lower feed quality          Fallback to chronological order
Timeline cache miss    Slower timeline load         Rebuild from author timelines
                                                   P99 budget: 2s
Follow graph DB slow   Follow/unfollow delays      Cache follow counts, degrade
                                                   suggestions
Search index lag       Tweet not searchable         Freshness SLO: 1 min, async retry
Spam attack            Feed degradation            Rate limits + ML classifier
Tweet DB shard failure Tweets unreadable            3x replication, auto-failover
Notification storm     Push server overloaded       Rate limit per user/device
```

---

## 12) Security & Abuse

### Rate limiting tiers
```python
rate_limits = {
    "tweet_creation": {
        "free": "100 tweets / hour",
        "verified": "300 tweets / hour",
        "api_basic": "50 tweets / 15 min"
    },
    "api_reads": {
        "free": "500K reads / month",
        "basic": "10M reads / month",
        "enterprise": "custom"
    }
}

# Bot detection signals
bot_signals = [
    "High tweet rate (> 50 tweets/hour)",
    "Tweets at regular intervals (robotic pattern)",
    "Immediate follows after account creation",
    "No profile picture",
    "Username is random characters",
    "Same text tweeted multiple times (spam)",
    "IP address associated with datacenter (not residential)",
]
```

### Content moderation pipeline
```text
Tweet Created
    |
    v
Sync blocklist check (< 1ms)     <- Keyword/URL blocklist, instant result
    |                                Return tweet if clean
    v
Async ML classifier (100ms-2s)  <- Hate speech, harassment, NSFW
    |                                If flagged: hide tweet pending review
    v
Human review queue              <- For edge cases, appeals
    |
    v
Policy decision: allow/remove/restrict
```

---

## 13) Interview Strategy

### How to frame your answer
```text
Opening: "The core challenge of Twitter is fanout at scale with extreme skew 
from celebrity accounts. My design will use hybrid fanout, separating the write 
path from the read path using an event bus."

Then walk through:
1. Clarify (2 min): How many DAU? Is search in scope? Trends? Media?
2. Estimate (3 min): 200M DAU, 500M tweets/day, 50B timeline reads/day
3. HLD (10 min): Core components, data flow
4. Deep dive (15 min): Fanout algorithm, timeline storage, ranking
5. Tradeoffs (10 min): Consistency vs latency, fanout strategies
6. Failure handling (5 min): What breaks first and how to fix
```

### Common follow-up questions
```text
Q: How do you handle a user unfollowing? Does their timeline update?
A: On unfollow, we don't immediately purge their timeline (expensive).
   We filter at read time: if tweet author is not in current follow list, skip.
   Old tweets remain in timeline briefly but are filtered out within TTL.

Q: How does ranking work?
A: Candidate generation -> pre-ranking in fanout worker -> final ranking at read time.
   Signals: recency, engagement velocity (likes/second), author affinity (how often
   user engages with this author), content type preference.

Q: How do you handle trending topics?
A: Count hashtag occurrences in a sliding 1-hour window using Redis sorted sets.
   UPDATE sorted set every time a tweet with hashtag is posted (atomic ZINCRBY).
   ZREVRANGE to get top 10 each minute.
   Cache trending topics with 1-minute TTL.

Q: How do you ensure tweet delivery order?
A: Within a single user's timeline: sorted by timestamp (Snowflake ID embeds time).
   Across timelines: eventual consistency OK - minor reordering acceptable.
   For reply threads: maintain parent_tweet_id chain.
```

---

## 14) Metrics and Observability

```python
key_metrics = {
    "business": [
        "tweet_create_success_rate",
        "timeline_p95_latency_ms",
        "timeline_cache_hit_rate",
        "fanout_lag_p95_ms",           # Time from tweet to timeline insertion
        "active_users_1h_1d_7d",
    ],
    "reliability": [
        "tweet_db_error_rate",
        "fanout_queue_depth",          # Alert if > 10M (should be near-0 normally)
        "timeline_cache_memory_usage", # Alert if > 80%
        "search_indexing_lag_seconds",
    ],
    "performance": [
        "tweet_write_p50_p95_p99_ms",
        "timeline_read_p50_p95_p99_ms",
        "fanout_throughput_per_second",
        "celebrity_post_merge_latency",
    ],
}
```

---

## Rigorous Architecture Addendum

### Scaled architecture
```text
Client -> API Gateway -> Tweet Service -> Tweet DB (sharded, 50 partitions)
                                    -> Outbox Table
                                       -> Kafka "tweet-events" topic
                                          -> Fanout Workers (500 instances)
                                             -> Redis Timeline Store
                                          -> Search Indexer -> Elasticsearch
                                          -> Notification Workers -> Push/Email/SMS

Client -> Timeline API -> Timeline Cache (Redis Cluster) -> Timeline Store (Cassandra)
                       -> Celebrity Post Store
                       -> Ranking Service -> Feature Store (Redis)

Graph Service -> Follow Graph DB (PostgreSQL, sharded by user_id)
              -> Follow Cache (Redis, top users pre-cached)
              
Media Service -> Object Store (S3) -> CDN
```

### Correctness boundaries
- Tweet write is durable before the API returns success.
- Timeline insertion is async and can lag (P95 < 5 seconds).
- Like/repost counters are eventually consistent with periodic reconciliation.
- Follow/unfollow requires read-your-writes for the acting user.
- Abuse decisions may hide content after initial write.

### Failure table
```text
Failure              Impact                         Mitigation
Fanout lag           stale timelines                hybrid fanout, queue autoscale
Ranking down         lower relevance                chronological fallback
Graph DB slow        follow/timeline issues         cache graph edges, degrade suggestions
Search index lag     tweet not searchable yet       freshness SLO and async retry
Spam attack          feed quality degradation       rate limits and classifier pipeline
Tweet DB shard fail  tweets unreadable (5% of users) 3x replication, auto-failover
```
