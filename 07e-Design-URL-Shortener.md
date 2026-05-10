# Design URL Shortener (Comprehensive)

## Intuition
Simple write path, extreme read path optimization (redirect at very high QPS).

## Requirements
- Create short URL
- Resolve and redirect
- Optional expiry/custom alias
- Analytics clicks by time/geo/referrer

## NFRs
- Redirect latency very low
- High availability
- Abuse resistance

## HLD
```text
Shorten API -> ID Generator -> URL Store
Redirect API -> Cache -> URL Store -> 301/302
Click Event -> Queue -> Analytics Aggregator -> OLAP Store
```

## LLD
- Base62 encoded IDs.
- Optional vanity aliases with uniqueness checks.
- Bloom filter for probable misses to protect DB.

## Schema
```sql
links(code PK, long_url, owner_id, created_at, expires_at, is_active)
click_events(id, code, ts, ip_hash, ua_hash, referrer, geo)
```

## APIs
- `POST /v1/links`
- `GET /{code}`
- `GET /v1/links/{code}/analytics`

## Bottlenecks
- Hot popular links
- Abuse traffic and bots

## Scaling
- Global CDN/edge redirects.
- In-memory cache for hot codes.
- Write analytics asynchronously.

## Failure Handling
- If analytics pipeline down, preserve redirect path and buffer/drop analytics according to policy.
- Idempotent link creation using request keys.

## Security
- URL safety scanning, phishing/malware blocklists.

## Interview framing
"I isolate redirect fast path from analytics path to keep user-facing latency stable."

## Extended Deep Dive

### Code generation strategies
- Global sequence with Base62 encode
- Random code + collision retry
- Segment-based ID allocators per region

### Redirect correctness
- Preserve query params policy
- Safe redirect mode for suspicious links
- Soft delete vs hard delete semantics

### Analytics correctness
- At-least-once event emission
- Deduplication by `(code, request_id)`
- Time-bucketed aggregation with late-arrival handling

## Sophisticated Production Expansion

### Product promise
Redirects must be extremely fast and highly available while creation, analytics, and abuse controls remain correct enough for business needs.

### Mature architecture
```text
Create API -> Idempotency Store -> Code Generator -> Link DB -> Cache
Redirect API -> Edge Cache -> Service Cache -> Link DB -> 302
Click Event -> Queue -> Stream Processor -> Analytics Store -> Dashboard
Abuse Scanner -> Reputation Store -> Redirect Policy
```

### Real-life design choices
- Redirect path must not synchronously wait for analytics.
- Expired links must not be reused accidentally.
- Link creation needs idempotency because clients retry.
- Hot links require edge caching and origin protection.

### What breaks first
- Hot popular links.
- Bot traffic and malicious links.
- Analytics queue lag.
- DB miss traffic for nonexistent codes.

### Metrics
- Redirect p95/p99.
- Link creation error rate.
- Cache hit rate.
- Analytics lag.
- Blocked malicious redirects.

## Rigorous Architecture Addendum

### Scaled architecture
```text
Create Client -> API Gateway -> Link Service -> Idempotency Store
                                       -> Code Generator
                                       -> Link DB
                                       -> Cache Warm

Redirect Client -> Edge Cache -> Redirect Service -> L1/L2 Cache -> Link DB
                                           -> Click Event Queue
                                           -> Analytics Aggregator -> OLAP Store

Abuse Scanner -> Domain Reputation Store -> Redirect Policy
```

### Correctness boundaries
- Link creation is idempotent by request key.
- Code uniqueness is strongly enforced.
- Redirect can serve from cache with bounded staleness.
- Analytics is at-least-once and deduplicated downstream if needed.
- Expired/deactivated links must not redirect.

### Failure table
```text
Failure              Impact                         Mitigation
Cache down           DB load spike                   rate-limit misses, fallback DB
DB down              new links fail                  serve cached redirects only
Analytics down       delayed dashboard               queue buffer and DLQ
Abuse scanner down   unsafe links risk               conservative policy for suspicious domains
Hot link             origin overload                 edge caching and hot-key replication
```
