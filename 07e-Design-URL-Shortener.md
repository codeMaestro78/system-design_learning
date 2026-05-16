# Design URL Shortener (Comprehensive)

## 1) Intuition
A URL shortener (like bit.ly or tinyurl) converts `https://very-long-url.com/with/many/params?key=value` to `https://short.ly/abc123`.

The core is simple: a hash map from short code → long URL. The challenges are:
1. **Generating globally unique short codes** without coordination overhead
2. **High read throughput** (every short URL click triggers a redirect — potentially millions/day)
3. **Eventual analytics** (track clicks, by country, device, referrer, time)
4. **Abuse prevention** (malicious URLs must be blocked)

Real-world analogy: Like a library card catalog — instead of the full book title and location, you get a short Dewey Decimal code that points to the real location. The catalog needs to be globally unique, fast to look up, and never duplicate codes.

---

## 2) Functional Requirements
- Create short URL from long URL (with optional custom alias)
- Redirect to original URL (with 301/302 redirect)
- URL expiry (optional TTL)
- Analytics: click count, country, device, referrer
- User accounts: manage your URLs, see analytics
- Abuse detection: block malicious URLs

---

## 3) Non-Functional Requirements
- **Read latency:** Redirect P99 < 50ms
- **Availability:** 99.99% (every redirect failure = broken link)
- **Scale:** 100M URLs created/day, 10B redirects/day
- **Correctness:** No two short codes map to different URLs
- **No collisions:** Same long URL can have multiple short codes (by design)

---

## 4) Capacity Estimation

```python
url_shortener_scale = {
    # Writes
    "new_urls_per_day": 100_000_000,       # 100M new URLs/day
    "new_urls_per_second_avg": 1_157,
    "new_urls_per_second_peak": 3_500,
    
    # Reads (10:1 read:write ratio or higher)
    "redirects_per_day": 10_000_000_000,  # 10B
    "redirects_per_second_avg": 115_740,
    "redirects_per_second_peak": 350_000,  # 3x peak (viral links)
    
    # Storage
    "avg_url_record_bytes": 500,           # short_code + long_url + metadata
    "storage_per_day_gb": (100_000_000 * 500) / (1024**3),  # ~46 GB/day
    "storage_per_year_tb": 46 * 365 / 1024,  # ~16 TB/year
    "years_to_store": 5,
    "total_storage_tb": 16 * 5,  # ~80 TB (easily fits in distributed DB)
    
    # Cache impact
    # 80/20 rule: 20% of URLs drive 80% of traffic
    # If top 20M URLs cached: 80% of reads = cache hit
    # = 350K * 0.8 = 280K redirects/sec served from cache (no DB hit!)
    "hot_urls_in_cache": 20_000_000,
    "cache_size_gb": 20_000_000 * 500 / (1024**3),  # ~9.3 GB - fits in Redis!
}
```

---

## 5) Short Code Generation

### Option 1: Hash-based (simple, but collision-prone)
```python
import hashlib
import base64

def generate_short_code_hash(long_url: str, length: int = 7) -> str:
    """
    Take MD5 of URL, base62-encode, take first 7 chars.
    
    Problem: Collisions!
    - Two different URLs can hash to same 7-char prefix
    - Must handle collision in application layer (check + retry)
    
    Advantages: Deterministic (same URL -> same code), no DB needed to generate
    """
    hash_bytes = hashlib.md5(long_url.encode()).digest()
    
    # Base62 encode (0-9, a-z, A-Z = 62 chars)
    base62_chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    num = int.from_bytes(hash_bytes, byteorder="big")
    
    result = []
    while num:
        result.append(base62_chars[num % 62])
        num //= 62
    
    return "".join(reversed(result))[:length]

# 62^7 = 3.5 trillion unique codes - more than enough for 100B URLs
print(62 ** 7)  # 3,521,614,606,208
```

### Option 2: Counter-based with base62 encoding (recommended)
```python
class URLShortener:
    """
    Use an auto-incrementing counter (distributed if needed) + base62 encode.
    No collisions guaranteed, no coordination needed if counter is centralized.
    
    For distributed counter: use Zookeeper/Redis to allocate counter ranges.
    Each server gets a range (e.g., server 1: 0-999, server 2: 1000-1999).
    Servers generate IDs within their range without coordination.
    """
    
    BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    
    def __init__(self, redis_client, db):
        self.redis = redis_client
        self.db = db
        self._counter_start = None
        self._counter_end = None
        self._counter = None
        self.RANGE_SIZE = 10_000  # Allocate 10K IDs at a time from Redis
    
    def encode(self, num: int) -> str:
        """Convert integer to base62 string."""
        if num == 0:
            return self.BASE62[0]
        result = []
        while num:
            result.append(self.BASE62[num % 62])
            num //= 62
        return "".join(reversed(result))
    
    def decode(self, code: str) -> int:
        """Convert base62 string back to integer."""
        result = 0
        for char in code:
            result = result * 62 + self.BASE62.index(char)
        return result
    
    def _ensure_counter_range(self) -> None:
        """Allocate a new counter range from Redis if current range exhausted."""
        if self._counter is None or self._counter >= self._counter_end:
            # Atomically increment global counter and get new range
            range_start = self.redis.incrby("url_counter", self.RANGE_SIZE)
            self._counter_start = range_start - self.RANGE_SIZE
            self._counter_end = range_start
            self._counter = self._counter_start
    
    async def create_short_url(
        self,
        long_url: str,
        custom_alias: str = None,
        ttl_days: int = None,
        user_id: str = None
    ) -> dict:
        
        # 1. Validate URL (must be http/https)
        if not long_url.startswith(("http://", "https://")):
            raise InvalidURLError("URL must start with http:// or https://")
        
        # 2. Malicious URL check
        if await self.safe_browse.is_malicious(long_url):
            raise MaliciousURLError("URL flagged as harmful")
        
        # 3. Handle custom alias
        if custom_alias:
            if await self.db.get_url(custom_alias):
                raise AliasConflictError(f"Alias '{custom_alias}' already taken")
            short_code = custom_alias
        else:
            # Generate unique short code
            self._ensure_counter_range()
            short_code = self.encode(self._counter)
            self._counter += 1
        
        # 4. Save to DB
        record = {
            "short_code": short_code,
            "long_url": long_url,
            "user_id": user_id,
            "created_at": datetime.utcnow(),
            "expires_at": datetime.utcnow() + timedelta(days=ttl_days) if ttl_days else None,
            "click_count": 0,
        }
        await self.db.save_url(record)
        
        # 5. Cache the new URL immediately (warm the cache)
        await self.redis.setex(
            f"url:{short_code}",
            3600,  # 1 hour cache TTL
            long_url
        )
        
        return {
            "short_url": f"https://short.ly/{short_code}",
            "short_code": short_code,
            "long_url": long_url,
            "expires_at": record["expires_at"],
        }
    
    async def redirect(self, short_code: str, request_meta: dict) -> str:
        """
        The hot path: called on every redirect.
        Must be extremely fast (< 50ms P99).
        """
        # 1. Check cache first (cache-aside pattern)
        long_url = await self.redis.get(f"url:{short_code}")
        
        if not long_url:
            # Cache miss: fetch from DB
            record = await self.db.get_url(short_code)
            
            if not record:
                raise URLNotFoundError()
            
            if record["expires_at"] and record["expires_at"] < datetime.utcnow():
                raise URLExpiredError()
            
            long_url = record["long_url"]
            
            # Populate cache (TTL based on expiry or default 24h)
            ttl = min(86400, int((record["expires_at"] - datetime.utcnow()).total_seconds())
                      if record["expires_at"] else 86400)
            await self.redis.setex(f"url:{short_code}", ttl, long_url)
        
        # 2. Record analytics asynchronously (fire and forget, non-blocking)
        asyncio.create_task(self._record_click(short_code, request_meta))
        
        return long_url
    
    async def _record_click(self, short_code: str, meta: dict) -> None:
        """Async analytics: doesn't block redirect response."""
        await self.kafka.produce("url-clicks", {
            "short_code": short_code,
            "timestamp": datetime.utcnow().isoformat(),
            "country": meta.get("country"),
            "device": meta.get("device"),
            "referrer": meta.get("referer"),
            "ip_hash": hashlib.sha256(meta.get("ip", "").encode()).hexdigest()[:16],
        })
```

---

## 6) Data Model

```sql
CREATE TABLE urls (
    short_code    VARCHAR(20) PRIMARY KEY,
    long_url      TEXT NOT NULL,
    user_id       VARCHAR(40),               -- NULL for anonymous
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMP,                 -- NULL = never expires
    is_active     BOOLEAN DEFAULT TRUE,
    is_custom     BOOLEAN DEFAULT FALSE,
    click_count   BIGINT DEFAULT 0           -- Eventually consistent
);
CREATE INDEX idx_urls_user ON urls(user_id, created_at DESC);
CREATE INDEX idx_urls_expires ON urls(expires_at) WHERE expires_at IS NOT NULL;

-- Analytics (high write volume - use ClickHouse or BigQuery)
CREATE TABLE url_clicks (
    short_code    VARCHAR(20) NOT NULL,
    clicked_at    TIMESTAMP NOT NULL,
    country_code  VARCHAR(2),
    device_type   VARCHAR(10),  -- 'MOBILE', 'DESKTOP', 'TABLET'
    referrer      VARCHAR(500),
    ip_hash       VARCHAR(32)   -- Hashed for privacy
);
-- Partition by (short_code, day) for efficient per-URL analytics queries
```

---

## 7) High-Level Design (HLD)

```text
Browser/Client
    |
    v
[CDN / Edge (for static pages)]
    |
    v
[Load Balancer]
    |
    v
[URL Shortener API Servers]
    |
    +----[Redis Cache]        <- Hot URL lookup (< 1ms)
    |
    +----[URL Database]       <- PostgreSQL (master + read replicas)
    |    (sharded by short_code consistent hash)
    |
    +----[Kafka]              <- Click event streaming
         |
         v
         [Analytics Workers] -> [ClickHouse / BigQuery]
         [Click Count Aggregator] -> flush to DB every 60s
```

### Redirect types: 301 vs 302
```text
301 Permanent Redirect:
  - Browser caches the redirect permanently
  - Future requests go directly to destination (no server hit!)
  - Good for: reducing server load
  - Bad for: can't update if long URL changes; can't track repeat visitors from same browser

302 Temporary Redirect:
  - Browser does NOT cache
  - Every click hits the redirect server
  - Good for: accurate analytics, ability to update destination
  - Bad for: higher server load (every click hits us)
  
YouTube/bit.ly uses 301 for old URLs, 302 for analytics-tracked URLs.
```

---

## 8) Handling Edge Cases

```python
edge_cases = {
    "same_long_url_multiple_times": {
        "behavior": "Create new short code each time (by design)",
        "why": "User may want different analytics per campaign (UTM params differ)",
        "optional": "Can offer dedup with explicit user request"
    },
    "custom_alias_taken": {
        "behavior": "Return 409 Conflict, suggest alternatives",
        "alternatives": ["alice123", "alice_backup", "alice2024"]
    },
    "expired_url_clicked": {
        "behavior": "302 redirect to expiry landing page: 'This link has expired.'",
        "not": "404 (confusing to user)"
    },
    "malicious_url": {
        "behavior": "Block at creation time (Google Safe Browse API)",
        "rate": "< 0.1% of URLs; critical for trust",
        "post_creation": "Periodic re-scan; retroactive disable"
    },
    "ddos_via_short_code_scanning": {
        "behavior": "Rate limit lookups per IP (100/min)",
        "also": "Don't enumerate short codes: use random-looking codes (base62)"
    },
    "cache_stampede_on_viral_url": {
        "behavior": "Probabilistic early expiry, singleflight for DB",
        "why": "If cache expires while 10K requests arrive: 10K DB queries simultaneously"
    },
}
```

---

## 9) Interview Strategy

### Opening
```text
"URL shortening is a deceptively simple system. The core is a K-V store 
(short code -> long URL) with extremely high read QPS. The interesting 
engineering challenges are:
1. Globally unique code generation without coordination overhead
2. Cache design for 99%+ hit rate on the redirect hot path
3. Async analytics that don't slow down redirects"
```

### Common follow-ups
```text
Q: How do you handle 10B redirects/day without DB overload?
A: Redis cache in front. Cache stores top 20M URLs (only ~10 GB!).
   With 80/20 rule: 80% of 350K peak QPS = 280K QPS from cache.
   DB only handles 70K QPS peak (reads from replicas, writes to primary).

Q: How do you prevent the same long URL from getting infinite short codes?
A: Option A: Hash-based dedup (MD5 of URL -> same code always)
   Option B: Don't dedup (allow multiple codes per long URL for campaign tracking)
   In practice: most production systems don't dedup by default.

Q: How do you scale to multiple data centers?
A: Counter ranges per DC: DC1 gets 0-1T, DC2 gets 1T-2T, etc.
   Prevents collisions without cross-DC coordination.
   Replication: async replication from primary to other DCs for reads.

Q: How does analytics work at scale?
A: Fire-and-forget to Kafka on each click. Never block redirect on analytics write.
   Kafka consumers aggregate: clicks per URL per hour per country.
   Store aggregates in ClickHouse (OLAP). Never store every individual click row in OLTP.
```
