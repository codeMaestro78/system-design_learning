# Design a Distributed Cache (Comprehensive)

## 1) Intuition
A distributed cache is a shared key-value store that sits in front of your database to serve frequent reads from memory (sub-millisecond) instead of disk (milliseconds to seconds).

The core design challenges:
1. **Horizontal partitioning:** How do you distribute keys across N nodes without coordination overhead?
2. **Eviction policy:** When cache is full, which items to evict? (LRU, LFU, TTL)
3. **Consistency:** What happens when cache and DB diverge? Cache invalidation is famously hard.
4. **Replication:** How do you keep the cache highly available when a node fails?

Real-world analogy: Like a library's "reserve shelf" — the librarian anticipates which books will be requested often and keeps them at the front desk (cache) instead of in the stacks (database). When the front desk gets full, old books go back to the stacks (eviction).

---

## 2) Requirements

**Functional:**
- `set(key, value, ttl_seconds)` — store key with optional expiry
- `get(key)` → value or null — retrieve value
- `delete(key)` — remove key
- `exists(key)` → bool — check existence
- `bulk_get(keys[])` — batch retrieval (mget pattern)

**Non-Functional:**
- **Latency:** P99 < 1ms for get/set
- **Availability:** 99.99%
- **Scalability:** Horizontal scaling to 100+ nodes
- **Memory efficiency:** Compact encoding for small values
- **Fault tolerance:** Node failure shouldn't cause cache miss avalanche

---

## 3) Core Architecture

```text
Client (App Server)
    |
    v
[Cache Client Library]     <- Responsible for: routing, connection pooling, serialization
    |
    v  Consistent Hash Routing
    |
    +----> [Cache Node 1]  <- Holds key range A-F
    +----> [Cache Node 2]  <- Holds key range G-M
    +----> [Cache Node 3]  <- Holds key range N-S
    +----> [Cache Node 4]  <- Holds key range T-Z
    
Each cache node:
- Single-threaded event loop (like Redis) or multi-threaded with sharded hash maps
- In-memory hash table + LRU eviction structure
- Optional write-ahead log for durability
- Health check endpoint
```

---

## 4) Key Partitioning: Consistent Hashing

```python
import hashlib
import bisect

class CacheCluster:
    """
    Manages a distributed cache cluster using consistent hashing.
    Clients use this to determine which node holds a given key.
    """
    
    def __init__(self, nodes: list, virtual_nodes: int = 150):
        """
        virtual_nodes: Each physical node gets N virtual positions on the ring.
        With 150 virtual nodes per physical node and 10 nodes:
        - Total ring positions: 1500
        - Key distribution: each node handles ~10% of keys
        - Adding/removing a node: ~10% of keys remapped (not all!)
        """
        self.virtual_nodes = virtual_nodes
        self.ring = {}
        self.sorted_keys = []
        self.nodes = set()
        
        for node in nodes:
            self.add_node(node)
    
    def add_node(self, node_id: str) -> set:
        """
        Add a new cache node.
        Returns the set of keys that should be moved to the new node.
        Only ~(1/N) keys are affected.
        """
        self.nodes.add(node_id)
        affected_keys = set()
        
        for i in range(self.virtual_nodes):
            vnode_key = f"{node_id}:vn:{i}"
            position = self._hash(vnode_key)
            self.ring[position] = node_id
            bisect.insort(self.sorted_keys, position)
        
        return affected_keys
    
    def remove_node(self, node_id: str) -> None:
        """
        Remove a cache node (planned maintenance or failure).
        Its keys will be remapped to the next node in the ring.
        """
        self.nodes.discard(node_id)
        
        for i in range(self.virtual_nodes):
            vnode_key = f"{node_id}:vn:{i}"
            position = self._hash(vnode_key)
            if position in self.ring:
                del self.ring[position]
                self.sorted_keys.remove(position)
    
    def get_node(self, key: str) -> str:
        """
        Find which node owns this key.
        O(log N) binary search on sorted ring positions.
        """
        if not self.ring:
            raise ValueError("No nodes in cluster")
        
        position = self._hash(key)
        idx = bisect.bisect_left(self.sorted_keys, position) % len(self.sorted_keys)
        return self.ring[self.sorted_keys[idx]]
    
    def get_nodes_for_replication(self, key: str, replica_count: int = 2) -> list:
        """
        Returns N consecutive nodes for replicated writes.
        Used when you want replicated cache (hot keys, high availability).
        """
        if not self.ring:
            return []
        
        position = self._hash(key)
        idx = bisect.bisect_left(self.sorted_keys, position) % len(self.sorted_keys)
        
        nodes = []
        seen = set()
        while len(nodes) < replica_count and len(seen) < len(self.nodes):
            node = self.ring[self.sorted_keys[idx % len(self.sorted_keys)]]
            if node not in seen:
                nodes.append(node)
                seen.add(node)
            idx += 1
        
        return nodes
    
    def _hash(self, key: str) -> int:
        return int(hashlib.sha256(key.encode()).hexdigest(), 16)
```

---

## 5) LRU Cache Implementation

```python
from collections import OrderedDict

class LRUCache:
    """
    Least Recently Used eviction.
    When full: evict the item that was accessed longest ago.
    
    Implementation: OrderedDict (doubly-linked list + hash map)
    - Get: O(1) lookup + move to front
    - Set: O(1) insertion at front + O(1) evict from back if full
    
    Used by: most caches when you want "recently used items are more likely to be used again"
    Great for: user sessions, recently viewed items, hot data
    Not great for: data with temporal spikes (one viral video evicts everything else)
    """
    
    def __init__(self, capacity: int, default_ttl_s: int = 3600):
        self.capacity = capacity
        self.default_ttl_s = default_ttl_s
        self.cache = OrderedDict()  # key -> (value, expires_at)
    
    def get(self, key: str):
        if key not in self.cache:
            return None
        
        value, expires_at = self.cache[key]
        
        # Check TTL expiry
        if expires_at and time.time() > expires_at:
            del self.cache[key]
            return None
        
        # Move to end (most recently used)
        self.cache.move_to_end(key)
        return value
    
    def set(self, key: str, value, ttl_s: int = None) -> None:
        expires_at = time.time() + (ttl_s or self.default_ttl_s)
        
        if key in self.cache:
            self.cache.move_to_end(key)
        
        self.cache[key] = (value, expires_at)
        
        # Evict least recently used if over capacity
        if len(self.cache) > self.capacity:
            evicted_key, _ = self.cache.popitem(last=False)
            # In production: emit eviction metric
    
    def delete(self, key: str) -> bool:
        if key in self.cache:
            del self.cache[key]
            return True
        return False
    
    def bulk_get(self, keys: list) -> dict:
        """Get multiple keys in one call (reduces network round trips)."""
        return {k: self.get(k) for k in keys}


class LFUCache:
    """
    Least Frequently Used eviction.
    When full: evict the item that has been accessed fewest times.
    
    Better than LRU when: popular items should stay cached even if not recently accessed.
    Example: Product catalog page - top 100 products should never be evicted even if
             user just accessed something rare.
    
    More complex than LRU (requires frequency counter + min-heap or frequency buckets).
    """
    
    def __init__(self, capacity: int):
        self.capacity = capacity
        self.min_freq = 0
        self.key_to_val = {}              # key -> value
        self.key_to_freq = {}             # key -> access count
        self.freq_to_keys = {}            # freq -> OrderedDict of keys (LRU within same freq)
    
    def get(self, key: str):
        if key not in self.key_to_val:
            return None
        self._increment_freq(key)
        return self.key_to_val[key]
    
    def set(self, key: str, value) -> None:
        if self.capacity <= 0:
            return
        
        if key in self.key_to_val:
            self.key_to_val[key] = value
            self._increment_freq(key)
            return
        
        if len(self.key_to_val) >= self.capacity:
            # Evict least frequently used (oldest within min frequency bucket)
            keys_with_min_freq = self.freq_to_keys[self.min_freq]
            lfu_key, _ = keys_with_min_freq.popitem(last=False)
            del self.key_to_val[lfu_key]
            del self.key_to_freq[lfu_key]
        
        # Insert new key
        self.key_to_val[key] = value
        self.key_to_freq[key] = 1
        if 1 not in self.freq_to_keys:
            self.freq_to_keys[1] = OrderedDict()
        self.freq_to_keys[1][key] = True
        self.min_freq = 1
    
    def _increment_freq(self, key: str) -> None:
        freq = self.key_to_freq[key]
        self.key_to_freq[key] += 1
        
        # Remove from current frequency bucket
        del self.freq_to_keys[freq][key]
        if not self.freq_to_keys[freq]:
            del self.freq_to_keys[freq]
            if self.min_freq == freq:
                self.min_freq += 1
        
        # Add to next frequency bucket
        new_freq = freq + 1
        if new_freq not in self.freq_to_keys:
            self.freq_to_keys[new_freq] = OrderedDict()
        self.freq_to_keys[new_freq][key] = True
```

---

## 6) Cache Invalidation Strategies

```python
# The hardest problem in caching: when/how to remove stale entries

class CacheInvalidationStrategies:
    
    # === Strategy 1: TTL-based (simplest) ===
    def ttl_example(self):
        """
        Set TTL at write time. Cache auto-expires after TTL.
        
        Pros: Simple, no coordination needed, bounded staleness
        Cons: Stale data visible for up to TTL duration
              Can't invalidate immediately on update
        
        Use when: Stale data is acceptable (product catalog, public profiles)
                  TTL matches business tolerance (5 minutes, 1 hour)
        """
        cache.set("product:123", product_data, ttl_s=300)  # 5 min TTL
    
    # === Strategy 2: Event-driven invalidation (recommended for most cases) ===
    async def event_driven_example(self):
        """
        When underlying data changes: explicitly delete cache entry.
        
        Pros: Immediately consistent, no stale window
        Cons: All services must publish invalidation events
              Double-delete needed to handle races
        
        Use when: Consistency is important (user profile, inventory, prices)
        """
        # In DB write path:
        async def update_product(product_id: str, updates: dict) -> dict:
            product = await db.update_product(product_id, updates)
            
            # Invalidate cache immediately after write
            await cache.delete(f"product:{product_id}")
            
            # Also invalidate any cached lists that contain this product
            await cache.delete(f"category:{product.category_id}:products")
            
            return product
    
    # === Strategy 3: Cache-aside (lazy population) ===
    async def cache_aside_example(self, product_id: str):
        """
        Read: check cache, miss -> load from DB -> populate cache
        Write: update DB -> invalidate cache
        
        Most common pattern. Pros: Simple, resilient to cache failures.
        Cons: First request after invalidation always hits DB (cold start)
        """
        # Read
        cached = await cache.get(f"product:{product_id}")
        if cached:
            return cached
        
        product = await db.get_product(product_id)
        await cache.set(f"product:{product_id}", product, ttl_s=300)
        return product
    
    # === Strategy 4: Write-through (write to cache AND DB simultaneously) ===
    async def write_through_example(self, product_id: str, updates: dict):
        """
        On write: update both DB and cache in same operation.
        
        Pros: Cache always up-to-date, no need for separate invalidation
        Cons: Write latency increased (must wait for cache update too)
              Cache may fill with data that's never read again
        
        Use when: Write-heavy with immediate read-after-write (shopping cart)
        """
        product = await db.update_product(product_id, updates)
        await cache.set(f"product:{product_id}", product, ttl_s=3600)
        return product
    
    # === Strategy 5: Cache stampede prevention ===
    async def singleflight_example(self, product_id: str):
        """
        Problem: 1000 requests arrive simultaneously for uncached item.
        Without protection: 1000 DB queries in parallel (thundering herd).
        
        Solution: Only one request fetches from DB. Others wait for result.
        """
        key = f"product:{product_id}"
        
        # Check cache first
        cached = await cache.get(key)
        if cached:
            return cached
        
        # Check if there's already an in-flight request for this key
        if key in self._in_flight:
            return await self._in_flight[key]
        
        # Create a future that all waiting requests can share
        future = asyncio.Future()
        self._in_flight[key] = future
        
        try:
            product = await db.get_product(product_id)
            await cache.set(key, product, ttl_s=300)
            future.set_result(product)
            return product
        except Exception as e:
            future.set_exception(e)
            raise
        finally:
            del self._in_flight[key]
```

---

## 7) Cache Node Implementation (Single Node)

```python
import asyncio
import socket
import time
from collections import OrderedDict

class CacheNode:
    """
    A single cache server node.
    Handles connections from multiple clients.
    Protocol: simple binary protocol (key length, key, value length, value)
    """
    
    def __init__(self, host: str, port: int, max_memory_mb: int = 4096):
        self.host = host
        self.port = port
        self.max_memory_bytes = max_memory_mb * 1024 * 1024
        self.used_memory_bytes = 0
        
        self.store = OrderedDict()   # LRU: key -> (value_bytes, expires_at)
        self.ttl_heap = []           # Min-heap for TTL expiry (lazy cleanup)
        
        # Stats
        self.stats = {
            "hits": 0,
            "misses": 0,
            "evictions": 0,
            "current_items": 0,
        }
    
    # Command handlers
    def cmd_get(self, key: str) -> bytes | None:
        if key not in self.store:
            self.stats["misses"] += 1
            return None
        
        value_bytes, expires_at = self.store[key]
        
        # Check expiry (lazy expiration)
        if expires_at and time.time() > expires_at:
            self._evict(key)
            self.stats["misses"] += 1
            return None
        
        # Update LRU position
        self.store.move_to_end(key)
        self.stats["hits"] += 1
        return value_bytes
    
    def cmd_set(self, key: str, value_bytes: bytes, ttl_s: int = None) -> None:
        value_size = len(key.encode()) + len(value_bytes)
        
        # Evict until we have enough space
        while (self.used_memory_bytes + value_size > self.max_memory_bytes and 
               self.store):
            self._evict_lru()
        
        expires_at = time.time() + ttl_s if ttl_s else None
        
        if key in self.store:
            # Update: adjust memory usage
            old_size = len(key.encode()) + len(self.store[key][0])
            self.used_memory_bytes -= old_size
        
        self.store[key] = (value_bytes, expires_at)
        self.store.move_to_end(key)
        self.used_memory_bytes += value_size
        self.stats["current_items"] = len(self.store)
    
    def cmd_delete(self, key: str) -> bool:
        return self._evict(key)
    
    def _evict_lru(self) -> None:
        if not self.store:
            return
        key, (value_bytes, _) = self.store.popitem(last=False)
        self.used_memory_bytes -= len(key.encode()) + len(value_bytes)
        self.stats["evictions"] += 1
        self.stats["current_items"] = len(self.store)
    
    def _evict(self, key: str) -> bool:
        if key not in self.store:
            return False
        value_bytes, _ = self.store.pop(key)
        self.used_memory_bytes -= len(key.encode()) + len(value_bytes)
        self.stats["current_items"] = len(self.store)
        return True
    
    def get_stats(self) -> dict:
        total = self.stats["hits"] + self.stats["misses"]
        hit_rate = self.stats["hits"] / total if total > 0 else 0
        
        return {
            **self.stats,
            "hit_rate": f"{hit_rate:.2%}",
            "used_memory_mb": round(self.used_memory_bytes / (1024**2), 1),
            "max_memory_mb": round(self.max_memory_bytes / (1024**2), 1),
            "memory_usage_pct": f"{self.used_memory_bytes / self.max_memory_bytes:.1%}"
        }
```

---

## 8) Replication for High Availability

```text
Single cache node: SPOF (single point of failure)
If node fails: all keys on that node become cache misses -> DB overloaded

Solution: Replica sets (like Redis Sentinel or Redis Cluster)

Options:
1. Primary-Replica: writes go to primary, replicated async to replica
   Reads: can be served from replica (eventual consistency)
   Failover: automatic promotion of replica to primary
   
2. N-way replication: write to N nodes simultaneously (synchronous)
   Higher write latency, stronger durability
   Used for: critical cache (e.g., auth tokens, session data)

Redis Sentinel configuration (automatic failover):
```

```python
# Redis Sentinel: automatic primary failover
# Configuration for 3-node setup (1 primary, 2 replicas)

REDIS_SENTINEL_CONFIG = {
    "sentinels": [
        ("sentinel1.cache.internal", 26379),
        ("sentinel2.cache.internal", 26379),
        ("sentinel3.cache.internal", 26379),
    ],
    "service_name": "mymaster",
    "socket_timeout": 0.5,   # Fail fast
    "socket_connect_timeout": 0.5,
    "decode_responses": True,
}

# Failover behavior:
# 1. Primary goes down
# 2. Sentinels detect: no PING response after 30 seconds
# 3. Sentinels vote (majority quorum = 2 of 3)
# 4. One replica promoted to primary
# 5. Clients reconnect to new primary via Sentinel
# RTO (Recovery Time Objective): ~30-60 seconds

# For writes: use primary connection
# For reads: can use replica (may be slightly stale)

import redis.sentinel

sentinel = redis.sentinel.Sentinel(
    REDIS_SENTINEL_CONFIG["sentinels"],
    socket_timeout=REDIS_SENTINEL_CONFIG["socket_timeout"]
)

# Write to primary
primary = sentinel.master_for(REDIS_SENTINEL_CONFIG["service_name"])
primary.set("key", "value", ex=300)

# Read from replica (may serve slightly stale data)
replica = sentinel.slave_for(REDIS_SENTINEL_CONFIG["service_name"])
value = replica.get("key")
```

---

## 9) Hotspot Handling

```python
class HotKeyMitigation:
    """
    Hot keys: a small percentage of keys get disproportionate traffic.
    Example: Viral post ID, famous user profile.
    
    Problem: One Redis node handles 100K QPS for a single hot key
             -> that node becomes the bottleneck.
    """
    
    REPLICA_COUNT = 10  # Spread hot key across 10 virtual copies
    
    async def hot_get(self, key: str):
        """
        Read from a random replica of hot key.
        Spreads load across N shards instead of 1.
        """
        shard = random.randint(0, self.REPLICA_COUNT - 1)
        value = await self.redis.get(f"{key}:hot:{shard}")
        
        if value:
            return value
        
        # All shards miss: populate from source
        value = await self.source.fetch(key)
        await self._set_all_shards(key, value)
        return value
    
    async def hot_set(self, key: str, value, ttl_s: int = 300) -> None:
        """Write to all shards simultaneously."""
        await self._set_all_shards(key, value, ttl_s)
    
    async def _set_all_shards(self, key: str, value, ttl_s: int = 300) -> None:
        pipe = self.redis.pipeline()
        for shard in range(self.REPLICA_COUNT):
            pipe.setex(
                f"{key}:hot:{shard}",
                ttl_s + random.randint(0, 30),  # Jitter TTL to prevent mass expiry
                value
            )
        await pipe.execute()
    
    # Strategy 2: Local in-process cache
    def get_with_local_cache(self, key: str, local_ttl_s: int = 5):
        """
        For the hottest keys (top 100): cache in each app server process.
        Zero network hops. 5-second max staleness.
        100 app servers * 100 keys = 10,000 cache entries total (very small).
        """
        local_entry = self._local_cache.get(key)
        if local_entry and local_entry["expires"] > time.time():
            return local_entry["value"]  # No Redis call at all!
        
        value = self.redis.get(key)
        if value:
            self._local_cache[key] = {
                "value": value,
                "expires": time.time() + local_ttl_s
            }
        return value
```

---

## 10) Interview Strategy

### Opening
```text
"A distributed cache solves the impedance mismatch between database latency 
(5-50ms) and application latency requirements (< 1ms). The three core design 
decisions are:

1. Partitioning: consistent hashing to minimize redistribution when nodes change
2. Eviction: LRU for general use, LFU for frequency-biased workloads
3. Invalidation: event-driven deletion is more correct than TTL alone, but TTL 
   is simpler and usually good enough

I'll also cover replication, hot key handling, and cache stampede prevention."
```

### Common follow-ups
```text
Q: Why consistent hashing instead of simple modulo?
A: Modulo hash (key % N): adding a node rehashes ALL keys.
   With 10 nodes: remove one = 90% of keys move to new node = cache miss avalanche.
   Consistent hash: adding/removing a node: only ~(1/N) = 10% of keys affected.

Q: How do you handle cache stampede (thundering herd)?
A: Three approaches:
   1. Singleflight: only one request fetches from DB, others wait for result
   2. Probabilistic early expiry: randomly expire 1% of items early so one request
      refreshes cache before official TTL (prevents mass expiry)
   3. Stale-while-revalidate: serve slightly stale data while refreshing in background

Q: What's the right TTL for different data types?
A: 
   - User sessions: TTL = session length (30 min to 24 hours)
   - Static data (product catalog): TTL = 5-60 minutes
   - User-specific data: short TTL (1-5 min) + event-driven invalidation on update
   - Computed/aggregated data: depends on freshness requirement

Q: When do you choose LFU over LRU?
A: LFU is better when:
   - Small set of items are accessed very frequently (power law distribution)
   - Temporal locality is low (recently accessed ≠ soon to be accessed again)
   - Example: product catalog (top 100 SKUs are always popular)
   LRU is better when:
   - Working set is predictable and recent access predicts future access
   - Session data (recently active sessions)
```

---

## 11) Production Metrics

```python
key_metrics = {
    "hit_rate":              "Alert if < 80% (indicates cache too small or bad TTL)",
    "eviction_rate":         "Alert if high (cache is too full, increase capacity)",
    "latency_p99_ms":        "Alert if > 2ms (network or contention issue)",
    "memory_usage_pct":      "Alert if > 85% (about to start evicting aggressively)",
    "replication_lag_ms":    "Alert if > 100ms (replica falling behind primary)",
    "connection_count":      "Alert if > 80% of max_connections",
    "slow_log_commands":     "Commands taking > 10ms logged in Redis slowlog",
}
```
