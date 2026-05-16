# Part 4: Core Components (Deep)

## 1) Caching

### Intuition
Caching is the principle of keeping frequently-needed, expensive-to-compute data in a faster storage layer so you don't have to compute or fetch it again.

**Analogy:** A student keeps their most-used textbooks on their desk (L1 cache), less-used ones on a nearby shelf (L2 cache), and rarely-needed books in the library (database). Fetching from the desk is instant; going to the library takes 10 minutes.

### Why databases become bottlenecks
```text
Operation           Typical Latency
------------------------------------------
Redis GET           < 1ms (in-memory)
Postgres INDEX scan  1-5ms (cached pages)
Postgres full scan  10-100ms (disk I/O)
Network round trip   1-50ms (geographic)
```
If your API makes 5 DB calls at 5ms each = 25ms just in DB time. With caching, those become 5 Redis calls at < 1ms each = < 5ms.

### Cache patterns

**Cache-aside (most common)**
```javascript
// Node.js with Redis - Cache-aside pattern
const redis = require('redis');
const client = redis.createClient({ url: 'redis://localhost:6379' });

async function getUserWithCache(userId) {
    const cacheKey = `user:${userId}`;
    
    // 1. Try cache first
    const cached = await client.get(cacheKey);
    if (cached) {
        return { source: 'cache', data: JSON.parse(cached) };
    }
    
    // 2. Cache miss: fetch from database
    const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) return null;
    
    // 3. Populate cache with TTL + jitter
    // Jitter prevents cache stampede (all items expiring at same second)
    const ttl = 300 + Math.floor(Math.random() * 60);  // 300-360 seconds
    await client.setEx(cacheKey, ttl, JSON.stringify(user));
    
    return { source: 'db', data: user };
}
```

**Write-through (strong consistency)**
```javascript
// Write to DB and cache atomically
async function updateUser(userId, updates) {
    // 1. Write to database (source of truth)
    const user = await db.query(
        'UPDATE users SET name=$1 WHERE id=$2 RETURNING *',
        [updates.name, userId]
    );
    
    // 2. Immediately update cache
    await client.setEx(`user:${userId}`, 300, JSON.stringify(user));
    
    return user;
    // Benefit: no cache miss on next read
    // Cost: write is slower (must update both DB and cache)
}
```

**Write-back (dangerous, use carefully)**
```python
# Write-back: acknowledge write after updating cache only, DB updated later
# RISK: if cache node fails before DB sync -> DATA LOSS
# Only use for non-critical data (view counts, approximate metrics)

class WriteBackCache:
    def __init__(self):
        self.pending_writes = {}  # key -> (value, timestamp)
    
    def write(self, key: str, value: dict) -> None:
        # Return to client immediately (fast!)
        self.pending_writes[key] = (value, time.time())
        # Schedule async DB write
        asyncio.create_task(self._flush_to_db(key, value))
    
    async def _flush_to_db(self, key: str, value: dict) -> None:
        await asyncio.sleep(5)  # Batch up writes for 5 seconds
        await db.upsert(key, value)
        del self.pending_writes[key]
```

### Cache stampede (thundering herd) protection
```javascript
// Problem: 10,000 requests arrive when popular key expires
// All find cache miss, all hit database simultaneously -> crash

// Solution 1: Single-flight (coalescing duplicate requests)
const inflight = new Map();

async function getWithSingleFlight(key) {
    const cacheKey = `data:${key}`;
    
    // Check cache
    const cached = await client.get(cacheKey);
    if (cached) return JSON.parse(cached);
    
    // Check if there's already an inflight request for this key
    if (inflight.has(key)) {
        return inflight.get(key);  // Return the same pending promise
    }
    
    // Create the DB fetch promise and share it
    const promise = db.query('SELECT * FROM data WHERE key=$1', [key])
        .then(result => {
            client.setEx(cacheKey, 300, JSON.stringify(result));
            inflight.delete(key);
            return result;
        });
    
    inflight.set(key, promise);
    return promise;
    // All 10,000 concurrent requests get the SAME promise
    // DB is called exactly ONCE
}

// Solution 2: Probabilistic early expiration (prevent stampede before it happens)
async function getWithEarlyRefresh(key, ttl) {
    const data = await client.hGetAll(`data:${key}`);
    if (!data.value) return await refreshCache(key, ttl);
    
    const expiresAt = parseInt(data.expiresAt);
    const timeRemaining = expiresAt - Date.now();
    
    // Probabilistically refresh when < 10% TTL remains
    // Beta parameter controls how aggressively to refresh early
    const beta = 1.0;
    if (timeRemaining < ttl * 0.1 * Math.log(Math.random()) * -beta) {
        // Refresh in background (non-blocking)
        setImmediate(() => refreshCache(key, ttl));
    }
    
    return JSON.parse(data.value);
}
```

### Cache eviction policies
```python
class LRUCache:
    """
    Least Recently Used: evict the item that was accessed longest ago.
    Good for: general-purpose caching, user sessions, web pages.
    Bad for: workloads where old items are frequently accessed (not "least recently used").
    """
    from collections import OrderedDict
    
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.cache = {}  # key -> value
        self.order = []  # [most_recent, ..., least_recent]
    
    def get(self, key: str):
        if key not in self.cache:
            return None
        # Move to front (most recently used)
        self.order.remove(key)
        self.order.insert(0, key)
        return self.cache[key]
    
    def put(self, key: str, value) -> None:
        if key in self.cache:
            self.order.remove(key)
        elif len(self.cache) >= self.capacity:
            # Evict least recently used (last in list)
            evict_key = self.order.pop()
            del self.cache[evict_key]
        self.cache[key] = value
        self.order.insert(0, key)


class LFUCache:
    """
    Least Frequently Used: evict the item accessed fewest times.
    Good for: workloads where popular items stay popular (Zipf distribution).
    Bad for: recently added items that haven't had chance to accumulate hits.
    Redis uses an approximation of LFU with access frequency tracking.
    """
    from collections import defaultdict
    
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.key_freq = {}      # key -> frequency
        self.freq_keys = defaultdict(set)  # frequency -> set of keys
        self.min_freq = 0
        self.cache = {}
    
    def get(self, key: str):
        if key not in self.cache:
            return None
        self._update_freq(key)
        return self.cache[key]
    
    def put(self, key: str, value) -> None:
        if self.capacity <= 0:
            return
        if key in self.cache:
            self.cache[key] = value
            self._update_freq(key)
            return
        if len(self.cache) >= self.capacity:
            # Evict key with minimum frequency
            evict_key = next(iter(self.freq_keys[self.min_freq]))
            self.freq_keys[self.min_freq].discard(evict_key)
            del self.cache[evict_key]
            del self.key_freq[evict_key]
        self.cache[key] = value
        self.key_freq[key] = 1
        self.freq_keys[1].add(key)
        self.min_freq = 1
    
    def _update_freq(self, key: str):
        freq = self.key_freq[key]
        self.freq_keys[freq].discard(key)
        if not self.freq_keys[freq] and freq == self.min_freq:
            self.min_freq += 1
        self.key_freq[key] = freq + 1
        self.freq_keys[freq + 1].add(key)
```

### Cache invalidation strategies
```python
# Strategy 1: TTL-based expiration (simple, eventual consistency)
client.setex("user:123", 300, json.dumps(user))  # expires in 5 minutes

# Strategy 2: Event-driven invalidation (strong consistency)
# On user update, immediately delete cache key
async def handle_user_updated(event):
    user_id = event["user_id"]
    await client.delete(f"user:{user_id}")
    # Next read will be a cache miss -> fresh data from DB

# Strategy 3: Versioned keys (atomic consistency, no invalidation needed)
def get_user(user_id: str, version: int = None) -> dict:
    if version is None:
        version = get_current_version(user_id)
    return client.get(f"user:{user_id}:v{version}")

def update_user(user_id: str, updates: dict) -> dict:
    new_version = increment_version(user_id)  # atomic counter
    user = db.update(user_id, updates)
    client.setex(f"user:{user_id}:v{new_version}", 300, json.dumps(user))
    return user
# Old versions naturally expire; no race conditions
```

---

## 2) Rate Limiting

### Why rate limiting
- Prevent abuse (DDoS, brute force login)
- Ensure fair usage across tenants
- Protect backend services from overload
- Enforce business quotas (API tier limits)

### Algorithm 1: Token Bucket
```javascript
// Token bucket: allows burst up to bucket size, then enforces steady rate
// Most intuitive and commonly used

class TokenBucket {
    constructor(ratePerSecond, maxBurst) {
        this.ratePerSecond = ratePerSecond;  // tokens added per second
        this.maxTokens = maxBurst;           // max tokens (burst capacity)
        this.tokens = maxBurst;              // current tokens
        this.lastRefill = Date.now();
    }
    
    tryConsume(tokensNeeded = 1) {
        this.refill();
        
        if (this.tokens < tokensNeeded) {
            return {
                allowed: false,
                retryAfterMs: ((tokensNeeded - this.tokens) / this.ratePerSecond) * 1000
            };
        }
        
        this.tokens -= tokensNeeded;
        return { allowed: true };
    }
    
    refill() {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1000;  // seconds
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.ratePerSecond);
        this.lastRefill = now;
    }
}

// Usage: 100 requests/second, burst up to 200
const limiter = new TokenBucket(100, 200);
const result = limiter.tryConsume(1);
if (!result.allowed) {
    return res.status(429).json({
        error: 'Rate limit exceeded',
        retryAfterMs: result.retryAfterMs
    });
}
```

### Algorithm 2: Sliding Window Counter (distributed-safe)
```python
import redis
import time

class SlidingWindowRateLimiter:
    """
    Uses Redis sorted set to implement sliding window.
    Each request is stored with its timestamp as the score.
    Count requests within the window by counting elements in [now-window, now].
    
    Pros: accurate, handles distributed servers
    Cons: uses more memory (stores each request timestamp)
    """
    
    def __init__(self, redis_client, window_seconds: int, max_requests: int):
        self.r = redis_client
        self.window = window_seconds
        self.max_requests = max_requests
    
    def is_allowed(self, identifier: str) -> tuple[bool, dict]:
        """
        identifier: e.g., "user:123" or "ip:1.2.3.4"
        Returns: (allowed, metadata)
        """
        key = f"ratelimit:{identifier}"
        now = time.time()
        window_start = now - self.window
        
        pipe = self.r.pipeline()
        
        # Remove requests outside the window
        pipe.zremrangebyscore(key, 0, window_start)
        
        # Count requests in current window
        pipe.zcard(key)
        
        # Add current request (use unique value to handle same-timestamp requests)
        pipe.zadd(key, {f"{now}:{id(pipe)}": now})
        
        # Set key expiry (cleanup)
        pipe.expire(key, self.window + 1)
        
        results = pipe.execute()
        current_count = results[1]  # count BEFORE this request
        
        if current_count >= self.max_requests:
            # Remove the request we just added (it's rejected)
            self.r.zremrangebyscore(key, now, now + 0.001)
            return False, {
                "limit": self.max_requests,
                "remaining": 0,
                "reset": int(window_start + self.window)
            }
        
        return True, {
            "limit": self.max_requests,
            "remaining": self.max_requests - current_count - 1,
            "reset": int(now + self.window)
        }

# Usage in Express middleware
limiter = SlidingWindowRateLimiter(redis_client, window_seconds=60, max_requests=100)

@app.before_request
def check_rate_limit():
    # Rate limit per user ID (authenticated) or IP (unauthenticated)
    identifier = f"user:{g.user_id}" if g.user_id else f"ip:{request.remote_addr}"
    allowed, meta = limiter.is_allowed(identifier)
    
    # Always return rate limit headers (good API practice)
    response_headers = {
        "X-RateLimit-Limit": str(meta["limit"]),
        "X-RateLimit-Remaining": str(meta["remaining"]),
        "X-RateLimit-Reset": str(meta["reset"]),
    }
    
    if not allowed:
        return jsonify({"error": "Rate limit exceeded"}), 429, response_headers
    
    g.rate_limit_headers = response_headers
```

### Algorithm 3: Fixed Window Counter (simplest, fast)
```python
def is_allowed_fixed_window(redis_client, key: str, max_requests: int, window_s: int) -> bool:
    """
    Simpler but has "double hit" problem at window boundaries.
    Attacker can make 100 requests at :59 and 100 at :01 (200 total in 2 seconds).
    
    Use when: approximate rate limiting is acceptable, simplicity preferred.
    """
    # Round current time to window boundary
    window_key = f"{key}:{int(time.time() // window_s)}"
    
    count = redis_client.incr(window_key)
    if count == 1:
        redis_client.expire(window_key, window_s)
    
    return count <= max_requests
```

### Distributed rate limiting
```python
# Problem: multiple API servers each with local rate limiter
# User can bypass by hitting different servers

# Solution: Centralized rate limiter with Redis
# All servers share the same Redis counter

# But: Redis call adds latency to every request!
# Optimization: local + global hybrid

class HybridRateLimiter:
    """
    Local counter: fast, no network call
    Global counter: accurate but adds Redis latency
    
    Strategy: check local first, periodically sync with global
    """
    
    def __init__(self, global_redis, local_quota=10, sync_interval_s=1):
        self.global_redis = global_redis
        self.local_quota = local_quota  # How many requests this server can serve locally
        self.sync_interval = sync_interval_s
        
        self.local_tokens = local_quota
        self.last_sync = time.time()
    
    def is_allowed(self, key: str) -> bool:
        # Fast path: check local tokens first
        if self.local_tokens > 0:
            self.local_tokens -= 1
            return True
        
        # Local exhausted: check and replenish from global
        if time.time() - self.last_sync > self.sync_interval:
            self._sync_with_global(key)
        
        return self.local_tokens > 0
    
    def _sync_with_global(self, key: str):
        # Atomically decrement global by local_quota and get remaining
        pipe = self.global_redis.pipeline()
        pipe.decrby(f"global_ratelimit:{key}", self.local_quota)
        pipe.get(f"global_ratelimit:{key}")
        results = pipe.execute()
        
        global_remaining = results[1]
        if global_remaining and int(global_remaining) >= 0:
            self.local_tokens = self.local_quota
        else:
            self.local_tokens = 0
        
        self.last_sync = time.time()
```

---

## 3) Message Queues (Deep Internals)

### Why message queues
```text
Without queues (synchronous coupling):
  API -> Email Service  (blocking: if email is slow, API is slow)
  API -> SMS Service    (blocking: if SMS is down, checkout fails)
  API -> Analytics      (blocking: analytics can't slow down payments)

With queues (async decoupling):
  API -> Queue -> Email Worker    (fire and forget, always fast)
             -> SMS Worker      (independent, can scale separately)
             -> Analytics Worker (never blocks user-facing path)
```

### Kafka vs RabbitMQ comparison

```text
Feature           Kafka                           RabbitMQ
---------------------------------------------------------------------
Model             Distributed log (consumers       Message broker (queues,
                  pull from durable log)           routing, exchanges)
Message retention Configurable (days/weeks)        Until consumed (default)
Ordering          Per-partition                    Per-queue (FIFO)
Throughput        Very high (1M+ msg/s)            High (100K msg/s)
Message replay    Yes (seek to any offset)         No (once consumed, gone)
Use cases         Event streaming, analytics,      Task queues, RPC,
                  microservice events              complex routing
Consumer model    Consumer groups (pull)           Push or pull
```

### Kafka: key concepts
```python
# Kafka producer
from kafka import KafkaProducer
import json

producer = KafkaProducer(
    bootstrap_servers=['kafka1:9092', 'kafka2:9092'],
    value_serializer=lambda v: json.dumps(v).encode('utf-8'),
    key_serializer=lambda k: k.encode('utf-8') if k else None,
    
    # Reliability config
    acks='all',          # Wait for all ISR (in-sync replicas) to ack
    retries=5,           # Retry on transient failure
    max_in_flight_requests_per_connection=1,  # Prevent reordering on retry
)

def publish_order_event(order: dict):
    # Partition key: route same user's events to same partition (ordering!)
    partition_key = order['user_id']
    
    producer.send(
        topic='order-events',
        key=partition_key,
        value={
            'event_type': 'ORDER_CREATED',
            'order_id': order['id'],
            'user_id': order['user_id'],
            'amount': order['total'],
            'timestamp': time.time()
        }
    )
    producer.flush()  # Ensure message is sent before returning

# Kafka consumer with at-least-once processing
from kafka import KafkaConsumer

consumer = KafkaConsumer(
    'order-events',
    bootstrap_servers=['kafka1:9092', 'kafka2:9092'],
    group_id='email-notification-service',  # Consumer group for offset tracking
    auto_offset_reset='earliest',           # Start from beginning if new group
    enable_auto_commit=False,               # Manual commit after processing
    value_deserializer=lambda v: json.loads(v.decode('utf-8'))
)

def process_with_idempotency():
    for message in consumer:
        event = message.value
        order_id = event['order_id']
        
        # Idempotency check: have we already sent this email?
        if email_already_sent(order_id):
            consumer.commit()  # Skip, mark as processed
            continue
        
        try:
            # Process the message
            send_order_confirmation_email(event)
            mark_email_sent(order_id)
            
            # Only commit offset AFTER successful processing
            # If this crashes before commit, message is redelivered (at-least-once)
            consumer.commit()
        except Exception as e:
            logger.error(f"Failed to process order {order_id}: {e}")
            # Don't commit: message will be redelivered
            # But guard against poison messages: track retry count
```

### Dead Letter Queue (DLQ) pattern
```python
class QueueWithDLQ:
    """
    After max_retries failures, move message to dead letter queue.
    Operator can inspect DLQ, fix issues, and replay messages.
    """
    
    def __init__(self, main_queue: str, dlq: str, max_retries: int = 3):
        self.main_queue = main_queue
        self.dlq = dlq
        self.max_retries = max_retries
    
    def process_message(self, message: dict, processor) -> None:
        retry_count = message.get('retry_count', 0)
        
        try:
            processor(message['data'])
            # Success: message is consumed
            
        except Exception as e:
            if retry_count >= self.max_retries:
                # Exhausted retries: move to DLQ
                self.publish_to_dlq({
                    **message,
                    'error': str(e),
                    'failed_at': time.time(),
                    'original_queue': self.main_queue
                })
                logger.error(f"Message moved to DLQ after {retry_count} retries: {e}")
            else:
                # Retry with exponential backoff delay
                delay = 2 ** retry_count * 1000  # ms: 1s, 2s, 4s
                self.publish_with_delay(self.main_queue, {
                    **message,
                    'retry_count': retry_count + 1
                }, delay_ms=delay)
```

### Delivery semantics
```python
delivery_semantics = {
    "at_most_once": {
        "description": "Message may be lost, never delivered twice",
        "how": "Commit offset before processing (Kafka) or auto-ack (AMQP)",
        "use_when": "Metrics, logs, telemetry where loss is acceptable",
        "risk": "Data loss if processor crashes after commit, before process",
    },
    "at_least_once": {
        "description": "Message definitely delivered, may be delivered multiple times",
        "how": "Commit offset after successful processing",
        "use_when": "Most business events with idempotent consumers",
        "risk": "Duplicate processing if crash after process, before commit",
        "mitigation": "Idempotency key: check if already processed",
    },
    "exactly_once": {
        "description": "Message delivered and processed exactly once",
        "how": "Idempotent producer + transactional consumer + dedup state",
        "use_when": "Financial transactions, inventory deductions",
        "cost": "Higher complexity and latency",
        "kafka_support": "Kafka Transactions API (0.11+)",
    }
}
```

---

## 4) Load Balancing

### Core algorithms with implementation
```python
import random
from threading import Lock

class LoadBalancer:
    def __init__(self, backends: list):
        self.backends = backends
        self.healthy = set(backends)
        self.connections = {b: 0 for b in backends}
        self.index = 0
        self.lock = Lock()
    
    def round_robin(self) -> str:
        """Simple, predictable. Good for homogeneous workloads."""
        with self.lock:
            healthy = list(self.healthy)
            if not healthy:
                raise NoHealthyBackendsError()
            server = healthy[self.index % len(healthy)]
            self.index += 1
            return server
    
    def least_connections(self) -> str:
        """Best for varied workload duration (e.g., some requests take 1s, others 100ms)."""
        healthy = list(self.healthy)
        if not healthy:
            raise NoHealthyBackendsError()
        return min(healthy, key=lambda b: self.connections[b])
    
    def random_choice(self) -> str:
        """Simple. Works well with many backends."""
        healthy = list(self.healthy)
        if not healthy:
            raise NoHealthyBackendsError()
        return random.choice(healthy)
    
    def weighted_round_robin(self, weights: dict) -> str:
        """
        Route more traffic to higher-capacity servers.
        E.g., weights = {"server1": 3, "server2": 3, "server3": 1}
        server1 and server2 each get 3x traffic of server3
        """
        healthy = list(self.healthy)
        weighted = []
        for server in healthy:
            weighted.extend([server] * weights.get(server, 1))
        
        with self.lock:
            server = weighted[self.index % len(weighted)]
            self.index += 1
            return server
    
    def mark_unhealthy(self, backend: str):
        self.healthy.discard(backend)
    
    def mark_healthy(self, backend: str):
        self.healthy.add(backend)
```

### L4 vs L7 Load Balancing
```text
L4 Load Balancer:
  Operates at TCP/UDP level.
  Sees: source IP, destination IP, port numbers.
  Cannot see: HTTP headers, URL path, cookies.
  Routing: IP hash, round-robin of IPs.
  Speed: Very fast (no HTTP parsing).
  Use: TCP services (databases, game servers), ultra-low latency.
  Examples: AWS NLB, HAProxy TCP mode.

L7 Load Balancer:
  Operates at HTTP level.
  Sees: HTTP headers, URL, body, cookies.
  Can: Route based on path (/api/v1 -> v1 service, /api/v2 -> v2 service).
  Can: Terminate TLS, inspect requests, add headers.
  Can: Perform A/B testing, canary releases.
  Speed: Slightly slower (must parse HTTP).
  Use: HTTP APIs, microservices, web applications.
  Examples: AWS ALB, Nginx, Envoy, Traefik.

Nginx L7 config with path-based routing:
```

```nginx
upstream v1_backend {
    least_conn;
    server v1-api-1:3000;
    server v1-api-2:3000;
    keepalive 100;
}

upstream v2_backend {
    least_conn;
    server v2-api-1:3000;
    server v2-api-2:3000;
    keepalive 100;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    # Route v2 traffic to new service
    location /api/v2/ {
        proxy_pass http://v2_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";  # Enable keepalive
    }

    # Route remaining to v1
    location / {
        proxy_pass http://v1_backend;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        
        # Health check endpoint
        proxy_next_upstream error timeout http_503;  # Try next server on failure
    }
    
    # Rate limiting at nginx level
    limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
    limit_req zone=api burst=20 nodelay;
}
```

---

## 5) Database Internals (WAL, Compaction, Read/Write Path)

### PostgreSQL Write Path
```text
Client sends: INSERT INTO orders (user_id, amount) VALUES (1, 99.99);

Step 1: Parse + Plan (microseconds)
  -> Parse SQL, validate schema, check permissions
  -> Choose execution plan (index scan vs seq scan)

Step 2: Check MVCC visibility + Locks
  -> Ensure no conflicting concurrent transaction
  -> Acquire row-level lock if needed

Step 3: Write to WAL (Write-Ahead Log)
  -> Append change record to WAL (sequential disk write)
  -> WAL record: {xid: 12345, table: orders, operation: INSERT, data: {...}}
  -> fsync WAL if synchronous_commit = on

Step 4: Modify shared buffer (in-memory)
  -> Apply change to page in shared_buffers (RAM)
  -> Page is now "dirty" (not yet on disk)

Step 5: Respond to client
  -> "INSERT 1" (success acknowledged)
  
Step 6: Background: checkpointer writes dirty pages to disk
  -> Occurs every checkpoint_timeout (default 5 minutes)
  -> This is why disk I/O is not on the critical write path!
```

### PostgreSQL Read Path
```text
Client sends: SELECT * FROM orders WHERE user_id = 1;

Step 1: Check if index exists on user_id
  -> Yes: use index scan (fast, ~3-5 random I/Os)
  -> No: sequential scan (slow for large tables)

Step 2: Fetch pages from shared_buffers
  -> Check if page is already in RAM cache (~512MB to 32GB typically)
  -> Cache hit: return immediately (< 1ms)
  -> Cache miss: read from disk (1-10ms per page)

Step 3: MVCC visibility check
  -> Filter rows to only show rows visible to this transaction
  -> Dead rows (from updates/deletes) are filtered out
  -> This is how read consistency is maintained without locks

Step 4: Return results
```

### WAL (Write-Ahead Log) explained
```python
# Conceptual WAL implementation
class WriteAheadLog:
    """
    The WAL is the secret to database durability.
    
    Key insight: it's much faster to write sequentially to one log file
    than to randomly update many data pages. So we log the INTENTION first,
    then apply changes to data pages.
    
    Crash recovery:
    - Read WAL from last checkpoint
    - Replay all committed transactions
    - Roll back uncommitted transactions
    - Database is consistent again
    """
    
    def __init__(self, wal_file: str):
        self.wal = open(wal_file, 'ab')  # append binary
        self.current_lsn = 0  # log sequence number
    
    def append(self, transaction_id: int, operation: str, data: bytes) -> int:
        """
        Append record to WAL and return LSN (log sequence number).
        LSN is used to:
        - Track replication lag
        - Implement read-your-writes consistency
        - Know which changes a replica has applied
        """
        record = {
            "lsn": self.current_lsn + 1,
            "xid": transaction_id,
            "op": operation,
            "data": data,
            "checksum": self._checksum(data)
        }
        encoded = msgpack.encode(record)
        self.wal.write(len(encoded).to_bytes(4, 'big') + encoded)
        self.wal.flush()
        os.fsync(self.wal.fileno())  # Force to disk (durability!)
        
        self.current_lsn += 1
        return self.current_lsn
```

---

## 6) Consistency Models (Deep Dive)

### The spectrum of consistency
```text
Strongest ←─────────────────────────────────────────────→ Weakest

Linearizable    Serializable    Causal    Monotonic Read    Eventual
     |                |             |           |               |
  Redis sync      Postgres      DynamoDB     MongoDB       CouchDB
  Spanner       transactions     causal    read concern     default
                                option      session

Analogy:
Linearizable: Everyone in the world sees events in the same order, immediately.
Serializable: Transactions appear to run one at a time (some ordering).
Causal: If A caused B, everyone sees A before B.
Eventual: Eventually everyone sees the same data (after writes stop).
```

### Linearizability example
```python
# Linearizable: every read sees the latest write (as if one copy of data)
# Used in: leader-based Raft/Paxos systems, Redis (primary only)

# Timeline:
# t=0: Read  -> Value: "Apple"  (correct, "Apple" was written at t=-10)
# t=5: Write -> "Banana"
# t=6: Read  -> Value: "Banana" (correct, must see t=5 write)
# t=7: Read  -> Value: "Banana" (correct, can't return "Apple" anymore)

# Implementation via Raft:
# All reads and writes go through the leader
# Before returning a read, leader confirms it still has quorum (hasn't been ousted)
# This prevents stale reads from a leader that was partitioned
```

### Eventual consistency with conflict resolution
```python
# Eventual consistency: replicas eventually converge but may temporarily diverge

class EventuallyConsistentStore:
    """
    Like DNS: propagation takes time, but all replicas eventually agree.
    Good for: shopping carts, user preferences, counters, caches.
    Bad for: bank balances, inventory, access control.
    """
    
    def __init__(self, node_id: str):
        self.node_id = node_id
        self.data = {}              # key -> (value, timestamp, vector_clock)
        self.pending_replication = []
    
    def write(self, key: str, value, vector_clock: dict = None) -> dict:
        new_clock = self._increment_clock(vector_clock or {})
        self.data[key] = {
            "value": value,
            "timestamp": time.time(),
            "vector_clock": new_clock,
            "writer": self.node_id
        }
        self.pending_replication.append((key, self.data[key]))
        return new_clock
    
    def resolve_conflict(self, key: str, incoming: dict) -> dict:
        """
        Last-Write-Wins (LWW): simplest conflict resolution.
        Problem: clock skew can cause incorrect results.
        Better: CRDTs, application-specific merge logic.
        """
        if key not in self.data:
            return incoming
        
        local = self.data[key]
        
        # Concurrent writes detected (vector clocks are incomparable)
        if self._concurrent(local["vector_clock"], incoming["vector_clock"]):
            # LWW: use timestamp (imperfect due to clock skew)
            return incoming if incoming["timestamp"] > local["timestamp"] else local
        
        # Causal order: use the one that happened later
        if self._happened_before(local["vector_clock"], incoming["vector_clock"]):
            return incoming  # incoming is newer
        
        return local  # local is newer
```

---

## Mastery Exercises

1. **Cache sizing:** If your service handles 10,000 req/s for product pages, each response is 2KB, and you want a 95% cache hit rate, how much memory do you need in Redis? (Hint: Zipf distribution means top 5% of products get 95% of views)

2. **Rate limiter implementation:** Implement a token bucket rate limiter that:
   - Allows 100 req/min for free tier
   - Allows 1000 req/min for paid tier  
   - Uses Redis for distributed enforcement
   - Returns proper `X-RateLimit-*` headers

3. **Queue retry strategy:** Design a retry strategy that:
   - Retries failed messages up to 5 times
   - Uses exponential backoff (1s, 2s, 4s, 8s, 16s)
   - Moves to DLQ after all retries
   - Alerts on-call if DLQ depth exceeds 100 messages

4. **Consistency choice:** For each use case, choose a consistency model and explain:
   - User profile bio update
   - Shopping cart contents
   - Inventory stock count
   - Payment ledger balance
   - Session authentication token

---

## Production Patterns Addendum

### Cache invalidation playbook
```python
# Anti-pattern: update cache on every write (race conditions!)
def bad_update(user_id, data):
    db.update(user_id, data)
    cache.set(f"user:{user_id}", data)  # RACE: old request might overwrite new data

# Pattern 1: Delete on write (simplest, slightly higher miss rate)
def update_with_invalidation(user_id, data):
    db.update(user_id, data)
    cache.delete(f"user:{user_id}")  # Next read will refresh from DB
    # Risk: brief window between delete and read where thundering herd can occur

# Pattern 2: Versioned keys (no invalidation needed)
def update_with_versioning(user_id, data):
    new_version = db.increment_version(user_id)  # atomic
    db.update(user_id, data)
    cache.set(f"user:{user_id}:v{new_version}", data, ttl=3600)
    # Old versions expire naturally; readers use latest version number

# Pattern 3: Write-through with distributed locking (strong consistency)
def update_with_lock(user_id, data):
    lock = cache.lock(f"lock:user:{user_id}", timeout=5)
    with lock:
        db.update(user_id, data)
        cache.set(f"user:{user_id}", data)
    # Prevents concurrent updates from interleaving
```

### Queue reliability playbook
```python
reliable_queue_config = {
    "message_key": "Use idempotency key from original request",
    "retry_policy": {
        "max_attempts": 5,
        "backoff": "exponential: 1s, 2s, 4s, 8s, 16s",
        "jitter": True,  # Prevent synchronized retries
    },
    "dead_letter_queue": {
        "enabled": True,
        "retention_days": 14,  # Keep for debugging and manual replay
        "alert_threshold": 100,  # Alert when DLQ depth > 100
    },
    "poison_message_detection": {
        "max_receive_count": 3,
        "action": "Move to DLQ, log message content, alert",
    },
    "visibility_timeout": "Set to 2x your expected processing time",
}
```

### Load balancer health model
```python
health_check_design = {
    "liveness_probe": {
        "endpoint": "GET /health/live",
        "success": 200,
        "failure_action": "Restart the process (don't send traffic until healthy)",
        "checks": "Is the process running? Can it accept connections?",
    },
    "readiness_probe": {
        "endpoint": "GET /health/ready",
        "success": 200,
        "failure_action": "Remove from load balancer rotation (don't kill process)",
        "checks": "DB connection pool healthy? Redis connected? Dependencies OK?",
    },
    "slow_start": {
        "description": "Ramp up traffic to new instances gradually",
        "config": "weight=1 on new instance, increase to weight=10 over 2 minutes",
        "why": "New instances have cold caches, may be slower initially",
    },
}
```

### Consistency decision matrix
| Use case | Preferred consistency | Why |
|---|---|---|
| Payment ledger | Linearizable/Serializable | Money cannot be wrong |
| Inventory reservation | Serializable | Can't oversell |
| User profile bio | Eventual | Bio being 2 seconds stale is acceptable |
| Feed counters (likes) | Eventual/approximate | Exact like count isn't critical |
| Shopping cart | Eventual (with LWW merge) | Can add items offline, merge on sync |
| Feature flags | Strong (read-after-write) | Must not serve old flag to same request |
| Rate limiter counters | Eventual (local + eventual global) | Slightly over-limit is acceptable |
