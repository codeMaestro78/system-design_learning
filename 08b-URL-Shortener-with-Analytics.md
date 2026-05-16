# Project 2: URL Shortener with Analytics (Bitly-style)

## Goal
Build a production-grade URL shortener that:
- Shortens long URLs to 7-char codes (Base62)
- Redirects with <10ms p99 latency using cache-aside
- Tracks every click (async via Kafka-like queue)
- Exposes analytics: clicks/day, top referrers, geo breakdown
- Handles custom aliases, expiration, idempotency

This project teaches: Base62 encoding, cache-aside pattern, async event pipelines, OLAP aggregation.

---

## Architecture

```text
 ┌─────────────────────────────────────────────────────────────────┐
 │                        Create Flow                              │
 │  POST /shorten ──> Idempotency Check ──> Code Generator         │
 │                          │                     │                │
 │                    (Idempotency DB)      Base62(counter)        │
 │                                                │                │
 │                                         Write: Link DB          │
 │                                         Write: Cache (Redis)    │
 └─────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────┐
 │                       Redirect Flow                             │
 │  GET /{code} ──> Redis Cache ──HIT──> HTTP 302 Redirect         │
 │                        │                                        │
 │                       MISS                                      │
 │                        │                                        │
 │                   Link DB Lookup ──FOUND──> cache + redirect    │
 │                        │                                        │
 │                     NOT FOUND ──> 404                           │
 │                        │                                        │
 │                   Click Event ──> Async Queue ──> Aggregator    │
 └─────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────┐
 │                     Analytics Flow                              │
 │  Click Events ──> Queue ──> Aggregator ──> Analytics DB         │
 │                                               │                 │
 │                                         Query API              │
 │                                        /analytics/{code}       │
 └─────────────────────────────────────────────────────────────────┘
```

---

## Capacity Estimation

```python
# Capacity math for a Bitly-scale system
qps_reads = 10_000        # redirects/sec (peak)
qps_writes = 100          # new links/sec
links_total = 5e9         # 5 billion links over 5 years
clicks_per_day = 864e6    # 10K/sec * 86400

# Storage: Link table
bytes_per_link = 512      # code(7) + long_url(200) + meta(305)
link_storage_gb = links_total * bytes_per_link / 1e9
print(f"Link storage: {link_storage_gb:.0f} GB")   # ~2,560 GB = 2.5 TB

# Storage: Click events (raw)
bytes_per_click = 128     # code + timestamp + ip + referer + ua (compressed)
click_storage_day = clicks_per_day * bytes_per_click / 1e9
print(f"Click storage/day: {click_storage_day:.1f} GB")   # ~110 GB/day

# Cache sizing: 80/20 rule — 20% of links get 80% of traffic
hot_links = links_total * 0.20
cache_bytes = hot_links * bytes_per_link
cache_gb = cache_bytes / 1e9
print(f"Cache for hot links: {cache_gb:.0f} GB")   # ~512 GB (Redis cluster)

# Read/write ratio: 100:1 (reads dominate)
print(f"Read:Write ratio = {qps_reads // 100}:1")
```

---

## Full Working Implementation

```python
#!/usr/bin/env python3
"""
url_shortener.py - Production-grade URL shortener with analytics.

Run:   uv run url_shortener.py
Test:  curl -X POST http://localhost:8000/shorten -d '{"url":"https://example.com"}'
       curl -L http://localhost:8000/abc123
"""
# /// script
# dependencies = ["fastapi", "uvicorn", "redis", "sqlmodel", "httpx"]
# ///

import asyncio
import hashlib
import json
import re
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field, asdict
from datetime import datetime, date
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, BackgroundTasks
from fastapi.responses import RedirectResponse, JSONResponse
from pydantic import BaseModel, validator
import uvicorn


# ============================================================================
# Base62 Code Generation
# ============================================================================

BASE62_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

def base62_encode(n: int) -> str:
    """
    Encode an integer as a Base62 string.
    
    Why Base62? URL-safe: no +/= like Base64. 
    7 chars = 62^7 = 3.5 trillion unique codes.
    
    Example: 1000000 -> "4c92"
    """
    if n == 0:
        return BASE62_CHARS[0]
    result = []
    while n:
        result.append(BASE62_CHARS[n % 62])
        n //= 62
    return "".join(reversed(result))


def base62_decode(s: str) -> int:
    """Decode Base62 string back to integer."""
    return sum(BASE62_CHARS.index(c) * (62 ** i) 
               for i, c in enumerate(reversed(s)))


class CodeGenerator:
    """
    Generates unique 7-character Base62 codes.
    
    Strategy 1: Counter-based (used here)
    - Atomic counter (DB sequence or Redis INCR)
    - Encode counter as Base62
    - Predictable, no collisions, easy to shard
    
    Strategy 2: Hash-based
    - MD5(long_url + salt) -> take first 7 chars
    - Risk: collision if two URLs hash to same prefix
    - Collision rate: 1/(62^7) = 1 in 3.5 trillion — acceptable
    
    Strategy 3: Random
    - random.choice(BASE62_CHARS) * 7
    - Check DB for collision before inserting
    - Higher collision probability at scale
    
    Counter-based wins: zero collisions, O(1) generation.
    """
    
    def __init__(self):
        self._counter = 1_000_000  # Start at 1M to avoid short codes
    
    def next_code(self) -> str:
        """Get next unique code. In production, use Redis INCR for atomicity."""
        code = base62_encode(self._counter).zfill(7)[:7]
        self._counter += 1
        return code
    
    def hash_code(self, long_url: str) -> str:
        """Alternative: hash-based code generation."""
        h = hashlib.md5(long_url.encode()).hexdigest()
        # Convert hex to base62-like encoding
        n = int(h[:8], 16)
        return base62_encode(n).zfill(7)[:7]


# ============================================================================
# In-Memory Stores (replace with Postgres + Redis in production)
# ============================================================================

@dataclass
class LinkRecord:
    code: str
    long_url: str
    created_at: float = field(default_factory=time.time)
    expires_at: Optional[float] = None
    custom_alias: bool = False
    creator_id: Optional[str] = None
    title: Optional[str] = None
    click_count: int = 0


@dataclass
class ClickEvent:
    code: str
    timestamp: float
    ip: str
    user_agent: str
    referer: Optional[str]
    country: Optional[str]


class LinkStore:
    """In-memory link store (simulates Postgres table)."""
    
    def __init__(self):
        self._links: dict[str, LinkRecord] = {}
        self._idempotency: dict[str, str] = {}  # idem_key -> code
    
    def get(self, code: str) -> Optional[LinkRecord]:
        link = self._links.get(code)
        if link is None:
            return None
        if link.expires_at and time.time() > link.expires_at:
            return None  # Treat as not found (expired)
        return link
    
    def is_expired(self, code: str) -> bool:
        link = self._links.get(code)
        return link is not None and link.expires_at and time.time() > link.expires_at
    
    def create(self, link: LinkRecord, idempotency_key: Optional[str] = None) -> LinkRecord:
        if idempotency_key:
            existing_code = self._idempotency.get(idempotency_key)
            if existing_code:
                return self._links[existing_code]  # Return existing (idempotent)
        
        if link.code in self._links:
            raise ValueError(f"Code '{link.code}' already exists (alias collision)")
        
        self._links[link.code] = link
        if idempotency_key:
            self._idempotency[idempotency_key] = link.code
        
        return link
    
    def increment_clicks(self, code: str) -> None:
        if code in self._links:
            self._links[code].click_count += 1


class RedisLikeCache:
    """Simple in-memory cache (simulates Redis GET/SET/EXPIRE)."""
    
    def __init__(self):
        self._store: dict = {}
        self._ttls: dict = {}
    
    def get(self, key: str) -> Optional[str]:
        if key in self._ttls and time.time() > self._ttls[key]:
            del self._store[key]
            del self._ttls[key]
            return None
        return self._store.get(key)
    
    def set(self, key: str, value: str, ttl_seconds: int = 3600) -> None:
        self._store[key] = value
        self._ttls[key] = time.time() + ttl_seconds
    
    def delete(self, key: str) -> None:
        self._store.pop(key, None)
        self._ttls.pop(key, None)


class ClickAnalyticsStore:
    """
    In-memory analytics store with pre-aggregated rollups.
    In production: ClickHouse for OLAP queries.
    """
    
    def __init__(self):
        # Raw events buffer (before aggregation)
        self._buffer: list[ClickEvent] = []
        # Aggregated: code -> date_str -> count
        self._daily: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        # Aggregated: code -> referer -> count
        self._referers: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        # Aggregated: code -> country -> count
        self._countries: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    
    def record(self, event: ClickEvent) -> None:
        """Record click event (called asynchronously)."""
        day = datetime.fromtimestamp(event.timestamp).strftime("%Y-%m-%d")
        self._daily[event.code][day] += 1
        
        referer = event.referer or "direct"
        self._referers[event.code][referer] += 1
        
        country = event.country or "unknown"
        self._countries[event.code][country] += 1
    
    def get_stats(self, code: str, days: int = 7) -> dict:
        daily = dict(self._daily[code])
        referers = dict(sorted(
            self._referers[code].items(), key=lambda x: x[1], reverse=True
        )[:10])  # Top 10
        countries = dict(sorted(
            self._countries[code].items(), key=lambda x: x[1], reverse=True
        )[:10])
        
        return {
            "code": code,
            "total_clicks": sum(daily.values()),
            "daily_clicks": daily,
            "top_referers": referers,
            "top_countries": countries,
        }


# ============================================================================
# URL Validation
# ============================================================================

def validate_url(url: str) -> str:
    """Validate and normalize URL."""
    url = url.strip()
    
    # Must have scheme
    if not url.startswith(("http://", "https://")):
        raise ValueError("URL must start with http:// or https://")
    
    try:
        parsed = urlparse(url)
    except Exception:
        raise ValueError("Invalid URL format")
    
    if not parsed.netloc:
        raise ValueError("URL has no domain")
    
    # Block common abuse patterns
    blocked_domains = {"localhost", "127.0.0.1", "0.0.0.0", "::1"}
    if parsed.netloc.split(":")[0].lower() in blocked_domains:
        raise ValueError("Localhost URLs not allowed")
    
    return url


# ============================================================================
# FastAPI Application
# ============================================================================

app = FastAPI(title="URL Shortener", version="1.0")

# Global stores (in production: inject via dependency injection)
link_store = LinkStore()
cache = RedisLikeCache()
analytics = ClickAnalyticsStore()
code_gen = CodeGenerator()

# Async event queue (in production: Kafka producer)
event_queue: deque = deque(maxlen=10_000)


# ---- Request/Response models ----

class ShortenRequest(BaseModel):
    url: str
    custom_alias: Optional[str] = None
    expires_in_days: Optional[int] = None
    idempotency_key: Optional[str] = None
    
    @validator("url")
    def validate_url_field(cls, v):
        return validate_url(v)
    
    @validator("custom_alias")
    def validate_alias(cls, v):
        if v is None:
            return v
        if not re.match(r'^[a-zA-Z0-9_-]{3,20}$', v):
            raise ValueError("Custom alias must be 3-20 chars (alphanumeric, - or _)")
        return v


class ShortenResponse(BaseModel):
    short_url: str
    code: str
    long_url: str
    expires_at: Optional[str] = None


# ---- Endpoints ----

@app.post("/shorten", response_model=ShortenResponse, status_code=201)
async def shorten_url(req: ShortenRequest):
    """
    Create a short URL.
    
    Idempotency: same idempotency_key always returns same code.
    Custom alias: use provided alias instead of auto-generated code.
    Expiration: link auto-expires after N days.
    """
    # Determine code
    if req.custom_alias:
        code = req.custom_alias
    else:
        code = code_gen.next_code()
    
    # Set expiration
    expires_at = None
    if req.expires_in_days:
        expires_at = time.time() + req.expires_in_days * 86400
    
    link = LinkRecord(
        code=code,
        long_url=req.url,
        expires_at=expires_at,
        custom_alias=req.custom_alias is not None,
    )
    
    try:
        link = link_store.create(link, idempotency_key=req.idempotency_key)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    
    # Warm up cache
    cache.set(f"link:{code}", req.url, ttl_seconds=3600)
    
    base_url = "http://localhost:8000"
    return ShortenResponse(
        short_url=f"{base_url}/{link.code}",
        code=link.code,
        long_url=link.long_url,
        expires_at=datetime.fromtimestamp(expires_at).isoformat() if expires_at else None
    )


@app.get("/{code}")
async def redirect(code: str, request: Request, background_tasks: BackgroundTasks):
    """
    Redirect short code to long URL.
    
    Hot path:  cache hit -> 302 redirect (no DB)
    Warm path: cache miss -> DB lookup -> cache -> 302 redirect
    Cold path: not found -> 404
    Expired:   expired link -> 410 Gone
    """
    # Cache-aside: check cache first
    cached_url = cache.get(f"link:{code}")
    
    if cached_url:
        # Fast path: cache hit
        background_tasks.add_task(
            _record_click, code, request
        )
        return RedirectResponse(url=cached_url, status_code=302)
    
    # Cache miss: check if expired first
    if link_store.is_expired(code):
        raise HTTPException(
            status_code=410,
            detail="This link has expired."
        )
    
    # DB lookup
    link = link_store.get(code)
    
    if not link:
        raise HTTPException(status_code=404, detail="Short URL not found")
    
    # Repopulate cache (cache-aside pattern)
    cache.set(f"link:{code}", link.long_url, ttl_seconds=3600)
    
    # Record click asynchronously (does NOT block redirect)
    background_tasks.add_task(_record_click, code, request)
    
    return RedirectResponse(url=link.long_url, status_code=302)


async def _record_click(code: str, request: Request) -> None:
    """
    Async click recording. Never blocks the redirect response.
    In production: produce to Kafka topic "clicks".
    """
    event = ClickEvent(
        code=code,
        timestamp=time.time(),
        ip=request.client.host if request.client else "unknown",
        user_agent=request.headers.get("user-agent", ""),
        referer=request.headers.get("referer"),
        country=None,  # In production: GeoIP lookup via MaxMind
    )
    
    # Enqueue for async processing
    event_queue.append(event)
    
    # Also update click count in link store
    link_store.increment_clicks(code)
    
    # Immediately write to in-memory analytics (simulates Kafka consumer)
    analytics.record(event)


@app.get("/analytics/{code}")
async def get_analytics(code: str):
    """Get click analytics for a short URL."""
    link = link_store.get(code)
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    
    stats = analytics.get_stats(code)
    stats["long_url"] = link.long_url
    stats["created_at"] = datetime.fromtimestamp(link.created_at).isoformat()
    
    return stats


@app.get("/api/info/{code}")
async def get_link_info(code: str):
    """Get metadata for a short link without redirecting."""
    link = link_store.get(code)
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    
    return {
        "code": link.code,
        "long_url": link.long_url,
        "created_at": datetime.fromtimestamp(link.created_at).isoformat(),
        "expires_at": (datetime.fromtimestamp(link.expires_at).isoformat()
                       if link.expires_at else None),
        "click_count": link.click_count,
        "custom_alias": link.custom_alias,
    }


@app.delete("/api/links/{code}", status_code=204)
async def delete_link(code: str):
    """Delete a short link. In production: requires auth."""
    link = link_store.get(code)
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    
    link_store._links.pop(code, None)
    cache.delete(f"link:{code}")
    return None


# ============================================================================
# Run
# ============================================================================

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
```

---

## Testing

```bash
# Run the server
uv run url_shortener.py

# Shorten a URL
curl -s -X POST http://localhost:8000/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.example.com/very/long/path?query=param&other=value"}' | jq .
# {
#   "short_url": "http://localhost:8000/4c92a3b",
#   "code": "4c92a3b",
#   "long_url": "https://www.example.com/very/long/path?query=param&other=value",
#   "expires_at": null
# }

# Redirect
curl -L http://localhost:8000/4c92a3b
# Follows redirect to https://www.example.com/...

# Custom alias
curl -s -X POST http://localhost:8000/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com", "custom_alias": "gh"}' | jq .

curl -L http://localhost:8000/gh

# Expiring link
curl -s -X POST http://localhost:8000/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/sale", "expires_in_days": 7}' | jq .

# Idempotent create (same key, same result)
curl -s -X POST http://localhost:8000/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "idempotency_key": "req-001"}' | jq .code
curl -s -X POST http://localhost:8000/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "idempotency_key": "req-001"}' | jq .code
# Both return same code!

# Analytics
curl -s http://localhost:8000/analytics/4c92a3b | jq .

# Load test redirects
ab -n 1000 -c 50 http://localhost:8000/4c92a3b
```

---

## Analytics Pipeline (Production Design)

```text
Click Event Flow:
─────────────────────────────────────────────────────────────────
Redirect Server  
  -> fire-and-forget to Kafka topic "clicks" (non-blocking)
     {code, ts, ip, user_agent, referer, geo}

Kafka Consumer (Analytics Aggregator):
  -> Consume in micro-batches (1000 events or 1 sec)
  -> Parse user-agent (bot detection)
  -> GeoIP lookup for country
  -> Write to ClickHouse:
       clicks_raw(code, ts, ip, country, referer, ua)

ClickHouse Materialized Views (auto-updated on INSERT):
  -> clicks_daily(code, date, count)
  -> clicks_by_referer(code, referer, count)
  -> clicks_by_country(code, country, count)

Analytics Query API:
  SELECT date, sum(count) FROM clicks_daily
  WHERE code = ? AND date >= today() - 30
  GROUP BY date ORDER BY date

Response time: <100ms (ClickHouse columnar scan is very fast)
─────────────────────────────────────────────────────────────────

Why Kafka?
- Redirect critical path: sub-10ms. Analytics is non-critical.
- Kafka decouples: if analytics DB is slow, redirects still work.
- Kafka retains events: can replay to rebuild analytics.
- Consumer can batch-write to ClickHouse (1000 events/write vs 1/redirect).
```

---

## Bloom Filter for Fast 404s

```python
# bloom_filter.py - Prevent DB lookups for non-existent codes
# In production: use Redis Bloom (RedisBloom module)

import math
import mmh3  # MurmurHash3 - better distribution than SHA

class BloomFilter:
    """
    Probabilistic data structure: "definitely not in set" or "probably in set".
    
    Space-efficient: 10M items at 1% false positive rate = ~12MB
    vs Set which would need ~400MB for same 10M items.
    
    Use case: Check if a short code EXISTS before hitting DB.
    - Bloom says "no" -> definitely 404, skip DB
    - Bloom says "maybe" -> check DB (may still 404 if false positive)
    
    Trade-off: ~1% false positives (extra DB lookups), 0% false negatives.
    """
    
    def __init__(self, capacity: int = 10_000_000, false_positive_rate: float = 0.01):
        # Calculate optimal bit array size and hash count
        m = -capacity * math.log(false_positive_rate) / (math.log(2) ** 2)
        k = m / capacity * math.log(2)
        
        self.size = int(m)
        self.hash_count = int(k)
        self.bit_array = bytearray(self.size // 8 + 1)
        
        print(f"Bloom filter: {self.size:,} bits ({self.size//8//1024} KB), "
              f"{self.hash_count} hash functions")
    
    def _get_bit(self, pos: int) -> bool:
        return bool(self.bit_array[pos // 8] & (1 << (pos % 8)))
    
    def _set_bit(self, pos: int) -> None:
        self.bit_array[pos // 8] |= (1 << (pos % 8))
    
    def add(self, item: str) -> None:
        for seed in range(self.hash_count):
            position = mmh3.hash(item, seed) % self.size
            self._set_bit(abs(position))
    
    def might_contain(self, item: str) -> bool:
        """Returns False if definitely not in set. True = maybe in set."""
        return all(
            self._get_bit(abs(mmh3.hash(item, seed) % self.size))
            for seed in range(self.hash_count)
        )


# Usage in redirect endpoint:
# bloom = BloomFilter()
# # On startup: add all existing codes to bloom filter
# for code in link_store._links:
#     bloom.add(code)
# 
# # In redirect handler:
# if not bloom.might_contain(code):
#     raise HTTPException(status_code=404)  # Fast path, no DB
# # else: check DB (might be false positive)
```

---

## Key Learning Points

```text
1. Code generation strategies:
   Counter-based: no collisions, predictable, but sequential (guessable)
   Hash-based: random-looking, ~1 collision per 3.5T URLs (acceptable)
   
2. Cache-aside pattern:
   READ: check cache first; on miss, read DB, write to cache
   WRITE: write to DB, invalidate (or update) cache
   Never write to cache without writing to DB first!

3. Idempotency: same request key -> same response
   Critical for: mobile apps that retry on network failure
   Implementation: store (idempotency_key -> result) in DB
   
4. Async click tracking:
   Never block the redirect (200ms analytics vs 10ms redirect)
   Use background_tasks (FastAPI) or Kafka producer
   Kafka gives durability + replay capability

5. Analytics design:
   Raw events (ClickHouse) -> materialized views -> aggregated queries
   Don't query raw events for dashboards (too slow at scale)
   Pre-aggregate with hourly/daily rollup jobs

6. Bloom filter optimization:
   Most 404s are for non-existent codes (scrapers, typos, expired links)
   Bloom filter catches them in memory before hitting DB
   False positive rate: 1% (acceptable extra DB lookups)
   Memory: ~12MB for 10M codes (vs ~400MB for a HashSet)
```
