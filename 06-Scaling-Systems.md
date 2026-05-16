# Part 6: Scaling Systems (Deep)

## 1) Handling Millions of Users

### Intuition
Scaling is constraint management: CPU, memory, I/O, network, and human operability. You don't scale everything at once — you scale the bottleneck.

The famous "scaling ladder" — every stage has a different bottleneck:
```text
Stage 1: 0-1K users      -> Single server, single DB. Bottleneck: nothing yet.
Stage 2: 1K-10K users    -> DB connection exhaustion. Add connection pooling.
Stage 3: 10K-100K users  -> DB read capacity. Add read replicas + cache.
Stage 4: 100K-1M users   -> App servers, DB writes. Add app replicas + queue.
Stage 5: 1M-10M users    -> DB write capacity. Shard the database.
Stage 6: 10M-100M users  -> Single region. Multi-region deployment.
Stage 7: 100M+ users     -> Everything. Full distributed system.
```

### The capacity math: always start here
```python
def capacity_estimation(
    dau: int,
    reads_per_user_per_day: int,
    writes_per_user_per_day: int,
    read_payload_kb: float,
    write_payload_kb: float,
    peak_factor: float = 3.0,
    read_write_split: float = 0.8  # 80% reads, 20% writes
) -> dict:
    """
    Complete capacity estimation for a new service.
    Run this FIRST before designing architecture.
    """
    # QPS calculations
    total_daily_requests = dau * (reads_per_user_per_day + writes_per_user_per_day)
    avg_qps = total_daily_requests / 86400
    peak_qps = avg_qps * peak_factor
    
    read_qps = peak_qps * read_write_split
    write_qps = peak_qps * (1 - read_write_split)
    
    # Storage calculations (per year)
    bytes_written_per_day = dau * writes_per_user_per_day * write_payload_kb * 1024
    bytes_per_year = bytes_written_per_day * 365
    
    # Network bandwidth (peak)
    peak_ingress_mbps = (write_qps * write_payload_kb) / 1024 * 8  # to Mbps
    peak_egress_mbps = (read_qps * read_payload_kb) / 1024 * 8
    
    # Infrastructure sizing
    # Rule of thumb: 1 app server handles ~1000 QPS for lightweight operations
    #                or ~100 QPS for DB-heavy operations
    app_servers_needed = max(2, int(peak_qps / 500))  # 500 QPS per server
    
    return {
        "peak_qps": round(peak_qps),
        "read_qps": round(read_qps),
        "write_qps": round(write_qps),
        "storage_tb_per_year": round(bytes_per_year / (1024**4), 2),
        "peak_ingress_mbps": round(peak_ingress_mbps, 1),
        "peak_egress_mbps": round(peak_egress_mbps, 1),
        "app_servers_min": app_servers_needed,
    }

# Real examples:
print("Twitter-scale capacity:")
twitter = capacity_estimation(
    dau=200_000_000,
    reads_per_user_per_day=40,   # timeline views
    writes_per_user_per_day=2,    # ~1 tweet + engagement per day
    read_payload_kb=5,
    write_payload_kb=1,
    peak_factor=3.0
)
# peak_qps: ~347K, need ~700 app servers
print(twitter)

print("\nURL shortener-scale capacity:")
url_shortener = capacity_estimation(
    dau=5_000_000,
    reads_per_user_per_day=2,    # mostly redirects
    writes_per_user_per_day=0.1, # 1 new URL per 10 visits
    read_payload_kb=0.5,
    write_payload_kb=0.1,
    peak_factor=5.0   # viral links can spike
)
print(url_shortener)
```

---

## 2) Database Scaling Strategies

### Stage 1: Connection pooling (often overlooked)
```text
Problem: PostgreSQL creates a new OS process per connection.
100 connections = 100 processes = hundreds of MB of RAM just for connection overhead.

Without connection pool:
  App server -> creates 100 DB connections -> 100 Postgres processes

With PgBouncer (connection pooler):
  100 App threads -> PgBouncer (reuses 10 real DB connections) -> Postgres

PgBouncer config:
```

```ini
[databases]
mydb = host=postgres port=5432 dbname=mydb

[pgbouncer]
pool_mode = transaction        # Session, transaction, or statement mode
max_client_conn = 10000       # Max app connections to pgbouncer  
default_pool_size = 20        # Actual connections to Postgres
reserve_pool_size = 5         # Emergency connections
server_idle_timeout = 600     # Release idle Postgres connections after 10 min
```

### Stage 2: Read replicas
```python
class DatabaseRouter:
    """
    Route reads to replicas, writes to primary.
    Multiple replicas can handle read-heavy workloads.
    """
    
    def __init__(self):
        self.primary = create_connection("postgres://primary:5432/db")
        self.replicas = [
            create_connection("postgres://replica1:5432/db"),
            create_connection("postgres://replica2:5432/db"),
            create_connection("postgres://replica3:5432/db"),
        ]
        self._replica_index = 0
    
    def get_read_connection(self, require_fresh: bool = False):
        """
        require_fresh=True: read from primary (e.g., after a write that user must see)
        require_fresh=False: read from replica (may be 0-100ms stale)
        """
        if require_fresh:
            return self.primary
        
        # Round-robin across replicas
        replica = self.replicas[self._replica_index % len(self.replicas)]
        self._replica_index += 1
        return replica
    
    def get_write_connection(self):
        return self.primary

# Usage
router = DatabaseRouter()

# Read (use replica - 3x the read capacity)
profile = router.get_read_connection().query("SELECT * FROM users WHERE id=$1", user_id)

# Write (must use primary)
router.get_write_connection().execute("UPDATE users SET name=$1 WHERE id=$2", name, user_id)

# Read-your-writes: after updating, read from primary to avoid seeing stale data
router.get_write_connection().execute("UPDATE users SET name=$1 WHERE id=$2", name, user_id)
updated = router.get_read_connection(require_fresh=True).query(  # Fresh from primary!
    "SELECT * FROM users WHERE id=$1", user_id
)
```

### Stage 3: Caching layer (reduces DB load by 80-95%)
```python
# Facebook found: adding Memcached reduced DB load by 90%
# Simple rule: if data is:
#   - read frequently (> 100x/day)
#   - written infrequently (< 1x/day)
#   - same data served to many users
# -> Cache it!

# What to cache:
cache_candidates = {
    "user_profiles":      {"ttl": 300, "reason": "1000 reads per 1 write"},
    "product_catalog":    {"ttl": 600, "reason": "1M reads per 1 write"},
    "static_config":      {"ttl": 3600, "reason": "Never changes in prod"},
    "rendered_templates": {"ttl": 60, "reason": "Same HTML for many users"},
}

# What NOT to cache:
no_cache = {
    "payment_balances":  "Must always be exact - never serve stale",
    "auth_tokens":       "Security-sensitive, must invalidate immediately",
    "user_feeds":        "Different for every user + changes constantly",
    "realtime_counters": "Changes every second - cache becomes stale immediately",
}
```

---

## 3) Hotspot Handling

### The celebrity problem
```text
Normal users: 100 followers each
Kylie Jenner: 100 million followers

When Kylie posts:
  - Normal user post: fan out to 100 users (100 writes)
  - Celebrity post: fan out to 100M users (100M writes)
  
If done synchronously: checkout service hangs for minutes
If done asynchronously: queue backlog grows to millions of items
```

### Consistent hashing: distribute hot keys
```python
import hashlib
import bisect

class ConsistentHashRouter:
    """
    Regular hash: item % n_nodes
    Problem: adding/removing a node rehashes ALL items
    
    Consistent hash: items and nodes on same ring
    Adding node: only rehashes items between new node and its predecessor
    Removing node: only rehashes items that were on that node
    """
    
    def __init__(self, nodes: list, virtual_nodes: int = 150):
        """
        virtual_nodes: each physical node gets multiple positions on ring
        Why: with few nodes, distribution can be uneven
             more virtual nodes = more even distribution
        """
        self.ring = {}          # ring position -> node_id
        self.sorted_positions = []
        self.virtual_nodes = virtual_nodes
        
        for node in nodes:
            self.add_node(node)
    
    def add_node(self, node_id: str):
        for i in range(self.virtual_nodes):
            position = self._hash(f"{node_id}:vn:{i}")
            self.ring[position] = node_id
            bisect.insort(self.sorted_positions, position)
    
    def remove_node(self, node_id: str):
        for i in range(self.virtual_nodes):
            position = self._hash(f"{node_id}:vn:{i}")
            if position in self.ring:
                del self.ring[position]
                self.sorted_positions.remove(position)
    
    def get_node(self, key: str) -> str:
        position = self._hash(key)
        # Find first ring position >= key's position
        idx = bisect.bisect_left(self.sorted_positions, position)
        if idx >= len(self.sorted_positions):
            idx = 0  # Wrap around
        return self.ring[self.sorted_positions[idx]]
    
    def get_n_nodes(self, key: str, n: int) -> list:
        """Get n nodes for replication."""
        position = self._hash(key)
        idx = bisect.bisect_left(self.sorted_positions, position)
        
        nodes = []
        seen = set()
        for i in range(len(self.sorted_positions)):
            ring_idx = (idx + i) % len(self.sorted_positions)
            node = self.ring[self.sorted_positions[ring_idx]]
            if node not in seen:
                nodes.append(node)
                seen.add(node)
                if len(nodes) == n:
                    break
        return nodes
    
    def _hash(self, key: str) -> int:
        return int(hashlib.sha256(key.encode()).hexdigest(), 16)

# Test distribution
router = ConsistentHashRouter(["cache1", "cache2", "cache3", "cache4"])
distribution = {}
for i in range(10000):
    node = router.get_node(f"key_{i}")
    distribution[node] = distribution.get(node, 0) + 1
print(distribution)  # Should be roughly even: each ~2500
```

### Hot key mitigation strategies
```python
class HotKeyMitigation:
    """
    Multiple strategies to handle keys that receive 100x+ normal traffic.
    Example: Kylie Jenner's user profile, trending topic data.
    """
    
    def __init__(self, redis_client):
        self.redis = redis_client
    
    # Strategy 1: Key replication (multiple copies of same data)
    def get_with_replication(self, key: str, replica_count: int = 10) -> bytes:
        """
        Instead of one key, spread read load across N copies.
        Each request goes to a random replica.
        
        single key "hot_celebrity:123" -> 100K QPS -> 1 node saturated
        10 replicas "hot_celebrity:123:shard:0-9" -> 10K QPS each -> manageable
        """
        shard = random.randint(0, replica_count - 1)
        value = self.redis.get(f"{key}:shard:{shard}")
        
        if value:
            return value
        
        # Primary miss: fetch and populate all shards
        value = self.fetch_from_source(key)
        for i in range(replica_count):
            self.redis.setex(f"{key}:shard:{i}", 300 + random.randint(0, 30), value)
        return value
    
    # Strategy 2: Local in-process cache (avoids Redis entirely for hottest keys)
    def get_with_local_cache(self, key: str, local_ttl_s: int = 5):
        """
        Each app server caches the hottest 1000 keys locally.
        0 network calls for in-process cache hits.
        5-second TTL means at most 5 seconds stale.
        
        Tradeoff: potential staleness, memory usage per server.
        Only use for data where brief staleness is acceptable.
        """
        # Check in-process LRU cache first
        cached = self.local_lru.get(key)
        if cached and cached["expires"] > time.time():
            return cached["value"]
        
        # Redis hit
        value = self.redis.get(key)
        
        if value:
            self.local_lru.put(key, {
                "value": value,
                "expires": time.time() + local_ttl_s
            })
        
        return value
    
    # Strategy 3: Request coalescing (singleflight)
    async def get_with_singleflight(self, key: str):
        """
        When 10,000 requests arrive simultaneously for same uncached key,
        only make ONE backend call. All requests wait for same result.
        """
        if key in self._pending:
            return await self._pending[key]  # Wait for in-flight request
        
        future = asyncio.Future()
        self._pending[key] = future
        
        try:
            value = await self.fetch_from_source(key)
            future.set_result(value)
            return value
        except Exception as e:
            future.set_exception(e)
            raise
        finally:
            del self._pending[key]
```

---

## 4) CDN (Content Delivery Network)

### How CDN works
```text
Without CDN:
  User in Mumbai  -> Data center in US West -> 200ms round trip
  User in Germany -> Data center in US West -> 180ms round trip
  
With CDN:
  User in Mumbai  -> CDN edge PoP in Mumbai -> 10ms (cache hit)
  User in Germany -> CDN edge PoP in Frankfurt -> 10ms (cache hit)
  
  Cache miss:     CDN edge -> CDN origin shield -> Your servers
  CDN hit rate:   typically 80-95% for static content
```

### What to put in CDN
```python
cdn_strategy = {
    "cache_aggressively": {
        "content": "Images, videos, CSS, JS, fonts",
        "ttl": "1 year (use content-addressable URLs)",
        "example_header": "Cache-Control: public, max-age=31536000, immutable",
        "url_pattern": "/static/styles.a3b2c1.css"  # Hash in URL, busts on deploy
    },
    "cache_with_revalidation": {
        "content": "API responses that are same for many users (homepage data)",
        "ttl": "60-300 seconds with stale-while-revalidate",
        "example_header": "Cache-Control: public, max-age=60, stale-while-revalidate=600",
    },
    "bypass_cdn": {
        "content": "Personalized responses, auth-required endpoints, payments",
        "header": "Cache-Control: private, no-store",
        "why": "CDN would cache one user's data and serve it to another"
    }
}

# CDN cache key normalization (important!)
# Without normalization, these are different cache entries:
# /api/products?sort=price&page=1
# /api/products?page=1&sort=price  <- same query, different order = cache miss!

# CDN configuration to normalize:
cdn_config = {
    "sort_query_params": True,
    "strip_query_params": ["utm_source", "utm_campaign", "fbclid"],  # Analytics params
    "normalize_paths": True  # /api/v1// -> /api/v1/
}
```

### CDN purge strategy
```python
# When content changes, CDN must serve fresh data

async def update_product(product_id: str, updates: dict) -> dict:
    # 1. Update in database
    product = await db.update_product(product_id, updates)
    
    # 2. Purge CDN cache for this product's pages/API responses
    urls_to_purge = [
        f"/api/products/{product_id}",
        f"/products/{product_id}",       # product page
        f"/category/{product.category_id}",  # category page
    ]
    
    await cdn.purge(urls_to_purge)
    
    # 3. Update Redis cache
    await redis.delete(f"product:{product_id}")
    
    return product
```

---

## 5) Fanout Patterns (Feed Systems)

### The core tradeoff
```text
Fanout-on-write (push model):
  When user posts: immediately copy post to all followers' feeds
  
  Pros: Fast reads (feed is pre-computed, just fetch top N)
  Cons: Slow writes for popular users (writing to 100M feeds takes minutes)
        Wasted writes (followers who haven't opened app in weeks)

Fanout-on-read (pull model):
  When user opens app: query all followed users' posts and merge
  
  Pros: Simple, writes are fast, no waste for inactive users
  Cons: Slow reads (N queries to merge N followed users' posts)
        Gets slower as you follow more people

Hybrid (what Twitter/Instagram actually use):
  Regular users (< 1M followers): fanout-on-write (fast reads)
  Celebrity users (> 1M followers): fanout-on-read (avoid crushing write path)
```

```python
class HybridFanout:
    CELEBRITY_THRESHOLD = 1_000_000
    
    async def handle_new_post(self, author_id: str, post: dict) -> None:
        follower_count = await self.get_follower_count(author_id)
        
        if follower_count < self.CELEBRITY_THRESHOLD:
            # Regular user: fanout-on-write
            await self._fanout_to_followers(author_id, post)
        else:
            # Celebrity: just store the post, fanout when followers read
            await self._store_celebrity_post(author_id, post)
    
    async def _fanout_to_followers(self, author_id: str, post: dict) -> None:
        """
        Write post ID to each follower's timeline.
        For 1000 followers at 10ms per batch write:
        - 1000 followers = 1 batch = 10ms
        - 100K followers = 100 batches = 1 second (OK with async workers)
        """
        BATCH_SIZE = 1000
        cursor = None
        
        while True:
            followers, cursor = await self.get_followers(author_id, cursor, BATCH_SIZE)
            if not followers:
                break
            
            # Batch write to timeline store (Redis sorted set per user)
            pipe = self.redis.pipeline()
            for follower_id in followers:
                # Score = timestamp (enables time-sorted retrieval)
                pipe.zadd(
                    f"timeline:{follower_id}",
                    {post["id"]: post["timestamp"]}
                )
                # Trim to last 800 items (don't store forever)
                pipe.zremrangebyrank(f"timeline:{follower_id}", 0, -801)
            await pipe.execute()
    
    async def get_timeline(self, user_id: str, cursor: str, limit: int = 20) -> list:
        """
        Get user's home feed.
        For regular users: just read from pre-computed timeline.
        For users who follow celebrities: merge pre-computed + celebrity posts.
        """
        # Get pre-computed timeline entries
        timeline_posts = await self.redis.zrevrangebyscore(
            f"timeline:{user_id}",
            max=cursor or "+inf",
            min="-inf",
            start=0,
            num=limit + 50  # Overfetch to account for merging
        )
        
        # Get followed celebrities' recent posts
        celebrity_posts = await self.get_celebrity_posts_for_user(user_id, limit * 2)
        
        # Merge and sort by timestamp
        all_posts = list(timeline_posts) + celebrity_posts
        all_posts.sort(key=lambda p: p["timestamp"], reverse=True)
        
        return all_posts[:limit]
```

---

## 6) Multi-Region Systems

### Why multi-region
```text
1. Latency: Users in Asia serving from US west = 150ms extra
   With Asia region: 10ms
   
2. Availability: Region outage (natural disaster, fiber cut) takes you down
   With 3 regions: any 1 region can fail, system stays up

3. Data residency: EU GDPR requires EU user data stays in EU

4. Disaster recovery: RPO/RTO requirements
```

### Active-passive vs Active-active
```text
Active-Passive:
  - All traffic goes to Region A (primary)
  - Region B receives replicated data but serves no traffic
  - Failover: DNS cutover to Region B
  
  Pros: No conflicts, simpler consistency
  Cons: Region B is idle (wasted cost), failover takes minutes

Active-Active:
  - Both regions serve traffic for their closest users
  - Data is replicated bidirectionally
  - Requires conflict resolution strategy
  
  Pros: Lower latency for all users, no idle resources, automatic failover
  Cons: Write conflicts, complex consistency, higher engineering cost
```

```python
class MultiRegionDataRouter:
    """
    Route reads and writes based on user location and data residency.
    """
    
    REGION_ENDPOINTS = {
        "us-west": "https://us-west.api.internal",
        "eu-west": "https://eu-west.api.internal",
        "ap-south": "https://ap-south.api.internal",
    }
    
    def get_region_for_user(self, user_id: str, user_country: str) -> str:
        """
        Route user to their closest/legally-required region.
        """
        # EU users must stay in EU (GDPR data residency)
        eu_countries = {"DE", "FR", "IT", "ES", "NL", "PL", "SE", "NO", "FI"}
        if user_country in eu_countries:
            return "eu-west"
        
        # Other regions by geography
        asia_countries = {"IN", "JP", "CN", "SG", "AU"}
        if user_country in asia_countries:
            return "ap-south"
        
        return "us-west"  # Default
    
    def write_to_home_region(self, user_id: str, data: dict) -> None:
        region = self.get_region_for_user(user_id, data["country"])
        endpoint = self.REGION_ENDPOINTS[region]
        # Write goes to user's home region
        # Async replication to other regions
        http.post(f"{endpoint}/data", data)
    
    def read_from_nearest_region(self, user_id: str) -> dict:
        # Read from closest region (might be slightly stale due to async replication)
        nearest = self.get_nearest_region()
        endpoint = self.REGION_ENDPOINTS[nearest]
        return http.get(f"{endpoint}/data/{user_id}")
```

### Multi-region failover checklist
```python
failover_checklist = {
    "prerequisites": [
        "Traffic steering mechanism tested (Route53 health checks or similar)",
        "Data replication health verified (lag < 30 seconds)",
        "Secrets and configuration are in sync across regions",
        "TLS certificates valid in target region",
        "Database schema migrations applied to target region",
        "Read-only fallback mode tested (if cross-region writes not yet ready)",
    ],
    "failover_procedure": [
        "1. Verify target region health (load test with 5% of traffic)",
        "2. Update DNS health check to point to target region",
        "3. Monitor error rate: should stay below SLO",
        "4. Confirm traffic routing shifted completely",
        "5. Monitor for 30 minutes before declaring success",
    ],
    "failback_procedure": [
        "1. Verify original region is healthy",
        "2. Replay any writes that happened during failover",
        "3. Gradually shift traffic back (10% -> 50% -> 100%)",
        "4. Update DNS back to original",
    ]
}
```

---

## 7) Autoscaling

### Kubernetes Horizontal Pod Autoscaler
```yaml
# Kubernetes HPA: automatically add/remove pods based on metrics
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-service-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-service
  
  minReplicas: 3   # Always keep 3 pods (HA minimum)
  maxReplicas: 50  # Hard limit (cost control)
  
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 65  # Scale when avg CPU > 65%
    
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 70
    
    # Custom metric: scale on request queue depth
    - type: External
      external:
        metric:
          name: sqs_queue_depth  
          selector:
            matchLabels:
              queue: "api-requests"
        target:
          type: AverageValue
          averageValue: "100"  # Target 100 messages per pod

  behavior:
    scaleUp:
      stabilizationWindowSeconds: 60   # Don't add pods during 60s window
      policies:
        - type: Pods
          value: 4                      # Add max 4 pods at a time
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300  # Wait 5 min before scaling down
      policies:
        - type: Percent
          value: 20                    # Remove max 20% of pods at a time
          periodSeconds: 60
```

### Custom autoscaling logic
```python
class AutoScaler:
    """
    Business logic for when and how to scale.
    Works with any cloud provider's scaling API.
    """
    
    def __init__(self, service_name: str, min_instances: int, max_instances: int):
        self.service = service_name
        self.min = min_instances
        self.max = max_instances
        self.current = min_instances
        self.last_scale_time = 0
        self.cooldown_s = 120  # 2 min between scale events
    
    def should_scale_out(self, metrics: dict) -> bool:
        """Scale out (add instances) triggers."""
        return (
            metrics["cpu_percent"] > 70 or
            metrics["p95_latency_ms"] > metrics["slo_latency_ms"] or
            metrics["queue_depth"] > 1000
        )
    
    def should_scale_in(self, metrics: dict) -> bool:
        """Scale in (remove instances) triggers - more conservative."""
        return (
            metrics["cpu_percent"] < 25 and
            metrics["p95_latency_ms"] < metrics["slo_latency_ms"] * 0.5 and
            metrics["queue_depth"] < 100
        )
    
    def scale(self, metrics: dict) -> None:
        now = time.time()
        
        # Respect cooldown period (prevent oscillation)
        if now - self.last_scale_time < self.cooldown_s:
            return
        
        if self.should_scale_out(metrics) and self.current < self.max:
            # Add instances proportionally to overload
            overload_ratio = max(
                metrics["cpu_percent"] / 70,
                metrics["p95_latency_ms"] / metrics["slo_latency_ms"]
            )
            instances_to_add = max(1, int(self.current * (overload_ratio - 1)))
            new_count = min(self.current + instances_to_add, self.max)
            self._scale_to(new_count)
        
        elif self.should_scale_in(metrics) and self.current > self.min:
            # Remove one instance at a time to avoid over-scaling in
            self._scale_to(self.current - 1)
    
    def _scale_to(self, count: int) -> None:
        cloud.scale_service(self.service, count)
        self.current = count
        self.last_scale_time = time.time()
        metrics.emit("autoscale_event", {"service": self.service, "count": count})
```

---

## Exercises

1. **Scale a URL shortener from 100 QPS to 1M QPS:** What changes first? (Answer: cache hits prevent most DB reads). What changes second? (Read replicas). What changes third? (Sharding the URL table by URL hash).

2. **Handle a hot celebrity key:** Design system so Kylie Jenner's profile page can handle 1M reads/sec without overwhelming Redis.

3. **Multi-region failover drill:** Write a runbook for failing over your primary US-West region to EU-West. What needs to happen before, during, and after? What is the expected RTO?

4. **Consistent hash test:** Implement consistent hash ring with 4 nodes. Add a 5th node. Show that only ~20% of keys moved (vs 80% with simple modulo hash).

---

## Scaling Decision Tree
```text
High CPU saturation?
  Yes -> Add app server replicas OR optimize hot code path (profile first)

High DB read latency?
  Yes -> Add read replicas OR add cache layer OR optimize queries (EXPLAIN ANALYZE)

High DB write latency?
  Yes -> Batch writes OR add queue for async writes OR reduce indexes OR shard

Queue backing up?
  Yes -> Add consumer workers OR partition queue for parallelism OR backpressure
  
Single key getting 10x+ traffic?
  Yes -> Key replication OR local in-process cache OR request coalescing

Network egress cost very high?
  Yes -> Add CDN for static content OR add regional cache OR compress responses

Memory exhausting?
  Yes -> Eviction policy tuning OR cache smaller values OR vertical scaling

Rule: Scale the BOTTLENECK, not everything.
Rule: Cache before you shard.
Rule: Shard only after you know access patterns well.
Rule: Multi-region only when you have clear latency or availability need.
```
