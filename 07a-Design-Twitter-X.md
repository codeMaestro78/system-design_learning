# Design Twitter/X (Comprehensive)

## 1) Intuition
Twitter is a write-heavy + fanout-heavy system where the hardest problem is delivering a low-latency personalized home timeline under huge skew (celebrity accounts).

## 2) Functional Requirements
- Post tweet (text/media links)
- Follow/unfollow
- Home timeline
- User timeline
- Like/reply/retweet
- Search and hashtag trends

## 3) Non-Functional Requirements
- High write availability
- Home timeline P95 < 300 ms
- Eventual consistency acceptable for some counters
- Durable tweet storage

## 4) Capacity Estimation (example method)
- Assume `U` DAU, `T` tweets/day, avg followers `F`.
- Fanout operations/day ≈ `T * F` (before optimization).
- This quickly dominates compute/storage I/O.

## 5) APIs
- `POST /v1/tweets`
- `GET /v1/timeline/home?cursor=...`
- `POST /v1/follows`
- `POST /v1/tweets/{id}/like`

## 6) Data Model
```sql
users(id, handle, created_at, ...)
tweets(id, author_id, body, media_ref, created_at)
follows(follower_id, followee_id, created_at)
timeline_entries(user_id, tweet_id, score, created_at)
engagement(tweet_id, likes, replies, reposts)
```

## 7) HLD
```text
Client -> API Gateway -> Tweet Service -> Tweet DB
                           |-> Event Bus -> Fanout Workers -> Timeline Store/Cache
Client -> Timeline Service -> Timeline Cache -> Timeline Store
```

## 8) LLD (Critical choices)
- **Hybrid fanout**:
  - Fanout-on-write for normal users
  - Fanout-on-read for celebrity accounts
- Cursor-based pagination for timeline.
- Ranking service applies recency + social relevance + engagement.

## 9) Critical Flow (Post tweet)
1. Validate/auth.
2. Store tweet in durable DB.
3. Publish tweet-created event.
4. Fanout workers enqueue timeline updates.
5. Cache invalidations for affected users.

## 10) Bottlenecks + Scaling
- Celebrity fanout spikes.
- Hot partitions on popular tweet IDs.
- Cache churn during breaking news.

### Mitigations
- Separate celebrity pipeline.
- Batched fanout workers.
- Multi-tier cache + request coalescing.

## 11) Failure Handling
- If fanout lags, timeline service can merge from author timelines on read.
- Event retries with DLQ.
- Idempotent timeline insert (`user_id,tweet_id` unique key).

## 12) Security & Abuse
- Anti-spam throttling, bot detection.
- Content moderation pipeline (sync blocklist + async classifiers).

## 13) Interview Strategy
State clearly: "The core challenge is fanout at scale with skew. I’ll use hybrid fanout and discuss consistency/latency tradeoffs."

## Extended Deep Dive

### Timeline ranking internals
- Candidate generation from follows + graph expansion.
- Lightweight pre-ranking in fanout workers.
- Final ranking at read time with freshness + relevance model.

### Consistency boundaries
- Tweet write path: durable before ack.
- Engagement counters: eventually consistent with periodic reconciliation.

### Anti-abuse controls
- Rate limits per account/IP/device.
- Bot scoring with behavior-based features.
- Shadow bans and spam-quality heuristics.

## Sophisticated Production Expansion

### Product promise
Users should see a fresh, relevant timeline with low latency even when traffic is skewed toward a small number of popular accounts.

### Mature architecture
```text
Tweet API -> Tweet Store -> Tweet Created Stream
                          -> Fanout Workers -> Timeline Store
                          -> Search Indexer
                          -> Notification Workers

Timeline API -> Timeline Cache -> Timeline Store -> Ranking Service
Graph API    -> Follow Graph Store
Media API    -> Object Store -> CDN
```

### Real-life design choices
- Normal accounts: fanout-on-write for fast timeline reads.
- Celebrity accounts: fanout-on-read to avoid writing to millions of timelines.
- Engagement counters: eventually consistent and periodically reconciled.
- Search: async indexing, so search freshness can lag tweet creation.

### What breaks first
- Fanout queue lag during viral events.
- Hot timeline reads for breaking news.
- Ranking service latency under personalized feed load.

### Metrics
- Tweet write success rate.
- Fanout lag p95.
- Timeline read p95/p99.
- Cache hit rate.
- Dropped/blocked spam rate.

## Rigorous Architecture Addendum

### Scaled architecture
```text
Client -> API Gateway -> Tweet Service -> Tweet DB
                                  -> Outbox/Tweet Stream
                                      -> Fanout Workers -> Timeline Store
                                      -> Search Indexer -> Search Shards
                                      -> Notification Workers

Client -> Timeline API -> Timeline Cache -> Timeline Store
                         -> Ranking Service -> Feature Store

Graph Service -> Follow Graph DB/Cache
Media Service -> Object Store -> CDN
```

### Correctness boundaries
- Tweet write is durable before the API returns success.
- Timeline insertion is async and can lag.
- Like/repost counters are eventually consistent.
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
```
