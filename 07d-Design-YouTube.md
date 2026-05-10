# Design YouTube (Comprehensive)

## Intuition
Video platforms are dominated by ingest/transcoding pipeline and global content delivery.

## Requirements
- Upload video
- Process/transcode multiple renditions
- Stream playback adaptively
- Search/discovery/recommendations
- Comments/likes/subscriptions

## NFRs
- Durable media
- Fast playback start time
- Massive bandwidth scalability
- High availability

## HLD
```text
Upload API -> Ingest Service -> Processing Queue -> Transcode Workers
                                         -> Metadata DB
Transcoded Output -> Object Storage -> CDN -> Player
```

## LLD
- Chunked resumable upload.
- Async transcode jobs per codec/bitrate.
- Generate HLS/DASH manifests for adaptive bitrate.

## Schema
```sql
videos(id, owner_id, title, status, created_at, duration)
video_renditions(video_id, profile, object_key, bitrate, codec)
subscriptions(user_id, creator_id)
engagement(video_id, likes, comments, watch_time_stats)
```

## APIs
- `POST /videos/upload/init`
- `PUT /videos/{id}/chunk`
- `POST /videos/{id}/finalize`
- `GET /videos/{id}/playback-manifest`

## Bottlenecks
- Transcode backlog
- Origin egress during cache misses
- Metadata search latency

## Scaling
- Autoscaled transcode pools.
- Multi-CDN strategy.
- Pre-warm popular videos at edge.

## Failure handling
- Retry failed chunks/transcode tasks.
- DLQ for poisoned media jobs.
- Playback fallback to lower bitrate.

## Security
- Content copyright checks.
- Signed playback URLs/tokens.

## Interview framing
"I model YouTube as two major systems: media pipeline and playback delivery, each with separate scaling/failure concerns."

## Extended Deep Dive

### Ingest robustness
- Multipart resumable uploads
- Integrity checks (chunk hash + final manifest verification)
- Retry-safe upload session IDs

### Transcoding pipeline controls
- Priority classes (premium/live/standard)
- Retry budget and poison-job quarantine
- Cost-aware codec/rendition policy

### Playback QoE metrics
- Startup delay
- Rebuffer ratio
- Average bitrate
- Error-per-play

## Sophisticated Production Expansion

### Product promise
Users should upload videos reliably and viewers should get fast startup, adaptive playback, and durable global access.

### Mature architecture
```text
Upload Client -> Ingest API -> Raw Object Store
                         -> Processing Queue
                         -> Transcode Workers
                         -> Rendition Store
                         -> Metadata DB
                         -> CDN

Playback API -> Entitlement -> Manifest Service -> CDN URLs
Events -> Stream Processing -> Recommendations/Analytics
```

### Real-life design choices
- Upload path is separate from playback path.
- Transcoding is async and retryable.
- CDN edge serves hot videos; origin is protected.
- Player adapts bitrate based on bandwidth.

### What breaks first
- Transcoding capacity for spikes.
- Origin egress during CDN misses.
- Recommendation/ranking latency.

### Metrics
- Upload failure rate.
- Transcode queue age.
- Playback startup time.
- Rebuffering ratio.
- CDN hit rate.

## Rigorous Architecture Addendum

### Scaled architecture
```text
Uploader -> Upload API -> Raw Video Object Store
                     -> Metadata DB
                     -> Processing Queue
                        -> Transcode Workers
                        -> Thumbnail Workers
                        -> Copyright/Moderation
                     -> Rendition Store
                     -> CDN Placement

Viewer -> Playback API -> Entitlement -> Manifest Service -> CDN
Events -> Stream Processor -> Analytics + Recommendation Features
```

### Correctness boundaries
- Raw upload must be durable before processing starts.
- Transcode jobs are at-least-once and idempotent by video/rendition key.
- Playback manifest can reference only verified renditions.
- Watch analytics can be eventual.
- Copyright/moderation can restrict publication after upload.

### Failure table
```text
Failure              Impact                         Mitigation
Upload interrupted   incomplete video               resumable chunks and checksums
Transcode failure    missing rendition              retry, DLQ, fallback profiles
CDN miss storm       origin egress spike            origin shield and prewarming
Entitlement down     playback denied/error          cached entitlements with short TTL
Analytics lag        stale recommendations          async catch-up processing
```
