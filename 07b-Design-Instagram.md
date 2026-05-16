# Design Instagram (Comprehensive)

## 1) Intuition
Instagram's hardest problems are:
1. **Media pipeline:** Photos/videos must be ingested, transcoded into multiple resolutions, and served globally via CDN — all within seconds of upload.
2. **Ranked feed:** Unlike Twitter's chronological timeline, Instagram's feed is ML-ranked. This requires candidate generation + feature extraction + scoring all in < 200ms.
3. **Fanout under celebrity skew:** Same hybrid fanout problem as Twitter, with the added dimension that Instagram feed skips stale content aggressively via ranking.

Real-world analogy: Instagram is like a news stand that:
- Accepts photos from millions of contributors (media ingest)
- Prints personalized editions for each reader (ranked feed)
- Distributes physical copies globally in seconds (CDN)
- Highlights stories that expire in 24 hours (Stories)

---

## 2) Functional Requirements
- Upload photo (up to 20MB) and video (up to 100MB, Reels up to 90s)
- View home feed (ranked, personalized)
- View user profile and grid
- Stories (24h expiry)
- Like, comment, save, share
- Follow/unfollow users
- DMs (direct messages - separate from WhatsApp now but originally built in)
- Explore page (content discovery beyond follow graph)

---

## 3) Non-Functional Requirements
- **Availability:** 99.99%
- **Upload latency:** File processed and visible within 60 seconds of upload
- **Feed latency:** P95 < 500ms (including ranking)
- **Media serving:** Sub-100ms globally via CDN
- **Scale:** 500M DAU, 100M posts/day, 4B feed views/day

---

## 4) Capacity Estimation
```python
instagram_capacity = {
    "DAU": 500_000_000,
    
    # Uploads
    "posts_per_day": 100_000_000,       # 100M photos+videos/day
    "posts_per_second_avg": 1_157,
    "posts_per_second_peak": 3_500,     # 3x peak
    
    # Media storage
    "avg_photo_size_mb": 3.0,           # Original
    "avg_photo_after_compress_mb": 0.5, # After JPEG compression
    "versions_per_photo": 5,            # Thumbnail, low, medium, high, original
    "total_storage_per_photo_mb": 0.5 * 5,  # 2.5 MB across all versions
    "storage_per_day_tb": (100_000_000 * 2.5) / (1024**2),  # ~238 TB/day
    "storage_per_year_pb": (238 * 365) / 1024,              # ~84 PB/year
    
    # Reads
    "feed_views_per_day": 4_000_000_000,
    "feed_views_per_second_avg": 46_296,
    "feed_views_per_second_peak": 138_889,  # 3x
    
    # CDN egress
    "avg_feed_images_served": 20,   # Images per feed load
    "avg_image_served_kb": 200,     # Compressed thumbnail
    "egress_gbps_peak": 138_889 * 20 * 200 / (1024**2) * 8,  # ~420 Gbps peak
}
```

---

## 5) API Design

### Upload API (chunked, resumable)
```
# Step 1: Initialize upload session
POST /v1/media/upload/initialize
Content-Type: application/json
Authorization: Bearer {token}

Request:
{
    "media_type": "IMAGE",    // or "VIDEO", "REEL"
    "size_bytes": 3145728,    // 3 MB
    "mime_type": "image/jpeg"
}

Response:
{
    "upload_session_id": "upload_abc123",
    "upload_url": "https://upload.instagram.com/upload_abc123",
    "expires_at": "2024-01-15T11:00:00Z",
    "chunk_size_bytes": 1048576  // 1 MB per chunk
}

# Step 2: Upload chunks
PUT /v1/media/upload/{session_id}/chunks/{chunk_number}
Content-Type: application/octet-stream
Content-Length: 1048576

[raw chunk bytes]

Response:
{
    "chunk_number": 1,
    "received_bytes": 1048576,
    "checksum": "sha256:abc..."
}

# Step 3: Finalize upload (triggers processing pipeline)
POST /v1/media/upload/{session_id}/finalize
{
    "caption": "Sunset at Marina Beach #sunset",
    "location": { "lat": 13.0499, "lng": 80.2999 },
    "hashtags": ["sunset", "beach"],
    "tagged_users": ["user_123"],
    "hide_like_count": false
}

Response 202 Accepted:
{
    "post_id": "post_xyz789",
    "status": "PROCESSING",    // Will become "PUBLISHED" within 60 seconds
    "check_status_url": "/v1/posts/post_xyz789/status"
}
```

### Feed API
```
GET /v1/feed?cursor=eyJhbGciOiJIUzI1NiJ9...&limit=12
Authorization: Bearer {token}

Response:
{
    "data": [
        {
            "id": "post_xyz789",
            "type": "IMAGE",
            "author": {
                "id": "user_456",
                "username": "alice",
                "profile_pic_url": "https://cdn.instagram.com/pics/user_456_150x150.jpg"
            },
            "images": {
                "thumbnail": { "url": "...", "width": 150, "height": 150 },
                "low_res":   { "url": "...", "width": 640, "height": 640 },
                "high_res":  { "url": "...", "width": 1080, "height": 1080 }
            },
            "caption": "Sunset at Marina Beach",
            "like_count": 1243,
            "comment_count": 47,
            "timestamp": "2024-01-15T10:30:00Z",
            "ranking_score": 0.87    // Internal, not exposed to clients
        }
    ],
    "pagination": {
        "next_cursor": "eyJzY29yZSI6MC44N30=",
        "has_more": true
    }
}
```

---

## 6) Data Model

```sql
-- Users
CREATE TABLE users (
    id           BIGINT PRIMARY KEY,    -- Snowflake ID
    username     VARCHAR(30) UNIQUE NOT NULL,
    email        VARCHAR(255) UNIQUE NOT NULL,
    bio          VARCHAR(150),
    profile_pic  VARCHAR(500),          -- CDN URL
    is_verified  BOOLEAN DEFAULT FALSE,
    is_private   BOOLEAN DEFAULT FALSE,
    follower_count  INTEGER DEFAULT 0,
    following_count INTEGER DEFAULT 0,
    post_count   INTEGER DEFAULT 0,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Posts
CREATE TABLE posts (
    id           BIGINT PRIMARY KEY,    -- Snowflake ID
    author_id    BIGINT NOT NULL,
    type         VARCHAR(10) NOT NULL,  -- 'IMAGE', 'VIDEO', 'CAROUSEL', 'REEL'
    caption      TEXT,
    location_lat DECIMAL(9,6),
    location_lng DECIMAL(9,6),
    status       VARCHAR(10) DEFAULT 'PROCESSING',  -- 'PROCESSING', 'PUBLISHED', 'DELETED'
    like_count   INTEGER DEFAULT 0,    -- Denormalized counter (eventual consistency)
    comment_count INTEGER DEFAULT 0,
    view_count   BIGINT DEFAULT 0,
    created_at   TIMESTAMP NOT NULL,
    CONSTRAINT fk_author FOREIGN KEY(author_id) REFERENCES users(id)
);
CREATE INDEX idx_posts_author ON posts(author_id, created_at DESC);
CREATE INDEX idx_posts_status ON posts(status, created_at DESC);

-- Media assets (multiple resolutions per post)
CREATE TABLE media_assets (
    id           BIGINT PRIMARY KEY,
    post_id      BIGINT NOT NULL,
    version      VARCHAR(20) NOT NULL,  -- 'thumbnail', 'low', 'medium', 'high', 'original'
    url          VARCHAR(500) NOT NULL, -- CDN URL (content-addressable)
    width_px     INTEGER,
    height_px    INTEGER,
    size_bytes   BIGINT,
    duration_ms  INTEGER,               -- NULL for images
    CONSTRAINT fk_post FOREIGN KEY(post_id) REFERENCES posts(id)
);

-- Stories (TTL: 24 hours)
CREATE TABLE stories (
    id           BIGINT PRIMARY KEY,
    author_id    BIGINT NOT NULL,
    media_url    VARCHAR(500) NOT NULL,
    created_at   TIMESTAMP NOT NULL,
    expires_at   TIMESTAMP NOT NULL,   -- created_at + 24h
    view_count   INTEGER DEFAULT 0
);
CREATE INDEX idx_stories_author_expires ON stories(author_id, expires_at);

-- Follow graph (sharded by follower_id)
CREATE TABLE follows (
    follower_id  BIGINT NOT NULL,
    followee_id  BIGINT NOT NULL,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX idx_follows_followee ON follows(followee_id, created_at DESC);

-- Likes (high write volume - use Cassandra or ScyllaDB instead)
-- Schema shown here for clarity
CREATE TABLE likes (
    post_id      BIGINT NOT NULL,
    user_id      BIGINT NOT NULL,
    created_at   TIMESTAMP NOT NULL,
    PRIMARY KEY (post_id, user_id)
);
```

---

## 7) High-Level Design (HLD)

```text
Client (iOS/Android/Web)
    |
    v
[Global CDN]                        <- TLS offload, WAF, static media serving
    |
    v
[API Gateway / GraphQL]             <- Auth (JWT), rate limiting, routing
    |
    +---------------------+--------------------+
    |                     |                    |
    v                     v                    v
[Upload Service]    [Feed Service]    [Social Graph Service]
    |                     |                    |
    v                     v                    v
[Media Ingest]      [Feed Cache]       [Follow DB]
[Transcode Workers] [Ranking Service]  [Graph Cache]
[Object Store (S3)] [Candidate Gen]    
    |                     
    v                     
[CDN (CloudFront)]  <- All media reads go here (not directly to S3)

Background systems:
[Kafka Event Bus]
    -> Feed Fanout Workers
    -> Notification Workers
    -> Search Indexer
    -> Analytics Pipeline
    -> Content Moderation
```

---

## 8) Media Upload Pipeline

```python
class MediaUploadPipeline:
    """
    After finalizing upload, this pipeline processes the raw media.
    Runs asynchronously - client polls or receives push notification.
    
    Timeline:
    - 0ms:   Upload finalized, job enqueued
    - 2s:    Validation complete
    - 10s:   All image versions generated
    - 30s:   Video transcoding complete (for short clips)
    - 60s:   Post status = PUBLISHED
    """
    
    async def process_upload(self, job: UploadJob) -> None:
        post_id = job.post_id
        raw_s3_key = job.raw_s3_key
        
        # Step 1: Validate (2 seconds)
        await self._validate_media(raw_s3_key, job.declared_mime_type)
        
        # Step 2: Safety scan (AI/hash-based CSAM check, 5 seconds)
        result = await self.safety_scanner.scan(raw_s3_key)
        if result.is_violating:
            await self.db.update_post_status(post_id, "REMOVED")
            await self.notify_author(job.author_id, "POST_REMOVED", post_id)
            return
        
        # Step 3: Generate multiple versions in parallel
        if job.media_type == "IMAGE":
            await asyncio.gather(
                self._generate_image_version(raw_s3_key, post_id, "thumbnail", 150, 150),
                self._generate_image_version(raw_s3_key, post_id, "low_res", 640, 640),
                self._generate_image_version(raw_s3_key, post_id, "high_res", 1080, 1080),
            )
        elif job.media_type in ("VIDEO", "REEL"):
            await asyncio.gather(
                self._generate_thumbnail(raw_s3_key, post_id),
                self._transcode_video(raw_s3_key, post_id, quality="360p"),
                self._transcode_video(raw_s3_key, post_id, quality="720p"),
                self._transcode_video(raw_s3_key, post_id, quality="1080p"),
            )
        
        # Step 4: Extract metadata (geolocation, faces, objects for tagging)
        metadata = await self.ml_vision.analyze(raw_s3_key)
        await self.db.update_post_metadata(post_id, metadata)
        
        # Step 5: Mark as published
        await self.db.update_post_status(post_id, "PUBLISHED")
        
        # Step 6: Publish event for fanout and indexing
        await self.event_bus.publish("POST_PUBLISHED", {
            "post_id": post_id,
            "author_id": job.author_id,
            "media_type": job.media_type,
            "published_at": datetime.utcnow().isoformat()
        })
    
    async def _generate_image_version(
        self, s3_key: str, post_id: str, version: str, width: int, height: int
    ) -> None:
        # Fetch from S3, resize with Pillow (LANCZOS), compress JPEG quality 85
        raw_bytes = await s3.get(s3_key)
        
        img = Image.open(io.BytesIO(raw_bytes))
        img.thumbnail((width, height), Image.Resampling.LANCZOS)
        
        # Apply orientation from EXIF
        img = ImageOps.exif_transpose(img)
        
        # Convert to RGB (handles RGBA PNG)
        if img.mode != "RGB":
            img = img.convert("RGB")
        
        # Compress
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85, optimize=True, progressive=True)
        buf.seek(0)
        
        # Upload to S3 with content-addressable key
        content_hash = hashlib.sha256(buf.read()).hexdigest()[:16]
        cdn_key = f"posts/{post_id}/{version}_{content_hash}.jpg"
        buf.seek(0)
        
        await s3.put(
            cdn_key, buf.read(),
            content_type="image/jpeg",
            cache_control="public, max-age=31536000, immutable"  # 1 year
        )
        
        cdn_url = f"https://cdn.instagram.com/{cdn_key}"
        
        await self.db.insert_media_asset({
            "post_id": post_id,
            "version": version,
            "url": cdn_url,
            "width_px": img.width,
            "height_px": img.height,
            "size_bytes": buf.getbuffer().nbytes
        })
```

---

## 9) Feed Service (Ranked)

### Feed architecture
```text
Unlike Twitter, Instagram feed is ML-ranked (not chronological).

Two-phase architecture:
Phase 1 - Candidate Generation (retrieve N candidates, N = 500)
  Sources:
  - Followed accounts' recent posts (fanout-written, from timeline store)
  - Followed hashtags' recent posts
  - Posts saved/liked by people you follow (social proof)
  - Explore-like posts (if feed is sparse)

Phase 2 - Ranking (score each candidate, keep top 20 per page)
  Features:
  - Content features: image type, video length, aspect ratio
  - Author features: your historical engagement with this author
  - Post features: engagement velocity (likes in first 10 min), time since post
  - User features: time of day, device type, session context
  - Relationship features: DM'd this person, commented before, location overlap
  
  Model: 2-stage ranker
  - Pass 1: Lightweight logistic regression (500 -> 100 candidates, < 10ms)
  - Pass 2: Neural network ranker (100 -> 20 for display, < 50ms)
```

```python
class FeedService:
    CANDIDATES_TO_GENERATE = 500
    PASS1_CANDIDATES = 100
    FEED_PAGE_SIZE = 20
    
    async def get_feed(self, user_id: str, cursor: str = None, limit: int = 20) -> dict:
        # Step 1: Get pre-computed candidates from cache
        cached_feed = await self.feed_cache.get(user_id, cursor)
        if cached_feed:
            return cached_feed
        
        # Step 2: Candidate generation (from multiple sources)
        candidates = await self._generate_candidates(user_id)
        
        # Step 3: Two-pass ranking
        pass1 = await self._rank_pass1(candidates, user_id)  # Cheap features, < 10ms
        pass2 = await self._rank_pass2(pass1[:self.PASS1_CANDIDATES], user_id)  # Deep features, < 50ms
        
        # Step 4: Post-processing (dedup authors, apply diversity)
        final_feed = self._diversify(pass2[:self.FEED_PAGE_SIZE * 2])[:self.FEED_PAGE_SIZE]
        
        # Step 5: Cache ranked feed (short TTL since it's personalized)
        await self.feed_cache.set(user_id, final_feed, ttl=60)  # 1 min TTL
        
        return {
            "data": final_feed,
            "pagination": {
                "next_cursor": self._encode_cursor(final_feed[-1]),
                "has_more": True
            }
        }
    
    async def _generate_candidates(self, user_id: str) -> list:
        """
        Gather posts from multiple sources in parallel.
        """
        results = await asyncio.gather(
            # Timeline store: fanout-written posts from followed users
            self.timeline_store.get(user_id, limit=200),
            # Celebrity posts (fanout-on-read for high-follower accounts)
            self._get_celebrity_posts(user_id, limit=50),
            # Followed hashtags
            self._get_hashtag_posts(user_id, limit=50),
            # Explore candidates (if user has enough following history)
            self._get_explore_candidates(user_id, limit=50),
        )
        
        # Flatten and deduplicate
        seen = set()
        candidates = []
        for source_results in results:
            for post in source_results:
                if post["id"] not in seen:
                    seen.add(post["id"])
                    candidates.append(post)
        
        return candidates[:self.CANDIDATES_TO_GENERATE]
    
    def _diversify(self, ranked_posts: list) -> list:
        """
        Prevent feed from showing 5 consecutive posts from same author.
        Simple diversity re-ranking.
        """
        result = []
        author_counts = {}
        remaining = list(ranked_posts)
        
        while remaining and len(result) < self.FEED_PAGE_SIZE:
            for i, post in enumerate(remaining):
                author_id = post["author_id"]
                if author_counts.get(author_id, 0) < 2:  # Max 2 consecutive per author
                    result.append(post)
                    author_counts[author_id] = author_counts.get(author_id, 0) + 1
                    remaining.pop(i)
                    break
        
        return result
```

### Feed fanout (same hybrid strategy as Twitter)
```python
class InstagramFanoutWorker:
    """
    When a user publishes a post:
    - Regular users (< 100K followers): write to all follower timelines
    - Popular users (100K-1M followers): batch fanout with priority queue
    - Celebrities (> 1M followers): no fanout, lazy merge at read time
    """
    
    CELEBRITY_THRESHOLD = 1_000_000
    POPULAR_THRESHOLD = 100_000
    
    async def handle_post_published(self, event: dict):
        author_id = event["author_id"]
        post_id = event["post_id"]
        timestamp = event["published_at_ts"]
        
        follower_count = await self.user_service.get_follower_count(author_id)
        
        if follower_count >= self.CELEBRITY_THRESHOLD:
            # No fanout: too expensive. Merge at read time.
            await self.celebrity_post_store.save(author_id, post_id, timestamp)
        
        elif follower_count >= self.POPULAR_THRESHOLD:
            # Enqueue large fanout with lower priority (may take minutes)
            await self.fanout_queue.enqueue_priority(
                "LARGE_FANOUT",
                {"author_id": author_id, "post_id": post_id, "timestamp": timestamp},
                priority="LOW"
            )
        
        else:
            # Small fanout: do it immediately
            await self._write_to_timelines(author_id, post_id, timestamp)
    
    async def _write_to_timelines(self, author_id: str, post_id: str, timestamp: float):
        cursor = None
        while True:
            followers, cursor = await self.follow_db.get_followers(author_id, cursor, limit=5000)
            if not followers:
                break
            
            pipe = self.redis.pipeline()
            for follower_id in followers:
                pipe.zadd(f"timeline:{follower_id}", {post_id: timestamp})
                pipe.zremrangebyrank(f"timeline:{follower_id}", 0, -1001)  # Keep 1000
            await pipe.execute()
```

---

## 10) Stories Architecture

```python
class StoriesService:
    """
    Stories expire 24h after posting.
    Optimized for sequential viewing (ring UI).
    """
    
    STORY_TTL_SECONDS = 86400  # 24 hours
    
    async def post_story(self, author_id: str, media_url: str) -> dict:
        story = {
            "id": snowflake.next_id(),
            "author_id": author_id,
            "media_url": media_url,
            "created_at": now,
            "expires_at": now + timedelta(hours=24)
        }
        
        # Save to DB
        await self.db.insert_story(story)
        
        # Add to author's story ring in Redis (sorted by timestamp)
        await self.redis.zadd(
            f"stories:{author_id}",
            {story["id"]: story["expires_at"].timestamp()}
        )
        await self.redis.expireat(f"stories:{author_id}", story["expires_at"])
        
        return story
    
    async def get_stories_for_feed(self, user_id: str) -> list:
        """
        Get story rings for all followed users who have active stories.
        Ordered by: unseen first, then most recent activity.
        """
        # Get followed users with active stories
        followees = await self.follow_db.get_following(user_id)
        
        # Batch check who has active stories
        pipe = self.redis.pipeline()
        for followee_id in followees:
            pipe.zcard(f"stories:{followee_id}")  # Count = 0 means no stories
        
        counts = await pipe.execute()
        
        active_story_users = [
            followee_id
            for followee_id, count in zip(followees, counts)
            if count > 0
        ]
        
        # Fetch seen status for each
        seen_stories = await self.seen_store.get_seen(user_id)
        
        result = []
        for author_id in active_story_users:
            story_ids = await self.redis.zrange(f"stories:{author_id}", 0, -1)
            unseen_count = len([s for s in story_ids if s not in seen_stories])
            
            result.append({
                "author_id": author_id,
                "story_count": len(story_ids),
                "has_unseen": unseen_count > 0,
                "latest_story_at": await self.redis.zscore(f"stories:{author_id}", story_ids[-1])
            })
        
        # Sort: unseen first (most recent), then seen (most recent)
        result.sort(key=lambda x: (0 if x["has_unseen"] else 1, -x["latest_story_at"]))
        
        return result
```

---

## 11) Content Moderation

```text
Three-stage pipeline (must be fast to avoid delay in post visibility):

Stage 1 - Pre-upload (during chunked upload)
  - Perceptual hash (pHash) check against CSAM database: < 1ms
  - Known spam URL database check: < 1ms
  
Stage 2 - Sync check (during finalize, blocks publishing for < 5s)
  - Exact hash match against known violating content
  - Rule-based caption filter (prohibited words/phrases)
  Result: 99% of posts clear this gate immediately

Stage 3 - Async ML scan (runs after publishing, can remove post retroactively)
  - NSFW classifier (nudity, violence, graphic content)
  - Hate speech NLP model (caption + OCR'd text in image)
  - Coordinated inauthentic behavior detection
  - Report queue from user reports
  Result: Post visible immediately, removed if ML flags (usually within 2 min)

Human review queue:
  - Edge cases from ML (low confidence score)
  - User appeals
  - High-profile accounts (extra scrutiny on reports)
```

---

## 12) CDN Strategy

```python
cdn_config = {
    # Immutable media (content-addressable URLs with hash)
    "images": {
        "url_pattern": "https://cdn.instagram.com/posts/{post_id}/{version}_{hash}.jpg",
        "cache_control": "public, max-age=31536000, immutable",  # 1 year
        "why": "URL contains content hash, so changing image = new URL = no stale cache"
    },
    
    # Profile pictures (change infrequently)
    "profile_pics": {
        "url_pattern": "https://cdn.instagram.com/profiles/{user_id}_150x150.jpg",
        "cache_control": "public, max-age=86400, stale-while-revalidate=3600",
        "why": "24h cache OK, user profile changes are infrequent"
    },
    
    # Stories media (24h expiry, but CDN caches for freshness)
    "stories": {
        "url_pattern": "https://cdn.instagram.com/stories/{story_id}.jpg",
        "cache_control": "public, max-age=3600",  # 1 hour (stories last 24h)
        "why": "Shorter TTL since story can be deleted any time"
    },
    
    # Video streaming (HLS adaptive bitrate)
    "videos": {
        "manifest_url": "https://cdn.instagram.com/videos/{post_id}/manifest.m3u8",
        "segments": "https://cdn.instagram.com/videos/{post_id}/{quality}_{seq}.ts",
        "cache_control": "public, max-age=3600",
        "why": "CDN caches video segments, client adapts quality to bandwidth"
    }
}
```

---

## 13) Interview Strategy

### Opening framing
```text
"Instagram combines three distinct systems: a media pipeline for uploads, 
a ranked feed service, and a social graph — each with different consistency 
and latency requirements. The hard problems are: multi-resolution media 
processing at 100M uploads/day, ML-ranked feed with sub-500ms latency, 
and fanout under celebrity skew."
```

### Key decisions to explain
```text
1. Why chunked upload with resumable sessions?
   - Large files on mobile networks: connection drops are common
   - Resume instead of restart saves bandwidth and user frustration

2. Why multiple image resolutions?
   - Thumbnails (150px): fast feed scroll
   - Low res (640px): when scrolling past quickly
   - High res (1080px): when tapping to view
   - Bandwidth savings: ~90% reduction vs serving original always

3. Why ranked feed (not chronological)?
   - At 100M posts/day, even 1000 followed users post 20 things/day each
   - User can't see all; must prioritize most relevant content
   - Instagram research: ranked feeds increase engagement 2-3x

4. Why hybrid fanout (same as Twitter)?
   - Celebrity with 100M followers posts 5 times/day = 500M fanout writes
   - At 10K writes/sec = 14 hours per celebrity per day!
   - Must use lazy merge at read time for celebrities

5. Why asynchronous media processing?
   - Transcoding 100MB video takes 30-60 seconds
   - Can't block HTTP response for this long
   - Instead: accept post, process async, push notification when ready

6. Stories TTL handling:
   - DB TTL (expires_at column + cron job cleanup)
   - Redis TTL (expireat on story ring key)
   - CDN TTL (shorter cache-control so expired stories don't linger)
```

### Common follow-ups
```text
Q: How do you handle simultaneous edits to like_count?
A: Cassandra counter columns or Redis INCR (atomic). Periodic reconciliation 
   against likes table for accuracy. Denormalized counters are eventually 
   consistent — that's OK for like counts.

Q: How does Explore work?
A: Collaborative filtering: "people with similar engagement history also liked X."
   Separate from home feed — Explore uses no follow graph, purely ML-driven 
   candidate generation from popular + interest-matched content.

Q: How do you handle a post going viral (1M likes in 1 hour)?
A: Like count is stored as Redis INCR (atomic, no contention). 
   Comment count is similar. Write throughput to Redis is ~1M writes/sec 
   on a single shard. Shard by post_id for very viral posts.
   Async propagation to DB (writes in batches of 1000 every second).

Q: How do you compute engagement velocity for ranking?
A: For each new post, track likes/comments in a 10-minute sliding window.
   Store: Redis sorted set keyed by (post_id, minute).
   Fanout worker updates post's velocity score.
   Velocity decays exponentially so old posts don't rank higher than new.
```

---

## 14) Failure Handling

```text
Failure              Impact                       Mitigation
Upload service down  Users can't post             Queue uploads locally, retry on reconnect
Transcode worker lag Posts stay in PROCESSING     Timeout + retry, SLO = 5 min max
CDN down             Images broken                Multi-CDN fallback (CloudFront + Fastly)
Feed service down    Feed doesn't load            Serve cached feed, show stale data
Ranking model down   Lower feed quality           Fallback to chronological feed
Fanout lag           Stale timelines              Author timeline as fallback
Like counter shard   Likes not updating           Circuit break to DB counter
Story TTL bug        Expired stories visible      Explicit expires_at check at read time
```

---

## 15) Metrics and SLOs

```python
slos = {
    "upload_success_rate":      "99.9%",
    "media_processing_p95":     "< 60 seconds",
    "feed_load_p95":            "< 500ms",
    "story_load_p95":           "< 200ms",
    "media_cdn_hit_rate":       "> 95%",
    "fanout_lag_p95":           "< 30 seconds",
}

key_alerts = [
    "fanout_queue_depth > 10M",         # Fanout falling behind
    "media_processing_queue_depth > 5K", # Upload workers overloaded
    "feed_cache_miss_rate > 20%",       # Cache not effective
    "cdn_origin_fallback_rate > 5%",    # CDN not serving from edge
    "story_expiry_cleanup_lag > 1hr",   # TTL cleanup failing
]
```
