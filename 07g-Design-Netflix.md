# Design Netflix (Comprehensive)

## Intuition
Streaming systems optimize startup latency, bitrate adaptation, and global reliability.

## Requirements
- Browse catalog
- Personalized homepage
- Playback with resume state
- Multi-device support

## NFRs
- Very high availability
- Fast startup (< few seconds target)
- Global scale and region failover

## HLD
```text
Client -> API Gateway -> Personalization + Metadata Services
Client -> Playback Auth -> Manifest Service -> CDN -> Video Segments
Progress Service stores continue-watching offset
```

## LLD
- Precompute recommendation candidates.
- Device-aware manifests and codecs.
- Regional license enforcement.

## Schema
```sql
titles(id, type, metadata_json, availability_region)
profiles(id, account_id, maturity_level)
watch_progress(profile_id, title_id, offset_ms, updated_at)
```

## APIs
- `GET /v1/home`
- `GET /v1/titles/{id}`
- `GET /v1/playback/{id}/manifest`
- `POST /v1/progress`

## Bottlenecks
- Peak-hour CDN pressure
- Personalization latency
- Metadata cache misses

## Scaling
- Multi-CDN traffic steering.
- Edge cache optimization by segment popularity.
- Async personalization pipelines.

## Failure Handling
- Fallback to cached home rows if rec service unavailable.
- Playback quality downgrade under bandwidth degradation.

## Security
- DRM, tokenized playback URLs, abuse detection.

## Interview framing
"I separate control APIs from data-heavy media delivery and design for graceful quality degradation rather than hard failure."

## Extended Deep Dive

### Recommendation serving model
- Candidate retrieval from precomputed sets
- Ranking by profile/context
- Explore-exploit balancing

### Multi-CDN control plane
- Real-time performance telemetry per ISP/region
- Traffic steering with health + cost weighting

### Resilience strategy
- Fallback home rows when personalization fails
- Progressive bitrate downgrade before playback failure

## Sophisticated Production Expansion

### Product promise
Playback should start quickly and remain smooth globally, while discovery and personalization improve engagement.

### Mature architecture
```text
Content Ingest -> Encoding Pipeline -> Object Store -> CDN Placement
Catalog API -> Metadata Store
Playback API -> Entitlement -> Manifest Service -> CDN
Viewing Events -> Stream Processing -> Recommendations
```

### Real-life design choices
- Playback path must degrade independently from recommendations.
- Popular titles are pre-positioned close to users.
- Device capability affects rendition choice.
- Viewing events are async and high volume.

### What breaks first
- CDN miss/origin egress.
- Playback entitlement latency.
- Recommendation service degradation.
- Regional traffic spikes.

### Metrics
- Startup time.
- Rebuffering rate.
- CDN hit ratio.
- Playback errors by device.
- Recommendation fallback rate.

## Rigorous Architecture Addendum

### Scaled architecture
```text
Studio Ingest -> Encoding Pipeline -> Rendition Store -> CDN Placement
Catalog Service -> Metadata DB -> Search/Discovery Index
Playback API -> Entitlement -> Manifest Service -> CDN URLs
Client Player -> CDN Edge -> Segments
Viewing Events -> Stream Processor -> Personalization Features
```

### Correctness boundaries
- Entitlement must be correct before playback.
- Catalog metadata can be cached.
- Recommendations can be stale or fallback to popular rows.
- Playback segment delivery is CDN-heavy and should not depend on recommendation services.
- Viewing events are eventual.

### Failure table
```text
Failure              Impact                         Mitigation
CDN degraded         buffering/errors               multi-CDN steering
Manifest down        playback start failure         cache manifests where safe
Entitlement slow     start delay                    short-lived cached entitlement
Recommendation down  generic homepage               fallback rows
Event pipeline lag   stale personalization          async catch-up
```
