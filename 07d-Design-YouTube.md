# Design YouTube (Comprehensive)

## 1) Intuition
YouTube's hardest problems:
1. **Video ingestion & transcoding pipeline:** Raw uploads (often GBs) must be transcoded into 5+ resolutions before being streamable. This is compute-intensive and must be parallelized.
2. **Adaptive bitrate streaming:** The client must seamlessly switch quality based on bandwidth — requires serving video in small segments (HLS/DASH).
3. **Read-heavy, write-rare:** 500 hours of video uploaded per minute, but each video gets watched millions of times. Caching via CDN is non-negotiable.
4. **Recommendation engine:** 70% of YouTube watch time comes from recommendations. This is a massive ML system in itself.

Real-world analogy: YouTube is like a broadcast TV network where:
- Anyone can submit a show for broadcast (upload)
- Each show is re-mastered in 5 quality levels before airing (transcoding)
- The network has local affiliates in every city that cache popular shows (CDN)
- A recommendation algorithm decides what appears in your guide (recommendations)

---

## 2) Functional Requirements
- Upload video (up to 15 minutes for unverified, unlimited for verified)
- Transcode to multiple resolutions (360p, 480p, 720p, 1080p, 4K, HDR)
- Stream video with adaptive bitrate
- Search for videos
- Like, dislike, comment, subscribe
- Video recommendations (home page, sidebar "Up next")
- Video analytics for creators (views, watch time, demographics)
- Live streaming

---

## 3) Non-Functional Requirements
- **Video upload:** Resumable, parallel chunks; processing within 30 min of upload
- **Streaming latency:** < 2 seconds from play request to first frame
- **Availability:** 99.99%
- **Scale:** 2B MAU, 500M DAU, 1B hours watched/day, 500 hrs uploaded/min
- **Storage:** Exabytes of video (YouTube has > 1 billion videos stored)

---

## 4) Capacity Estimation

```python
youtube_scale = {
    "MAU": 2_000_000_000,
    "DAU": 500_000_000,
    
    # Uploads
    "upload_hours_per_minute": 500,
    "upload_hours_per_day": 500 * 60 * 24,   # 720,000 hours/day
    "avg_video_duration_minutes": 7,
    "videos_uploaded_per_day": (720_000 * 60) / 7,  # ~6.1M videos/day
    
    # Storage (per video, multiple resolutions)
    "storage_per_minute_of_video_gb": {
        "360p":  0.1,   # ~100 MB/hour
        "720p":  0.4,   # ~400 MB/hour
        "1080p": 1.0,   # ~1 GB/hour
        "4K":    4.0,   # ~4 GB/hour
    },
    "avg_storage_per_video_gb": 3,   # Across all resolutions
    "storage_added_per_day_pb": (6_100_000 * 3) / (1024**2),  # ~17 PB/day
    
    # Reads
    "hours_watched_per_day": 1_000_000_000,  # 1B hours
    "seconds_watched_per_day": 1_000_000_000 * 3600,
    "avg_bitrate_mbps": 2.0,  # Average across all quality levels
    "streaming_egress_tbps": (1_000_000_000 * 3600 * 2) / (1024**3),  # ~6.7 Tbps!
    
    # This is why CDN is non-negotiable
    "cdn_saves": "CDN handles ~95% of reads -> only ~335 Gbps hits origin",
}
```

---

## 5) API Design

### Upload API
```
# Initialize upload session
POST /upload/v3/videos
Content-Type: application/json
Authorization: Bearer {token}

Request:
{
    "title": "My Tutorial Video",
    "description": "...",
    "privacy_status": "public",    // "public", "unlisted", "private"
    "category_id": "28",           // 28 = Science & Technology
    "tags": ["python", "programming"]
}

Response:
{
    "upload_id": "AEnB...",
    "upload_url": "https://upload.youtube.com/upload/video?uploadType=resumable&upload_id=AEnB...",
    "expires_at": "2024-01-16T10:30:00Z"
}

# Upload video data (resumable, RFC 7233)
PUT https://upload.youtube.com/upload/video?uploadType=resumable&upload_id=AEnB...
Content-Type: video/mp4
Content-Range: bytes 0-1048575/314572800   // Byte range of this chunk / total
Content-Length: 1048576

[raw video bytes]

Response 200:
{
    "video_id": "dQw4w9WgXcQ",
    "status": "PROCESSING",
    "processing_status_url": "/v3/videos/dQw4w9WgXcQ/processing"
}
```

### Stream API
```
# Get video manifest for adaptive streaming
GET /v3/videos/{video_id}/stream
Accept: application/vnd.apple.mpegurl   // Request HLS

Response: HLS master playlist
#EXTM3U
#EXT-X-VERSION:6

# Each bandwidth tier points to its quality playlist
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d001e,mp4a.40.2"
https://cdn.youtube.com/v/{video_id}/360p/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d001f,mp4a.40.2"
https://cdn.youtube.com/v/{video_id}/720p/playlist.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
https://cdn.youtube.com/v/{video_id}/1080p/playlist.m3u8
```

---

## 6) Data Model

```sql
-- Videos
CREATE TABLE videos (
    id              VARCHAR(11) PRIMARY KEY,  -- YouTube's base64 ID (e.g., "dQw4w9WgXcQ")
    owner_id        BIGINT NOT NULL,
    title           VARCHAR(100) NOT NULL,
    description     TEXT,
    duration_secs   INTEGER,
    privacy_status  VARCHAR(10) DEFAULT 'public',  -- 'public','unlisted','private'
    status          VARCHAR(15) DEFAULT 'PROCESSING',  -- 'PROCESSING','READY','FAILED'
    view_count      BIGINT DEFAULT 0,         -- Denormalized counter
    like_count      INTEGER DEFAULT 0,
    comment_count   INTEGER DEFAULT 0,
    thumbnail_url   VARCHAR(500),             -- CDN URL
    created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
    published_at    TIMESTAMP                 -- NULL if private
);
CREATE INDEX idx_videos_owner ON videos(owner_id, created_at DESC);
CREATE INDEX idx_videos_status ON videos(status, created_at DESC);

-- Video assets (per quality level per video)
-- Multiple rows per video (one per quality tier)
CREATE TABLE video_assets (
    video_id        VARCHAR(11) NOT NULL,
    quality         VARCHAR(5) NOT NULL,    -- '360p','480p','720p','1080p','4k','hdr'
    manifest_url    VARCHAR(500) NOT NULL,  -- HLS playlist URL on CDN
    bitrate_kbps    INTEGER,
    width_px        INTEGER,
    height_px       INTEGER,
    file_size_bytes BIGINT,
    codec           VARCHAR(20),            -- 'avc1.640028' (H.264)
    PRIMARY KEY (video_id, quality)
);

-- Watch history (sharded by user_id; Cassandra for write volume)
CREATE TABLE watch_history (
    user_id         BIGINT NOT NULL,
    video_id        VARCHAR(11) NOT NULL,
    watched_at      TIMESTAMP NOT NULL,
    watch_duration_secs INTEGER,           -- How long they actually watched
    completed       BOOLEAN DEFAULT FALSE, -- Did they watch >= 90%?
    PRIMARY KEY (user_id, watched_at, video_id)
) WITH CLUSTERING ORDER BY (watched_at DESC);

-- Subscriptions
CREATE TABLE subscriptions (
    subscriber_id   BIGINT NOT NULL,
    channel_id      BIGINT NOT NULL,
    subscribed_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subscriber_id, channel_id)
);
CREATE INDEX idx_subscriptions_channel ON subscriptions(channel_id);

-- Comments (nested threading)
CREATE TABLE comments (
    id              BIGINT PRIMARY KEY,
    video_id        VARCHAR(11) NOT NULL,
    author_id       BIGINT NOT NULL,
    parent_id       BIGINT,               -- NULL for top-level comments
    body            TEXT NOT NULL,
    like_count      INTEGER DEFAULT 0,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_comments_video ON comments(video_id, created_at DESC);
```

---

## 7) Video Upload and Transcoding Pipeline

```text
The most technically complex part of YouTube.

Timeline for a 1GB video upload:
  0s:    Client starts uploading in chunks
  30s:   All chunks received, video stored in raw object storage
  35s:   Validation and safety scan starts
  60s:   360p version ready (fast to transcode, shown first)
  120s:  480p, 720p versions ready
  600s:  1080p, 4K versions ready (slow, large)
  720s:  Video fully ready at all qualities, published

Key insight: Start with low quality first so video is visible quickly.
```

```python
class VideoTranscodingPipeline:
    """
    Distributed transcoding: one job per quality level, run in parallel.
    Uses a job queue (SQS/Kafka) + worker pool.
    """
    
    QUALITY_CONFIGS = [
        {"quality": "360p",  "width": 640,  "height": 360,  "bitrate_kbps": 800,   "priority": 1},
        {"quality": "480p",  "width": 854,  "height": 480,  "bitrate_kbps": 1200,  "priority": 2},
        {"quality": "720p",  "width": 1280, "height": 720,  "bitrate_kbps": 2500,  "priority": 2},
        {"quality": "1080p", "width": 1920, "height": 1080, "bitrate_kbps": 5000,  "priority": 3},
        {"quality": "4k",    "width": 3840, "height": 2160, "bitrate_kbps": 20000, "priority": 4},
    ]
    
    async def process_video(self, video_id: str, raw_s3_key: str) -> None:
        # Step 1: Validate (format check, not malware)
        await self._validate_video(raw_s3_key)
        
        # Step 2: Safety scan (CSAM hash check + violence/CSAM ML classifier)
        scan_result = await self.safety_service.scan(raw_s3_key)
        if scan_result.is_violating:
            await self.db.update_video_status(video_id, "REMOVED")
            return
        
        # Step 3: Extract metadata
        metadata = await self._extract_metadata(raw_s3_key)
        await self.db.update_video_metadata(video_id, metadata)
        
        # Step 4: Generate thumbnail candidates (every 10 seconds)
        await self._generate_thumbnails(raw_s3_key, video_id, metadata["duration_secs"])
        
        # Step 5: Enqueue transcode jobs (priority-ordered, low quality first)
        for config in sorted(self.QUALITY_CONFIGS, key=lambda x: x["priority"]):
            await self.transcode_queue.enqueue({
                "video_id": video_id,
                "raw_s3_key": raw_s3_key,
                **config
            }, priority=config["priority"])
    
    async def transcode_worker(self, job: dict) -> None:
        """
        Runs on a GPU/CPU worker instance.
        FFmpeg command generates HLS-segmented output.
        """
        video_id = job["video_id"]
        quality = job["quality"]
        
        output_dir = f"s3://yt-processed/{video_id}/{quality}/"
        
        # FFmpeg command: transcode + segment into 6-second HLS chunks
        ffmpeg_cmd = [
            "ffmpeg",
            "-i", f"s3://{job['raw_s3_key']}",   # Input from S3
            "-c:v", "libx264",
            "-crf", "23",
            "-preset", "medium",                   # Speed/quality tradeoff
            "-vf", f"scale={job['width']}:{job['height']}",
            "-b:v", f"{job['bitrate_kbps']}k",
            "-c:a", "aac",
            "-b:a", "128k",
            "-hls_time", "6",                      # 6-second segments
            "-hls_playlist_type", "vod",
            "-hls_segment_filename", f"{output_dir}segment_%03d.ts",
            f"{output_dir}playlist.m3u8"
        ]
        
        process = await asyncio.create_subprocess_exec(*ffmpeg_cmd)
        await process.wait()
        
        if process.returncode != 0:
            raise TranscodeError(f"FFmpeg failed for {video_id}/{quality}")
        
        # Save CDN URL to DB
        cdn_url = f"https://cdn.youtube.com/v/{video_id}/{quality}/playlist.m3u8"
        await self.db.save_video_asset({
            "video_id": video_id,
            "quality": quality,
            "manifest_url": cdn_url,
            "bitrate_kbps": job["bitrate_kbps"],
            "width_px": job["width"],
            "height_px": job["height"],
        })
        
        # If lowest quality just finished: mark video as watchable (even if 1080p still processing)
        if quality == "360p":
            await self.db.update_video_status(video_id, "READY")
            await self.event_bus.publish("VIDEO_READY", {"video_id": video_id})
```

---

## 8) Adaptive Bitrate Streaming (ABR)

```text
Problem: User has variable network speed.
- Home WiFi: 50 Mbps   -> 1080p or 4K
- Mobile 4G: 5 Mbps    -> 720p
- Mobile 3G: 1 Mbps    -> 360p
- Elevator:  0.3 Mbps  -> 144p or stall

Solution: HLS (HTTP Live Streaming) and DASH (Dynamic Adaptive Streaming over HTTP)
- Video split into short segments (6 seconds each)
- Master playlist lists all available quality tiers
- Client player monitors download speed
- If download speed drops: switch to lower quality playlist
- If download speed increases: switch to higher quality
- Switching happens at segment boundaries (seamless)
```

```python
class ABRController:
    """
    Client-side Adaptive Bitrate controller (simplified).
    Runs in JavaScript in browser (or native media player SDK).
    """
    
    QUALITY_TIERS = [
        {"quality": "144p",  "bitrate_kbps": 100},
        {"quality": "360p",  "bitrate_kbps": 400},
        {"quality": "480p",  "bitrate_kbps": 700},
        {"quality": "720p",  "bitrate_kbps": 1500},
        {"quality": "1080p", "bitrate_kbps": 3000},
        {"quality": "4k",    "bitrate_kbps": 12000},
    ]
    
    SEGMENT_DURATION_S = 6
    BUFFER_TARGET_S = 30     # Keep 30 seconds buffered
    BUFFER_MINIMUM_S = 10    # Emergency: if below 10s, drop quality immediately
    
    def __init__(self):
        self.current_quality_idx = 2   # Start at 480p
        self.bandwidth_history = []    # Last N segment download speeds
    
    def on_segment_downloaded(self, size_bytes: int, download_time_ms: float) -> None:
        """Called after each 6-second segment is downloaded."""
        bw_kbps = (size_bytes * 8) / download_time_ms  # kbps
        self.bandwidth_history.append(bw_kbps)
        if len(self.bandwidth_history) > 5:
            self.bandwidth_history.pop(0)
    
    def select_next_quality(self, buffer_seconds: float) -> str:
        """Select quality for next segment download."""
        if not self.bandwidth_history:
            return self.QUALITY_TIERS[self.current_quality_idx]["quality"]
        
        # Use conservative (20th percentile) bandwidth estimate
        sorted_bw = sorted(self.bandwidth_history)
        safe_bw_kbps = sorted_bw[len(sorted_bw) // 5]  # 20th percentile
        
        # Emergency: buffer critically low -> drop quality now
        if buffer_seconds < self.BUFFER_MINIMUM_S:
            self.current_quality_idx = max(0, self.current_quality_idx - 2)
            return self.QUALITY_TIERS[self.current_quality_idx]["quality"]
        
        # Find highest quality we can sustain (with 20% safety margin)
        for i in range(len(self.QUALITY_TIERS) - 1, -1, -1):
            required_bw = self.QUALITY_TIERS[i]["bitrate_kbps"] * 1.2
            if safe_bw_kbps >= required_bw:
                # Only upgrade one tier at a time (avoid oscillation)
                new_idx = min(i, self.current_quality_idx + 1)
                self.current_quality_idx = new_idx
                return self.QUALITY_TIERS[new_idx]["quality"]
        
        # Can't sustain even lowest quality
        self.current_quality_idx = 0
        return self.QUALITY_TIERS[0]["quality"]
```

---

## 9) High-Level Design (HLD)

```text
Mobile/Web Client
    |
    v
[Global CDN] <-----------------------------------------+
    |                                                   |
    | Cache Miss only                                   |
    v                                                   |
[API Gateway]          <- Auth, rate limiting           |
    |                                                   |
    +------------------+------------------+             |
    |                  |                  |             |
    v                  v                  v             |
[Upload Service]  [Video Service]  [Search Service]    |
    |                  |                  |             |
    v                  v                  v             |
[Raw Object    ] [Video DB      ] [Elasticsearch]      |
[Store (S3)   ] [Watch History ] [Video Index  ]      |
                [Analytics DB  ]                       |
    |                                                   |
    v                                                   |
[Transcode Queue] -> [Transcode Workers (GPU fleet)] -> |
                                                  Processed segments -> CDN
[Recommendation Engine]
    -> Feature Store (user watch history, likes)
    -> Candidate Generation (collaborative filtering)
    -> Ranking Model (neural network)
    -> Recommendation Cache
```

---

## 10) View Count and Analytics

```python
class ViewCountService:
    """
    Counting 1B views/day with accuracy guarantees.
    
    Problem: Naive approach (UPDATE views = views + 1 per view)
    = 11,574 DB writes/second just for view counts!
    = DB becomes bottleneck
    
    Solution: Buffer in Redis, flush to DB in batches
    """
    
    async def record_view(self, video_id: str, user_id: str) -> None:
        # Dedup: don't count multiple views from same user in 24h window
        view_key = f"viewed:{video_id}:{user_id}"
        if await self.redis.get(view_key):
            return  # Already counted today
        
        # Mark as viewed for dedup (24h TTL)
        await self.redis.setex(view_key, 86400, "1")
        
        # Increment counter in Redis (atomic INCR, no locking needed)
        await self.redis.incr(f"view_count_buffer:{video_id}")
    
    async def flush_view_counts(self) -> None:
        """
        Runs every 60 seconds.
        Flushes buffered view counts to persistent DB.
        """
        # Scan for all buffered view count keys
        buffered_keys = await self.redis.scan_match("view_count_buffer:*")
        
        pipe = self.redis.pipeline()
        for key in buffered_keys:
            pipe.getdel(key)  # Atomic get-and-delete
        counts = await pipe.execute()
        
        # Batch update to DB
        updates = [
            {"video_id": key.split(":")[1], "views_to_add": int(count)}
            for key, count in zip(buffered_keys, counts)
            if count and int(count) > 0
        ]
        
        if updates:
            await self.db.batch_increment_views(updates)

class VideoAnalytics:
    """
    Creator analytics: views, watch time, click-through rate, demographics.
    Uses Kafka -> real-time aggregation -> analytics DB (ClickHouse/BigQuery).
    """
    
    async def record_watch_event(self, event: dict) -> None:
        """
        Events: VIEW_START, VIEW_PAUSE, VIEW_RESUME, VIEW_END, VIEW_SEEK
        Written to Kafka; consumed by analytics pipeline.
        """
        await self.kafka.produce("watch-events", {
            "video_id": event["video_id"],
            "user_id": event["user_id"],
            "event_type": event["type"],
            "watch_position_ms": event["position_ms"],
            "quality": event["quality"],
            "timestamp": event["timestamp"],
            "country": event["country"],
            "device_type": event["device"],
        })
    
    async def get_creator_analytics(self, channel_id: str, start_date: str, end_date: str) -> dict:
        """Query ClickHouse (OLAP) for creator dashboard."""
        result = await self.clickhouse.query("""
            SELECT
                toDate(timestamp) AS date,
                COUNT(DISTINCT user_id) AS unique_viewers,
                COUNT(*) AS total_views,
                AVG(watch_duration_secs) AS avg_watch_time_secs,
                SUM(watch_duration_secs) / 3600 AS total_watch_hours
            FROM watch_events
            WHERE video_id IN (
                SELECT id FROM videos WHERE owner_id = {channel_id}
            )
            AND timestamp BETWEEN {start_date} AND {end_date}
            AND event_type = 'VIEW_END'
            GROUP BY date
            ORDER BY date
        """, {"channel_id": channel_id, "start_date": start_date, "end_date": end_date})
        
        return result
```

---

## 11) Recommendations

```text
70% of YouTube watch time comes from recommendations.
This is a multi-stage ML pipeline:

Stage 1: Candidate Generation (~1M videos -> ~1000 candidates)
  - User watch history (collaborative filtering)
  - Similar videos to current (content-based: embedding similarity)
  - Trending in user's region/category

Stage 2: Ranking (~1000 candidates -> top 20 for display)
  - Two-tower neural network
  - Features: watch time, skip rate, like rate for similar users, freshness
  - Optimized for: expected watch time (not just click-through rate)

Stage 3: Post-processing
  - Dedup (no showing same channel twice in a row)
  - Diversity (mix topics)
  - Filters (blocked content, already watched > 90%)
  - Boost (new content from subscribed channels)
```

---

## 12) Interview Strategy

### Opening framing
```text
"YouTube's three core technical challenges are: 
1) Multi-resolution transcoding pipeline at 500 hours of upload per minute,
2) Global video delivery at 1B hours watched per day (CDN is the business),
3) Adaptive bitrate streaming for variable-bandwidth clients.

My design separates the upload/transcode path from the read/stream path, 
uses HLS for adaptive streaming, and CDN for 95% of read traffic."
```

### Key decision points
```text
1. Why HLS/DASH instead of progressive download?
   - Progressive download: downloads whole file, no quality switching, wastes bandwidth
   - HLS: 6-second segments, client can switch quality per-segment, no wasted bytes
   - HLS also enables DVR-style rewind for live streams

2. Why process lower quality first?
   - 360p finishes in 1-2 min; 1080p may take 10-15 min
   - Better to make video visible in low quality than wait for all qualities
   - Users expecting "instant" availability

3. Why not store raw uploaded video?
   - H.264 (standard) compression: 100MB raw -> 5MB compressed
   - Multiple resolutions = more storage, but saves CDN egress (serve only what needed)
   - Cost tradeoff: storage is cheaper than bandwidth

4. Why separate analytics from OLTP database?
   - 1B watch events per day cannot go into Postgres
   - ClickHouse/BigQuery optimized for aggregation queries (OLAP)
   - Analytics queries are slow, complex, and should not compete with OLTP reads
```

### Common follow-ups
```text
Q: How do you prevent hot videos from overwhelming origin servers?
A: CDN caches 95% of reads. For a viral video getting 10M concurrent viewers:
   - CDN edge nodes cache all segments (6-second chunks)
   - Only first few requests hit origin; rest served from edge
   - Add CDN "coalescing": if 1000 requests hit edge simultaneously for same segment,
     make ONE request to origin (fold cache misses)

Q: How does live streaming work differently?
A: Same HLS protocol but "live" mode:
   - Encoder sends 2-second segments in real time (instead of 6)
   - No pre-transcoding: transcode must keep up with live pace
   - Playlist only shows last 3-5 segments (no random seeking)
   - Chat: separate WebSocket-based system (Pub/Sub per stream)
   - DVR: store last 2 hours in sliding window on CDN

Q: How do you handle copyright detection (Content ID)?
A: YouTube's Content ID system:
   - Rights holders upload "reference" audio/video fingerprints
   - Every uploaded video: audio + video fingerprinting within minutes
   - Match against reference database (approximate nearest neighbor search)
   - On match: apply rights holder's policy (monetize/block/track)
```

---

## 13) SLOs and Key Metrics

```python
slos = {
    "video_start_latency_p95": "< 2 seconds",
    "video_upload_processing_p95": "< 30 minutes",
    "360p_available_after_upload_p95": "< 3 minutes",
    "search_result_latency_p95": "< 300ms",
    "cdn_hit_rate": "> 95%",
    "streaming_rebuffer_rate": "< 1%",  # Time spent buffering / total watch time
}

key_alerts = [
    "transcode_queue_depth > 100K",        # Upload workers falling behind
    "cdn_miss_rate > 10%",                 # CDN not effective
    "streaming_error_rate > 0.1%",         # HLS serving broken
    "view_count_flush_lag > 5 minutes",    # Analytics falling behind
    "recommendation_latency > 500ms",       # Rec engine slow
]
```
