# Design Netflix (Comprehensive)

## 1) Intuition
Netflix is primarily a **content delivery at scale** problem. Unlike YouTube (user-generated content), Netflix:
- Has a curated catalog (~17,000 titles)
- Knows exactly which content is popular in which region
- Can pre-position content at CDN edge nodes before users even request it (pre-caching)
- Has a massive ML recommendation engine driving 80% of what people watch

The hardest problems:
1. **Video streaming at Tbps scale:** At peak, Netflix uses ~35% of US internet bandwidth
2. **Content encoding pipeline:** Each movie encoded in 100+ variants (resolutions × encodings × audio tracks)
3. **Recommendation system:** 200M+ users, 17K titles, must be personalized in < 200ms

Real-world analogy: Netflix is like a chain of movie theaters that:
- Pre-stocks the local theater with copies of the most-popular movies for that neighborhood (Open Connect CDN)
- Has a personal movie concierge who knows your history and recommends what you'll like (recommendations)
- Shows the film at exactly the quality your projector and internet connection supports (adaptive streaming)

---

## 2) Functional Requirements
- Browse and search catalog (movies, series)
- Stream video with adaptive bitrate
- Personalized recommendations
- Continue watching (resume from last position)
- Multiple profiles per account
- Downloads for offline viewing
- Multiple regions (different catalogs per country due to licensing)

---

## 3) Non-Functional Requirements
- **Stream start latency:** < 2 seconds to first frame
- **Rebuffering rate:** < 0.5% of watch time
- **Availability:** 99.99%
- **Scale:** 250M subscribers, 100M daily active, 15 PB transferred daily
- **Catalog:** ~17,000 titles, each in 100+ variants

---

## 4) Capacity Estimation

```python
netflix_scale = {
    "subscribers": 250_000_000,
    "DAU": 100_000_000,
    
    # Viewing
    "avg_hours_watched_per_day_per_user": 2,
    "total_hours_watched_per_day": 100_000_000 * 2,   # 200M hours/day
    "total_seconds_per_day": 200_000_000 * 3600,
    
    # Bandwidth (the dominant cost)
    "avg_bitrate_mbps": {
        "mobile_low": 0.5,
        "HD_720p": 3.0,
        "Full_HD_1080p": 5.0,
        "4K_HDR": 15.0,
        "avg_across_all": 3.5,  # Most users: 1080p or lower
    },
    "peak_concurrent_viewers": 15_000_000,  # 8-11 PM local time
    "peak_bandwidth_tbps": 15_000_000 * 3.5 / (1024 * 1024),  # ~50 Tbps!
    
    # Netflix uses ~35% of US internet bandwidth at peak
    # This is why they built Open Connect (their own CDN)
    
    # Content storage
    "titles_in_catalog": 17_000,
    "variants_per_title": 100,  # 5 resolutions × 5 codecs × 4 audio = 100+
    "avg_variant_size_gb": 5,   # For 2-hour movie at 1080p
    "total_content_storage_pb": 17_000 * 100 * 5 / (1024**2),  # ~8 PB of content
    
    # But each CDN edge node caches subset of popular content
    # Worldwide: ~1000 ISP edge nodes (Open Connect Appliances)
    # Each node: ~100 TB of storage
    # Top 99% of views: served from edge (never hits Netflix origin)
}
```

---

## 5) Content Encoding Pipeline

```text
Raw studio file -> Netflix encoding pipeline -> 100+ variants -> Open Connect CDN

Raw file characteristics:
- 2-hour movie: 200+ GB uncompressed
- Multiple audio tracks (English, Spanish, French, Hindi...)
- Multiple subtitle tracks
- HDR10, Dolby Vision metadata

Netflix encoding process:
1. Shot-complexity analysis: identify scenes by visual complexity
2. Per-title encoding: optimize bitrate ladder per title
   - Action movie with fast motion: needs higher bitrate to avoid artifacts
   - Slow dialogue scene: can use lower bitrate with same quality
   
3. Generate all codec variants:
   - H.264 (AVC): widest device compatibility
   - H.265 (HEVC): 40% smaller than H.264 at same quality
   - AV1: 30% smaller than HEVC (used for 4K)
   - VP9: used on Android/Chrome
   
4. Package for streaming:
   - Segment into 4-second chunks (DASH/HLS)
   - Generate manifest files
   - Encrypt with Widevine/FairPlay DRM
```

```python
class ContentEncodingPipeline:
    RESOLUTION_TIERS = [
        {"name": "240p",  "width": 320,  "height": 240},
        {"name": "360p",  "width": 640,  "height": 360},
        {"name": "480p",  "width": 854,  "height": 480},
        {"name": "720p",  "width": 1280, "height": 720},
        {"name": "1080p", "width": 1920, "height": 1080},
        {"name": "4k",    "width": 3840, "height": 2160},
    ]
    
    CODECS = ["h264", "hevc", "av1"]
    
    async def encode_title(self, title_id: str, raw_file_s3_key: str) -> None:
        """
        Generates 100+ variants of a title.
        Runs as a distributed job across GPU farm.
        """
        # Step 1: Analyze shot complexity
        complexity_map = await self.analyze_shot_complexity(raw_file_s3_key)
        
        # Step 2: Generate per-title bitrate ladder
        bitrate_ladder = self.compute_bitrate_ladder(complexity_map)
        
        # Step 3: Encode all variants in parallel
        encoding_jobs = []
        for resolution in self.RESOLUTION_TIERS:
            for codec in self.CODECS:
                if self.should_encode(resolution, codec, title_id):
                    job = {
                        "title_id": title_id,
                        "raw_s3_key": raw_file_s3_key,
                        "resolution": resolution,
                        "codec": codec,
                        "bitrate_kbps": bitrate_ladder[resolution["name"]][codec],
                    }
                    encoding_jobs.append(self.encode_variant(job))
        
        # Run all encoding jobs in parallel (distributed across GPU workers)
        await asyncio.gather(*encoding_jobs)
        
        # Step 4: Package and push to CDN
        await self.package_and_distribute(title_id)
    
    def compute_bitrate_ladder(self, complexity_map: dict) -> dict:
        """
        Per-title bitrate optimization.
        A simple animated film needs much less bitrate than an action film.
        Netflix calls this "per-shot quality optimization."
        """
        avg_complexity = complexity_map["avg_complexity"]
        
        # Scale bitrates based on content complexity
        base_ladder = {
            "240p": {"h264": 200, "hevc": 120},
            "360p": {"h264": 500, "hevc": 300},
            "480p": {"h264": 1000, "hevc": 600},
            "720p": {"h264": 2500, "hevc": 1500},
            "1080p": {"h264": 5000, "hevc": 3000, "av1": 2000},
            "4k":   {"hevc": 15000, "av1": 8000},
        }
        
        # Adjust by complexity (high complexity = more motion/detail = needs more bits)
        scale = max(0.7, min(1.5, avg_complexity / 50))
        return {
            res: {codec: int(bps * scale) for codec, bps in codecs.items()}
            for res, codecs in base_ladder.items()
        }
```

---

## 6) Open Connect (Netflix's CDN)

```text
Netflix's most important infrastructure investment: their own CDN.

Before Open Connect (2012):
- Paid for Akamai/Limelight CDN (expensive)
- No control over cache placement
- No optimization for Netflix-specific access patterns

Open Connect (Netflix's own CDN):
- ~1000 ISP partner locations worldwide
- Netflix deploys physical appliances ("Open Connect Appliances") at ISPs
- Each appliance: 100TB-280TB of storage
- ISP benefits: traffic stays within their network (saves peering costs)
- Netflix benefits: ~99% of traffic served from edge (eliminates origin cost)

Pre-warming strategy:
- Every night (3 AM local time): push top 100 trending shows to local edge nodes
- Popular shows pre-positioned BEFORE users request them
- Cache miss rate: < 1% for current catalog
```

```python
class OpenConnectCacheManager:
    """
    Decides what content to pre-position on each edge appliance.
    Runs nightly as a background job.
    """
    
    async def compute_prefill_plan(self, region_id: str) -> dict:
        """
        For each edge appliance in a region, compute what to pre-cache.
        Based on: historical view counts, trending content, capacity.
        """
        # Get capacity of each appliance in region
        appliances = await self.topology.get_appliances(region_id)
        
        # Get trending content for this region (last 7 days)
        trending = await self.analytics.get_trending_content(
            region_id,
            days=7,
            limit=500
        )
        
        # Build prefill plan: fill appliance with highest-traffic content first
        plan = {}
        for appliance in appliances:
            available_gb = appliance["capacity_gb"] * 0.90  # Reserve 10% for overflow
            allocated_content = []
            allocated_gb = 0
            
            for title in trending:
                # Only prefill if content is licensed for this region
                if not await self.licensing.is_available(title["id"], region_id):
                    continue
                
                # Prefill most popular codec first (h264 for compatibility)
                size_gb = title["size_gb"]
                if allocated_gb + size_gb <= available_gb:
                    allocated_content.append(title["id"])
                    allocated_gb += size_gb
            
            plan[appliance["id"]] = {
                "content_to_cache": allocated_content,
                "estimated_bytes": allocated_gb * (1024**3),
                "estimated_hit_rate": self._estimate_hit_rate(allocated_content, trending)
            }
        
        return plan
```

---

## 7) Recommendation System

```text
Netflix's recommendation engine: drives ~80% of what people watch.
Without recommendations: users spend 60-90 seconds searching before giving up.
With recommendations: 30 seconds average to find something to watch.

Multi-stage pipeline:
1. Candidate generation (~17K titles -> 500 candidates)
   - Collaborative filtering: "users similar to you also liked X"
   - Content similarity: "you liked Stranger Things -> suggest similar sci-fi"
   - Context: time of day, device, recent behavior in this session
   
2. Ranking (500 candidates -> 40 for display)
   - Neural network with 100+ features per title
   - Features: watch completion, rewatch rate, likes, similarity to watch history
   - Personalized thumbnail selection (show the frame you'll most likely click)
   
3. Row generation (40 titles -> arranged into "shelves")
   - "Trending Now", "Because you watched [Title]", "Top picks for [Name]"
   - Each row has a different algorithm
```

```python
class RecommendationEngine:
    
    async def get_homepage(self, user_id: str, profile_id: str) -> list:
        """
        Generate personalized homepage rows.
        Must complete in < 200ms.
        """
        # Check recommendation cache first (5 min TTL)
        cached = await self.cache.get(f"homepage:{profile_id}")
        if cached:
            return cached
        
        # Fetch user signals in parallel
        user_history, user_ratings, context = await asyncio.gather(
            self.watch_history.get_recent(profile_id, limit=100),
            self.ratings.get_by_user(profile_id),
            self.context_service.get(user_id)
        )
        
        # Generate candidates from multiple sources
        candidates = await self._generate_candidates(
            profile_id, user_history, user_ratings
        )
        
        # Rank candidates
        ranked = await self.ranker.score_and_rank(candidates, profile_id, context)
        
        # Assemble rows
        rows = await self._assemble_rows(ranked, user_history, profile_id)
        
        # Cache result
        await self.cache.setex(f"homepage:{profile_id}", 300, rows)
        
        return rows
    
    async def _generate_candidates(
        self,
        profile_id: str,
        watch_history: list,
        ratings: list
    ) -> list:
        """Collaborative filtering + content-based hybrid."""
        
        # Collaborative filtering: find similar users, get their top content
        cf_candidates = await self.cf_model.get_candidates(profile_id, limit=200)
        
        # Content-based: find similar titles to recently watched
        recent_titles = [h["title_id"] for h in watch_history[:10]]
        cb_candidates = await self.embedding_service.find_similar(recent_titles, limit=200)
        
        # Trending in user's country
        trending = await self.trending_service.get(profile_id, limit=100)
        
        # Merge and deduplicate
        all_candidates = list({c["title_id"]: c for c in cf_candidates + cb_candidates + trending}.values())
        
        # Remove already watched (unless rewatchable)
        watched_ids = {h["title_id"] for h in watch_history}
        return [c for c in all_candidates if c["title_id"] not in watched_ids]
```

---

## 8) Adaptive Streaming and Client Player

```python
# Netflix uses DASH (Dynamic Adaptive Streaming over HTTP)
# Same concept as HLS but more flexible codec support

# Client player logic (runs in browser/app):

class NetflixPlayer:
    SEGMENT_DURATION_S = 4   # Netflix uses 4-second segments
    BUFFER_MIN_S = 10        # Start playing at 10s buffered
    BUFFER_TARGET_S = 60     # Aim for 60s buffer (1 min ahead)
    
    async def start_playback(self, title_id: str, profile_id: str) -> None:
        """
        1. Fetch manifest from Netflix API
        2. Select initial quality based on device + network
        3. Start buffering first segment while displaying loading
        4. Begin playback at BUFFER_MIN_S
        """
        # API call: tells client what CDN server to use, what DRM keys to request
        playback_info = await self.api.get_playback_info(title_id, profile_id)
        
        # Select closest CDN server (Anycast routing or API-directed)
        cdn_server = playback_info["cdn_endpoints"][0]
        
        # Download and parse DASH manifest
        manifest = await self.download_manifest(cdn_server, title_id)
        
        # Select initial quality (medium = safe start)
        self.current_quality = self._select_initial_quality()
        
        # Start buffering
        await self._buffer_segments(manifest, cdn_server)
    
    def _select_initial_quality(self) -> str:
        """
        Conservative initial quality.
        Don't try 4K immediately - risk buffering on startup.
        """
        if self.estimated_bandwidth_mbps > 25:
            return "1080p"    # Start at 1080p even if bandwidth supports 4K
        elif self.estimated_bandwidth_mbps > 5:
            return "720p"
        elif self.estimated_bandwidth_mbps > 2:
            return "480p"
        else:
            return "360p"
```

---

## 9) HLD

```text
Client (Smart TV / iOS / Android / Browser)
    |
    v
[Netflix Edge (CDN: Open Connect Appliance or Cloud CDN)]
    |  99% of reads end here
    | Cache miss:
    v
[Netflix API Gateway] -> [Auth / DRM Service]
    |
    +---[Catalog Service]         -> [Catalog DB (Cassandra)]
    +---[Recommendation Service]  -> [Feature Store (Redis/Cassandra)]
    +---[Playback Service]        -> [Manifest Generator]
    +---[Watch History Service]   -> [History DB (Cassandra)]
    +---[User Service]            -> [User DB (MySQL)]

[Content Pipeline]
    Raw files -> [Encoding Farm (GPU)] -> [Quality Control] -> [Open Connect Distribution]

[Analytics / Data]
    Client events -> [Kafka] -> [Spark Streaming] -> [Data Warehouse]
    -> A/B Test Framework, Recommendation Model Training, Quality Metrics
```

---

## 10) Interview Strategy

### Opening
```text
"Netflix's core problem is video delivery at Tbps scale — at peak, 15M 
concurrent viewers each watching at 3.5 Mbps = ~50 Tbps of throughput.
This is only possible with their own CDN (Open Connect) pre-positioned 
at ISPs worldwide, serving 99% of traffic without hitting origin.

The other interesting problems are: the per-title encoding pipeline 
(100+ variants per title), the recommendation engine (80% of views), 
and adaptive bitrate streaming for highly variable home networks."
```

### Key decisions
```text
1. Why build a proprietary CDN (Open Connect)?
   Commercial CDN cost at 50 Tbps: ~$500M/year
   Open Connect cost: much lower + better cache hit rates
   ISP benefit: saves peering costs, so ISPs want to host appliances

2. Why per-title encoding (not fixed bitrate ladder)?
   - Nature documentary with static shots: needs 1/3 the bits of same quality action film
   - Fixed ladder: wastes bandwidth for easy content, poor quality for complex content
   - Netflix's per-shot QO: ~20% bandwidth savings at same quality

3. Why Cassandra for watch history?
   - 100M users × 365 days × ~5 watch events/day = 183B rows/year
   - Cassandra: linear scale with nodes, optimized for time-series writes
   - Access pattern: "get last 100 events for user X" = single partition scan

4. Why not cache recommendations forever?
   - User watches something: recommendation should change immediately
   - 5-minute TTL: balance freshness vs computation cost
   - Background pre-compute: run heavy ML every hour, serve from cache
```

### Common follow-ups
```text
Q: How do you handle simultaneous peak (Super Bowl Sunday for streaming)?
A: Open Connect handles 99% of traffic. Netflix regions are independent.
   Autoscale API servers for metadata requests (small).
   Rate limit new stream starts if needed (QoS: existing streams > new starts).

Q: How does DRM work?
A: Each device has a unique device certificate.
   Netflix API returns encrypted content key (per-device encrypted with Widevine/FairPlay).
   Only the specific device can decrypt the content key.
   Video segments encrypted with AES-128; only decrypt with content key.

Q: How do you A/B test recommendation algorithms?
A: Traffic split by user_id % N.
   Track: time-to-play, session length, next-day retention.
   Run for 2+ weeks to capture weekly patterns.
   Champion/challenger model: 90%/10% split, promote winner.
```
