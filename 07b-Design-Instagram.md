# Design Instagram (Comprehensive)

## Intuition
Instagram combines social graph, media pipeline, and ranking-heavy feed retrieval.

## Requirements
- Upload photo/video
- Feed + stories + reels discovery
- Like/comment/share/save
- Follow graph

## NFRs
- Fast feed load
- Durable media
- High availability for read path
- Moderation compliance

## Capacity
- Media storage and CDN egress dominate costs.
- Read QPS (feed view) usually far greater than upload QPS.

## HLD
```text
Upload API -> Media Ingest -> Transcode/Thumbnail Pipeline -> Object Store -> CDN
Feed API -> Ranking Service -> Feed Cache/Store
Social Graph Service -> Follow DB
```

## LLD
- Upload in chunks with resumable sessions.
- Async processing for thumbnails/transcoding.
- Metadata in relational/NoSQL DB; binary media in object store.

## Schema
```sql
media(id, owner_id, type, object_key, created_at, status)
follows(src_user, dst_user, created_at)
reactions(media_id, user_id, type, created_at)
comments(id, media_id, user_id, body, created_at)
stories(id, user_id, media_id, expires_at)
```

## APIs
- `POST /v1/media/init-upload`
- `POST /v1/media/{id}/complete`
- `GET /v1/feed?cursor=...`
- `POST /v1/media/{id}/like`

## Bottlenecks
- Transcoding backlog
- Feed ranking latency
- Cold caches on trending content

## Scaling
- Queue-based media pipeline with autoscaling workers.
- Edge caching for media and profile assets.
- Precompute partial feed candidates.

## Failure Handling
- If ranking service fails, fallback to chronological feed.

## Sophisticated Production Expansion

### Product promise
Users should upload media reliably and consume a personalized visual feed quickly across mobile networks.

### Mature architecture
```text
Mobile Client -> Upload API -> Object Store
                         -> Media Processing Queue
                         -> Thumbnail/Transcode Workers
                         -> Metadata Store
                         -> CDN

Feed API -> Candidate Store -> Ranking Service -> Feed Cache
Graph Service -> Follow Store
Moderation Pipeline -> Review Queue -> Policy Store
```

### Real-life design choices
- Binary media lives in object storage, not the relational DB.
- Upload completion publishes processing jobs.
- Feed can degrade to chronological if ranking is unavailable.
- Moderation can block distribution while preserving upload state.

### What breaks first
- Transcoding backlog.
- CDN miss storms on viral content.
- Feed ranking p99 latency.

### Metrics
- Upload completion rate.
- Processing queue age.
- Feed render latency.
- Feed cache hit rate.
- Moderation decision latency.

## Rigorous Architecture Addendum

### Scaled architecture
```text
Client -> Upload API -> Upload Session Store
                    -> Raw Object Store
                    -> Media Processing Stream
                       -> Thumbnail Workers
                       -> Transcode Workers
                       -> Moderation Workers
                    -> Metadata DB
                    -> CDN

Client -> Feed API -> Feed Cache -> Candidate Store -> Ranking Service
Graph Service -> Follow DB
Engagement Service -> Counter Store -> Analytics Stream
```

### Correctness boundaries
- Upload completion is acknowledged only after raw media and metadata are durable.
- Media processing is async and retryable.
- Feed ranking can be stale.
- Comments require durable write before acknowledgment.
- Like counts can be eventually consistent.

### Failure table
```text
Failure                Impact                       Mitigation
Object store slow       upload delays                resumable multipart upload
Transcode backlog       media unavailable            queue priority and autoscaling
Moderation lag          delayed distribution         pending-review state
Ranking down            feed quality lower           chronological fallback
CDN miss storm          origin load spike            prewarming and origin shielding
```
- If transcode fails, retry with capped attempts + DLQ.

## Security
- Malware scanning on uploaded files.
- NSFW/moderation scoring pipeline.

## Interview framing
"Instagram is two systems: media processing and personalized feed. I design each path separately and connect with event-driven updates."

## Extended Deep Dive

### Feed quality architecture
- Candidate generation layer
- Feature computation layer
- Ranker model serving layer
- Re-ranking with diversity/freshness constraints

### Story expiration internals
- TTL-based storage with lazy cleanup
- Background sweeper for guaranteed hard-delete policy

### Media delivery optimization
- Device-aware rendition selection
- Progressive image loading and adaptive bitrate for reels/videos
