# Project 2: URL Shortener with Analytics

## Architecture
```text
Create API -> Code Generator -> Link DB
Redirect API -> Cache -> Link DB -> HTTP Redirect
Click Event -> Queue -> Aggregator -> Analytics DB
```

## Tech choices
- API: Go/Node/FastAPI
- OLTP DB: Postgres
- Cache: Redis
- Queue: Kafka/RabbitMQ
- Analytics store: ClickHouse/BigQuery/Postgres aggregate tables

## Step-by-step plan
1. Shorten endpoint with Base62 code generation.
2. Redirect endpoint with cache-aside.
3. Emit click events asynchronously.
4. Build hourly/day aggregation jobs.
5. Build analytics query API with pagination and filters.
6. Add custom aliases and expiration policy.

## Scaling improvements
- Edge caching for redirect.
- Bloom filter for missing code fast-fail.
- Partition analytics tables by date.

## Production concerns
- Abuse detection (phishing/malware).
- Bot traffic filtering.
- Idempotent create API.

## Stretch goals
- Per-link access control.
- QR-code generation and campaign tags.

## Extended Build Tasks

### Data quality
- Normalize URL canonicalization rules.
- Handle duplicate long URLs with configurable behavior.

### Analytics maturity
- Unique visitor approximation (e.g., HLL conceptually)
- Hour/day/week rollups
- Late event correction pipeline

### Abuse controls
- Domain reputation scoring
- Burst-link creation throttling
- Incident blocklist update path

## Sophisticated Build Expansion

### Real-world equivalent
Bitly-style systems combine a fast redirect service, link management, analytics, abuse control, and campaign reporting.

### Architecture
```text
Create API -> Idempotency -> Link Store -> Cache
Redirect API -> Cache -> Link Store -> Queue
Analytics Worker -> Rollup Store -> Analytics API
Abuse Scanner -> Domain Policy Store
```

### Advanced topics
- Custom aliases and collision handling.
- Expiration and soft deletes.
- Edge cache for hot links.
- Approximate unique visitor counting.
- Late event correction.
- Bot filtering.

### Production questions
- Does analytics failure block redirects?
- How are malicious URLs blocked after creation?
- What is the consistency contract for dashboard metrics?
- How do you migrate code generation strategy later?

## Rigorous Acceptance Criteria

### Minimum architecture
```text
HTTP API -> Link Service -> Link Store
                    -> Idempotency Store
                    -> Cache
                    -> Analytics Queue -> Aggregator -> Analytics Store
```

### Required behaviors
- Duplicate create request with same idempotency key returns same response.
- Expired link returns 410.
- Missing code returns 404.
- Analytics failure does not block redirect.
- Invalid URL is rejected.
- Custom alias collision is rejected.

### Failure tests
- Cache unavailable.
- Analytics worker down.
- Code collision.
- Burst redirect traffic for one hot code.
