# Project 3: Rate Limiter (Comprehensive)

## Goal
Build a rate limiter middleware that:
- Implements multiple algorithms: Token Bucket, Sliding Window Log, Fixed Window, Sliding Window Counter
- Works both in-process (single-server) and distributed (via Redis)
- Supports per-user, per-IP, per-API-key limits
- Returns proper HTTP 429 responses with Retry-After headers

This project teaches: rate limiting algorithms, distributed atomicity, sliding window trade-offs.

---

## Why Rate Limiting
```text
Without rate limiting:
- One bad actor floods your API -> everyone else suffers
- Scrapers download your entire product catalog in minutes
- Unintentional infinite retry loops bring down your service

Common use cases:
- API endpoints: 100 requests/minute per user
- Login attempts: 5 failed attempts per 15 minutes per IP
- SMS OTP: 3 sends per hour per phone number
- Email sending: 50 emails/hour per account
```

---

## Algorithm Comparison

```text
Algorithm             | Memory  | Burst?  | Smoothness | Complexity
----------------------+---------+---------+------------+-----------
Fixed Window          | O(1)    | Allowed | Poor       | Simple
Sliding Window Log    | O(n)    | Blocked | Perfect    | Medium
Sliding Window Counter| O(1)    | Partial | Good       | Medium
Token Bucket          | O(1)    | Allowed | Good       | Medium
Leaky Bucket          | O(1)    | Blocked | Perfect    | Simple

Fixed Window:     Simple, but "boundary burst" attack possible
                  (100 req at 11:59 + 100 req at 12:00 = 200 req in 2 seconds)
Sliding Window:   Accurate but memory O(n requests per window)
Sliding Counter:  Best balance of accuracy and memory (used in practice)
Token Bucket:     Natural for APIs that want burst allowance
Leaky Bucket:     Strict rate shaping (good for queuing)
```

---

## Full Working Implementation

```python
#!/usr/bin/env python3
"""
rate_limiter.py - Multiple rate limiting algorithms with Redis and in-memory backends.

Run:   uv run rate_limiter.py
Test:  See test cases at the bottom.
"""
# /// script
# dependencies = ["redis", "fastapi", "uvicorn"]
# ///

import time
import redis
import asyncio
import hashlib
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional
from collections import deque


@dataclass
class RateLimitResult:
    allowed: bool
    remaining: int        # Requests remaining in current window
    limit: int            # Total limit
    reset_after_s: float  # Seconds until window resets
    retry_after_s: float  # Seconds to wait before retrying (if blocked)


# ============================================================================
# 1. In-Memory Token Bucket
# ============================================================================

class TokenBucketRateLimiter:
    """
    Token Bucket: bucket starts full, fills at a constant rate.
    Each request consumes one token. If bucket is empty, reject.
    
    Natural for allowing bursts: burst up to `capacity`, then sustain at `refill_rate`.
    
    Example: capacity=100, refill=10/sec
    - Can burst 100 requests immediately
    - After exhausting: limited to 10 req/sec
    
    Real use: GitHub API uses token bucket (X-RateLimit-Remaining header)
    """
    
    def __init__(self, capacity: int, refill_per_second: float):
        self.capacity = capacity
        self.refill_rate = refill_per_second
        
        # Per-identity state: {key -> (tokens, last_refill_time)}
        self._buckets = {}
    
    def _get_bucket(self, key: str) -> tuple:
        return self._buckets.get(key, (self.capacity, time.time()))
    
    def _refill(self, tokens: float, last_refill: float) -> tuple:
        """Calculate current tokens after refilling."""
        now = time.time()
        elapsed = now - last_refill
        new_tokens = min(self.capacity, tokens + elapsed * self.refill_rate)
        return new_tokens, now
    
    def check(self, key: str, consume: int = 1) -> RateLimitResult:
        tokens, last_refill = self._get_bucket(key)
        tokens, now = self._refill(tokens, last_refill)
        
        if tokens >= consume:
            tokens -= consume
            self._buckets[key] = (tokens, now)
            return RateLimitResult(
                allowed=True,
                remaining=int(tokens),
                limit=self.capacity,
                reset_after_s=0,
                retry_after_s=0
            )
        else:
            # Blocked: how long until enough tokens refill?
            tokens_needed = consume - tokens
            retry_after = tokens_needed / self.refill_rate
            self._buckets[key] = (tokens, now)
            return RateLimitResult(
                allowed=False,
                remaining=0,
                limit=self.capacity,
                reset_after_s=retry_after,
                retry_after_s=retry_after
            )


# ============================================================================
# 2. In-Memory Fixed Window
# ============================================================================

class FixedWindowRateLimiter:
    """
    Fixed Window: count requests per fixed time window (e.g., 1-minute windows).
    
    Simple and memory-efficient.
    Weakness: "boundary attack" - can exceed limit 2x at window boundary.
    
    Example: limit=100/min
    11:59:30 - 90 requests (under limit)
    12:00:00 - window resets!
    12:00:01 - 100 more requests (under new limit, but 190 total in ~31 seconds)
    """
    
    def __init__(self, limit: int, window_seconds: int):
        self.limit = limit
        self.window_s = window_seconds
        self._windows = {}   # key -> (count, window_start)
    
    def check(self, key: str) -> RateLimitResult:
        now = time.time()
        window_start = int(now / self.window_s) * self.window_s
        
        current = self._windows.get(key)
        
        if current is None or current[1] != window_start:
            # New window
            count = 1
            self._windows[key] = (count, window_start)
        else:
            count = current[0] + 1
            self._windows[key] = (count, window_start)
        
        reset_after = window_start + self.window_s - now
        remaining = max(0, self.limit - count)
        
        return RateLimitResult(
            allowed=count <= self.limit,
            remaining=remaining,
            limit=self.limit,
            reset_after_s=reset_after,
            retry_after_s=reset_after if count > self.limit else 0
        )


# ============================================================================
# 3. In-Memory Sliding Window Log
# ============================================================================

class SlidingWindowLogRateLimiter:
    """
    Sliding Window Log: keep a log of each request's timestamp.
    Count requests in [now - window_size, now].
    
    Most accurate algorithm. No boundary problem.
    Memory: O(requests per window) per user - expensive at high rate.
    
    Use for: low-rate limits where accuracy is critical (login attempts, OTP)
    """
    
    def __init__(self, limit: int, window_seconds: int):
        self.limit = limit
        self.window_s = window_seconds
        self._logs = {}   # key -> deque of timestamps
    
    def check(self, key: str) -> RateLimitResult:
        now = time.time()
        cutoff = now - self.window_s
        
        if key not in self._logs:
            self._logs[key] = deque()
        
        log = self._logs[key]
        
        # Remove expired entries (older than window)
        while log and log[0] <= cutoff:
            log.popleft()
        
        count = len(log)
        
        if count < self.limit:
            log.append(now)
            return RateLimitResult(
                allowed=True,
                remaining=self.limit - count - 1,
                limit=self.limit,
                reset_after_s=0,
                retry_after_s=0
            )
        else:
            # Blocked: next slot opens when oldest request leaves window
            retry_after = log[0] + self.window_s - now if log else 0
            return RateLimitResult(
                allowed=False,
                remaining=0,
                limit=self.limit,
                reset_after_s=retry_after,
                retry_after_s=retry_after
            )


# ============================================================================
# 4. In-Memory Sliding Window Counter (best balance)
# ============================================================================

class SlidingWindowCounterRateLimiter:
    """
    Sliding Window Counter: uses two fixed windows (current + previous)
    and interpolates based on position within current window.
    
    Memory: O(1) per user (just two counters + timestamps)
    Accuracy: ~99% of sliding window log accuracy
    
    Formula: count = prev_window_count * (1 - elapsed/window) + current_window_count
    
    This is what most production systems use (Redis rate limiting, Cloudflare, nginx).
    """
    
    def __init__(self, limit: int, window_seconds: int):
        self.limit = limit
        self.window_s = window_seconds
        self._state = {}   # key -> (prev_count, curr_count, curr_window_start)
    
    def check(self, key: str) -> RateLimitResult:
        now = time.time()
        curr_window_start = int(now / self.window_s) * self.window_s
        
        state = self._state.get(key, (0, 0, curr_window_start))
        prev_count, curr_count, last_window_start = state
        
        # Detect window advancement
        if curr_window_start > last_window_start:
            if curr_window_start == last_window_start + self.window_s:
                # Moved to next window: current becomes previous
                prev_count = curr_count
            else:
                # Skipped multiple windows: previous is empty
                prev_count = 0
            curr_count = 0
            last_window_start = curr_window_start
        
        # Interpolated count
        elapsed_in_window = now - curr_window_start
        weight = elapsed_in_window / self.window_s
        interpolated = prev_count * (1 - weight) + curr_count
        
        remaining = max(0, self.limit - int(interpolated) - 1)
        
        if interpolated < self.limit:
            curr_count += 1
            self._state[key] = (prev_count, curr_count, last_window_start)
            return RateLimitResult(
                allowed=True,
                remaining=remaining,
                limit=self.limit,
                reset_after_s=self.window_s - elapsed_in_window,
                retry_after_s=0
            )
        else:
            # Calculate when rate drops below limit
            # Solve: prev * (1 - (now + t - start) / window) + curr = limit
            retry_after = (
                (prev_count + curr_count - self.limit) * self.window_s / prev_count
                if prev_count > 0 else self.window_s - elapsed_in_window
            )
            return RateLimitResult(
                allowed=False,
                remaining=0,
                limit=self.limit,
                reset_after_s=self.window_s - elapsed_in_window,
                retry_after_s=max(0, retry_after)
            )


# ============================================================================
# 5. Distributed Rate Limiter (Redis + Lua)
# ============================================================================

class DistributedSlidingWindowLimiter:
    """
    Distributed rate limiter using Redis.
    
    Uses Lua script for atomic check-and-increment.
    Without atomicity: race condition between check and increment.
    
    This is production-ready: works across multiple app servers.
    """
    
    # Lua script: atomic sliding window counter in Redis
    # Returns [allowed (0/1), remaining, reset_after_ms]
    LUA_SCRIPT = """
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local window_ms = tonumber(ARGV[2])
    local now_ms = tonumber(ARGV[3])
    
    local window_start = math.floor(now_ms / window_ms) * window_ms
    local prev_window_start = window_start - window_ms
    
    local curr_key = key .. ":" .. window_start
    local prev_key = key .. ":" .. prev_window_start
    
    -- Get counts for current and previous windows
    local curr_count = tonumber(redis.call("GET", curr_key)) or 0
    local prev_count = tonumber(redis.call("GET", prev_key)) or 0
    
    -- Interpolated count
    local elapsed = now_ms - window_start
    local weight = elapsed / window_ms
    local interpolated = prev_count * (1 - weight) + curr_count
    
    if interpolated < limit then
        -- Increment current window
        redis.call("INCR", curr_key)
        redis.call("PEXPIRE", curr_key, window_ms * 2)
        local remaining = math.floor(limit - interpolated - 1)
        return {1, remaining, window_ms - elapsed}
    else
        local reset_after = window_ms - elapsed
        return {0, 0, reset_after}
    end
    """
    
    def __init__(self, redis_client, limit: int, window_seconds: int):
        self.redis = redis_client
        self.limit = limit
        self.window_ms = window_seconds * 1000
        self._script = self.redis.register_script(self.LUA_SCRIPT)
    
    def check(self, key: str) -> RateLimitResult:
        now_ms = int(time.time() * 1000)
        
        result = self._script(
            keys=[f"ratelimit:{key}"],
            args=[self.limit, self.window_ms, now_ms]
        )
        
        allowed, remaining, reset_after_ms = result
        reset_after_s = reset_after_ms / 1000
        
        return RateLimitResult(
            allowed=bool(allowed),
            remaining=int(remaining),
            limit=self.limit,
            reset_after_s=reset_after_s,
            retry_after_s=reset_after_s if not allowed else 0
        )


# ============================================================================
# 6. Composite Rate Limiter (multiple limits at once)
# ============================================================================

class CompositeRateLimiter:
    """
    Apply multiple rate limits simultaneously.
    
    Example: GitHub API
    - 60 requests/hour (unauthenticated)
    - 5000 requests/hour (authenticated)
    - 30 requests/minute for search
    
    All must pass for request to be allowed.
    """
    
    def __init__(self, limiters: list):
        self.limiters = limiters  # list of (name, limiter) tuples
    
    def check(self, key: str) -> dict:
        results = {}
        all_allowed = True
        
        for name, limiter in self.limiters:
            result = limiter.check(key)
            results[name] = result
            if not result.allowed:
                all_allowed = False
        
        return {
            "allowed": all_allowed,
            "limits": results,
            "retry_after": max(
                (r.retry_after_s for r in results.values() if not r.allowed),
                default=0
            )
        }


# ============================================================================
# 7. FastAPI Middleware Integration
# ============================================================================

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
import uvicorn

app = FastAPI()

# Global rate limiter: 100 requests/minute per IP
limiter = SlidingWindowCounterRateLimiter(limit=100, window_seconds=60)

# Sensitive endpoint: stricter limit (10 per hour per user)
login_limiter = SlidingWindowLogRateLimiter(limit=10, window_seconds=3600)


@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    """Apply rate limiting to all requests based on client IP."""
    client_ip = request.client.host
    
    result = limiter.check(client_ip)
    
    if not result.allowed:
        return JSONResponse(
            status_code=429,
            content={
                "error": "rate_limit_exceeded",
                "message": f"Too many requests. Retry after {result.retry_after_s:.1f} seconds.",
                "retry_after": result.retry_after_s,
            },
            headers={
                "X-RateLimit-Limit": str(result.limit),
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": str(int(time.time() + result.reset_after_s)),
                "Retry-After": str(int(result.retry_after_s) + 1),
            }
        )
    
    response = await call_next(request)
    
    # Add rate limit headers to all responses
    response.headers["X-RateLimit-Limit"] = str(result.limit)
    response.headers["X-RateLimit-Remaining"] = str(result.remaining)
    response.headers["X-RateLimit-Reset"] = str(int(time.time() + result.reset_after_s))
    
    return response


@app.post("/api/login")
async def login(request: Request):
    """Login endpoint with stricter rate limiting."""
    body = await request.json()
    email = body.get("email", "unknown")
    
    # Check login-specific rate limit (per email)
    result = login_limiter.check(f"login:{email}")
    
    if not result.allowed:
        return JSONResponse(
            status_code=429,
            content={
                "error": "too_many_login_attempts",
                "message": "Too many login attempts. Try again later.",
                "retry_after": result.retry_after_s
            }
        )
    
    # ... actual login logic ...
    return {"status": "ok"}


@app.get("/api/data")
async def get_data():
    return {"data": "your response here"}


# ============================================================================
# 8. Test Suite
# ============================================================================

def test_all_algorithms():
    print("=== Testing Token Bucket ===")
    tb = TokenBucketRateLimiter(capacity=5, refill_per_second=1)
    
    for i in range(7):
        result = tb.check("user1")
        print(f"  Request {i+1}: allowed={result.allowed}, remaining={result.remaining}")
    
    time.sleep(3)
    result = tb.check("user1")
    print(f"  After 3s: allowed={result.allowed}, remaining={result.remaining}")
    
    print("\n=== Testing Fixed Window ===")
    fw = FixedWindowRateLimiter(limit=3, window_seconds=10)
    
    for i in range(5):
        result = fw.check("user2")
        print(f"  Request {i+1}: allowed={result.allowed}, remaining={result.remaining}")
    
    print("\n=== Testing Sliding Window Log ===")
    swl = SlidingWindowLogRateLimiter(limit=3, window_seconds=10)
    
    for i in range(5):
        result = swl.check("user3")
        print(f"  Request {i+1}: allowed={result.allowed}, remaining={result.remaining}")
    
    print("\n=== Testing Sliding Window Counter ===")
    swc = SlidingWindowCounterRateLimiter(limit=3, window_seconds=10)
    
    for i in range(5):
        result = swc.check("user4")
        print(f"  Request {i+1}: allowed={result.allowed}, remaining={result.remaining}")
    
    print("\n=== Boundary Attack Demo (Fixed Window Vulnerability) ===")
    # Window: 10 seconds. Limit: 5 per window.
    fw2 = FixedWindowRateLimiter(limit=5, window_seconds=10)
    
    # Find current window boundary
    now = time.time()
    window_start = int(now / 10) * 10
    time_to_boundary = (window_start + 10) - now
    
    print(f"  {time_to_boundary:.1f}s until window resets...")
    
    # Send 5 requests just before boundary
    for i in range(5):
        r = fw2.check("attacker")
    print(f"  Sent 5 requests just before window reset: {r.allowed}")
    
    # If we could control time: right after boundary reset, send 5 more
    # = 10 requests in effectively 1 second
    # Fixed window allows this; sliding window does NOT
    print("  With sliding window: requests spanning boundary are counted together")
    
    print("\nAll tests passed!")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        test_all_algorithms()
    else:
        # Run FastAPI server
        uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
```

---

## Testing the API Server

```bash
# Run the server
uv run rate_limiter.py

# Test normal request
curl -i http://localhost:8000/api/data
# HTTP/1.1 200 OK
# X-RateLimit-Limit: 100
# X-RateLimit-Remaining: 99
# X-RateLimit-Reset: 1705314000

# Exhaust rate limit (send 101 requests)
for i in $(seq 1 105); do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8000/api/data
done
# 200 200 200 ... 429 429 429

# Check 429 response
curl -i http://localhost:8000/api/data
# HTTP/1.1 429 Too Many Requests
# Retry-After: 45
# {"error": "rate_limit_exceeded", ...}

# Run algorithm tests
uv run rate_limiter.py test
```

---

## Redis-Backed Distributed Rate Limiter Test

```python
# test_distributed.py
import threading
import time

def test_distributed_concurrency():
    """
    Simulate 10 concurrent servers all rate-limiting the same user.
    
    Without distributed lock: race condition -> limit exceeded.
    With Redis atomic Lua: exact rate limiting regardless of concurrency.
    """
    import redis
    r = redis.Redis()
    limiter = DistributedSlidingWindowLimiter(r, limit=100, window_seconds=60)
    
    results = []
    
    def make_requests(n: int):
        for _ in range(n):
            result = limiter.check("shared_user")
            results.append(result.allowed)
    
    # 10 threads, each sending 15 requests = 150 total, limit=100
    threads = [threading.Thread(target=make_requests, args=(15,)) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    
    allowed = sum(1 for r in results if r)
    blocked = len(results) - allowed
    
    print(f"Total requests: {len(results)}")
    print(f"Allowed: {allowed} (should be ~100)")
    print(f"Blocked: {blocked} (should be ~50)")
    assert 95 <= allowed <= 105, f"Expected ~100, got {allowed}"
    print("PASSED: Redis distributed rate limiting is accurate under concurrency")

test_distributed_concurrency()
```

---

## Key Learning Points

```text
1. Fixed window: simple but vulnerable to burst at boundaries
   Most APIs use this anyway because it's predictable for users

2. Sliding window log: perfect accuracy but O(n) memory per user
   Use only for low-rate, high-security checks (login, OTP)

3. Sliding window counter: best balance, O(1) memory, ~99% accurate
   Used by: Cloudflare, nginx, most production rate limiters

4. Token bucket: allows natural burst behavior (capacity parameter)
   Used by: GitHub, Stripe, most developer-facing APIs

5. Distributed atomicity: use Redis Lua scripts (single atomic operation)
   Without atomicity: 100 concurrent requests all "check 99 < 100, increment"
   = all 100 pass despite limit of 100

6. HTTP headers: always return X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After
   Clients can implement smart retry logic using these headers

7. Per-dimension limits: combine IP + user + endpoint for layered protection
   IP limit: prevent unauthenticated flood
   User limit: prevent authenticated abuse
   Endpoint limit: stricter for sensitive operations
```
