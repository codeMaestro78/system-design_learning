# Part 3: Data & Storage (Deep)

## 1) SQL vs NoSQL (When and Why)

### Intuition
Data model should follow **access patterns** and **correctness requirements**, not hype or familiarity.

The question is never "SQL vs NoSQL" — it is:
- What queries do I need to run?
- What transactions do I need?
- How does data grow and how is it accessed over time?
- What consistency guarantees does this use case require?

### The real decision matrix

```text
Question                                    Points toward
-----------------------------------------------------------------------
Need joins across many tables?              SQL
Need ACID transactions?                     SQL
Schema is stable and well-understood?       SQL
Access pattern is primary key lookups?      NoSQL (key-value)
Need flexible/nested/variable schema?       NoSQL (document)
Need time-series or event data?             NoSQL (wide-column or time-series DB)
Need full-text search?                      Search engine (Elasticsearch)
Write throughput > 50K/s?                   NoSQL or sharded SQL
Need geospatial queries?                    SQL (PostGIS) or search engine
Team knows SQL already?                     Keep SQL until you outgrow it
```

### Concrete storage selection by use case
```text
Use Case                  Primary Storage          Why
-------------------------------------------------------------------
User accounts             PostgreSQL               ACID, relational joins, stable schema
Session store             Redis                    In-memory, simple key-value, TTL
Social graph edges        PostgreSQL or Neptune     Relational or graph queries
Chat messages             Cassandra / ScyllaDB      Write-heavy, time-ordered, partition by conversation
Media files               S3/GCS (object storage)  Binary blobs, CDN integration
Product catalog           PostgreSQL + Elasticsearch  Relational + full-text search
Analytics events          ClickHouse / BigQuery     Columnar, aggregate queries
Real-time leaderboards    Redis Sorted Set          O(log n) rank, in-memory
Feature flags             etcd / PostgreSQL         Strong consistency, small dataset
Rate limiter counters     Redis                    Atomic incr, TTL, in-memory speed
```

### Code: Working with both SQL and Redis together
```python
import psycopg2
import redis
import json
from typing import Optional

# Pattern: PostgreSQL as source of truth + Redis as cache
class UserRepository:
    def __init__(self):
        self.db = psycopg2.connect("postgresql://user:pass@localhost/mydb")
        self.cache = redis.Redis(host='localhost', port=6379)
        self.cache_ttl = 300  # 5 minutes
    
    def get_user(self, user_id: str) -> Optional[dict]:
        # Try cache first
        cache_key = f"user:{user_id}"
        cached = self.cache.get(cache_key)
        
        if cached:
            return json.loads(cached)
        
        # Cache miss: fetch from PostgreSQL
        with self.db.cursor() as cur:
            cur.execute(
                "SELECT id, email, name, created_at FROM users WHERE id = %s",
                (user_id,)
            )
            row = cur.fetchone()
        
        if not row:
            return None
        
        user = {
            "id": row[0],
            "email": row[1],
            "name": row[2],
            "created_at": row[3].isoformat()
        }
        
        # Store in cache with TTL
        self.cache.setex(cache_key, self.cache_ttl, json.dumps(user))
        return user
    
    def update_user(self, user_id: str, updates: dict) -> dict:
        # Write to PostgreSQL first (source of truth)
        with self.db.cursor() as cur:
            cur.execute(
                "UPDATE users SET name = %s WHERE id = %s RETURNING id, email, name",
                (updates.get("name"), user_id)
            )
            row = cur.fetchone()
            self.db.commit()
        
        user = {"id": row[0], "email": row[1], "name": row[2]}
        
        # Invalidate cache (don't update cache directly - avoids stale write race)
        self.cache.delete(f"user:{user_id}")
        
        return user
```

---

## 2) B-Tree vs LSM Tree (Deep Internals)

### The core problem
Every storage engine needs to efficiently:
1. Write data (insert/update)
2. Read data (point lookup and range scan)
3. Delete data
4. Recover after crash

B-Trees and LSM Trees make fundamentally different tradeoffs between write speed, read speed, and space efficiency.

### B-Tree (Balanced Tree) — what PostgreSQL, MySQL InnoDB use

```text
A B-Tree page (node) stores multiple keys with pointers to children.

Structure:
              [50 | 80]               <- Root page
              /    |    \
       [20|30]  [60|70]  [90|100]    <- Internal pages
       /  |   \   ...
  [10][25][35]...                    <- Leaf pages (actual data)

Page size: typically 8KB (PostgreSQL) or 16KB (MySQL)
Each page holds ~100-500 entries

Search: O(log n), ~3-5 page reads for millions of rows
Insert: find leaf, insert, potentially split page up to root
```

```python
# B-Tree characteristics
btree_analysis = {
    "point_read": {
        "complexity": "O(log n)",
        "disk_reads": "~3-5 for 1M rows (log base 500)",
        "good_for": "mixed read/write workloads",
    },
    "range_scan": {
        "complexity": "O(log n + k)",  # k = rows in range
        "disk_reads": "very efficient, leaf pages are linked",
        "good_for": "date ranges, alphabetical scans",
    },
    "write": {
        "complexity": "O(log n)",
        "disk_ops": "random writes (read page, modify, write back)",
        "bad_for": "very high write throughput",
    },
    "space": {
        "typical_fill": "70% average (pages are not always full after deletes)",
        "fragmentation": "can accumulate over time, VACUUM/ANALYZE needed",
    }
}
```

### LSM Tree (Log-Structured Merge Tree) — what Cassandra, RocksDB, LevelDB use

```text
Insight: Sequential writes to disk are 100x faster than random writes.
         So buffer writes in memory, write sequentially to disk in sorted batches.

Level 0: Memtable (in memory, ~64MB)
         WAL (write-ahead log, for crash recovery)
         
Level 1: SSTable files (sorted, immutable, ~10MB each)

Level 2: SSTable files (sorted, immutable, ~100MB each)

Level 3: SSTable files (sorted, immutable, ~1GB each)

Write path:
  1. Write to WAL (sequential disk write, for crash recovery)
  2. Write to Memtable (in-memory sorted structure, e.g., red-black tree)
  3. When Memtable fills (64MB): flush to new SSTable file on disk (sequential!)
  4. Background compaction merges SSTables, removes tombstones
```

```python
class LSMTreeConcept:
    """Conceptual implementation of LSM tree write/read paths"""
    
    def __init__(self):
        self.memtable = {}      # In-memory (fast writes)
        self.wal = open("/tmp/wal.log", "a")  # Write-ahead log
        self.sstables = []      # List of sorted files (newest first)
    
    def write(self, key: str, value: str):
        # 1. Append to WAL first (crash recovery)
        self.wal.write(f"{key}={value}\n")
        self.wal.flush()  # fsync for durability
        
        # 2. Write to memtable (fast in-memory)
        self.memtable[key] = value
        
        # 3. When memtable is full, flush to SSTable
        if len(self.memtable) > 10000:  # threshold
            self._flush_to_sstable()
    
    def delete(self, key: str):
        # LSM doesn't delete in place - writes a "tombstone"
        self.write(key, "__TOMBSTONE__")
        # Old value still on disk but will be removed during compaction
    
    def read(self, key: str) -> str:
        # 1. Check memtable first (most recent)
        if key in self.memtable:
            val = self.memtable[key]
            return None if val == "__TOMBSTONE__" else val
        
        # 2. Check SSTables newest to oldest (Bloom filter can skip most!)
        for sstable in reversed(self.sstables):
            if sstable.might_contain(key):  # Bloom filter check
                val = sstable.get(key)
                if val is not None:
                    return None if val == "__TOMBSTONE__" else val
        
        return None  # Key not found
    
    def _flush_to_sstable(self):
        # Sort memtable entries and write as immutable SSTable
        sorted_entries = sorted(self.memtable.items())
        new_sstable = SSTable(sorted_entries)
        self.sstables.append(new_sstable)
        self.memtable = {}
        # WAL can now be truncated
```

### Bloom Filter (critical for LSM read performance)
```python
# Bloom filter prevents unnecessary disk reads for missing keys
# "Might be here" → check disk
# "Definitely not here" → skip this SSTable

class BloomFilter:
    def __init__(self, expected_items: int, false_positive_rate: float = 0.01):
        """
        For 1M items at 1% FPR:
          - Bit array size: ~9.6 MB
          - Hash functions: 7
          - Cost: tiny memory for huge disk I/O savings
        """
        import math
        m = -expected_items * math.log(false_positive_rate) / (math.log(2) ** 2)
        k = (m / expected_items) * math.log(2)
        
        self.size = int(m)
        self.hash_count = int(k)
        self.bits = bytearray(self.size // 8 + 1)
    
    def add(self, item: str):
        for seed in range(self.hash_count):
            idx = self._hash(item, seed) % self.size
            self.bits[idx // 8] |= (1 << (idx % 8))
    
    def might_contain(self, item: str) -> bool:
        for seed in range(self.hash_count):
            idx = self._hash(item, seed) % self.size
            if not (self.bits[idx // 8] & (1 << (idx % 8))):
                return False  # Definitely not present
        return True  # Might be present
    
    def _hash(self, item: str, seed: int) -> int:
        import hashlib
        return int(hashlib.md5(f"{item}:{seed}".encode()).hexdigest(), 16)
```

### Comparison: Write/Read amplification
```text
Metric          B-Tree              LSM Tree
-------------------------------------------------------------------
Write path      1 random disk write  1 WAL (seq) + memtable (RAM)
Write latency   Higher (random I/O)  Lower (seq I/O)
Read path       1-5 page reads       Check L0,L1,L2... (amplified)
Read latency    Lower                Higher (without tuning)
Space           ~130% of data        ~110% of data (compaction helps)
Write amplif.   ~10x                 ~30x (compaction writes data many times)
Read amplif.    1x                   ~10x (check many SSTables)

Bloom filters:  N/A                  Reduce read amplification dramatically

Choose B-Tree when:
  - Read-heavy workload
  - Mixed random reads/writes
  - Need predictable read latency
  - Small-to-medium data size
  - PostgreSQL, MySQL workloads

Choose LSM when:
  - Write-heavy workload (>50K writes/sec)
  - Append-only patterns (logs, time series, messages)
  - Can tolerate read amplification
  - Cassandra, RocksDB, LevelDB workloads
```

---

## 3) Query Optimization Basics

### How a query gets executed
```sql
-- This query, when submitted to PostgreSQL:
SELECT u.name, COUNT(o.id) as order_count
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.created_at > '2024-01-01'
GROUP BY u.name
ORDER BY order_count DESC
LIMIT 10;

-- Goes through these steps:
-- 1. Parse: SQL text -> parse tree
-- 2. Analyze: validate tables/columns exist, resolve types
-- 3. Rewrite: apply rules (e.g., expand views)
-- 4. Plan: query optimizer generates multiple plans, chooses cheapest
-- 5. Execute: run the chosen plan

-- EXPLAIN ANALYZE shows the chosen plan and actual costs:
EXPLAIN (ANALYZE, BUFFERS) 
SELECT u.name, COUNT(o.id) as order_count
FROM users u
JOIN orders o ON o.user_id = u.id
WHERE u.created_at > '2024-01-01'
GROUP BY u.name
ORDER BY order_count DESC
LIMIT 10;
```

### Reading EXPLAIN output
```text
QUERY PLAN
----------------------------------------------------------------------
Limit  (cost=...) (actual time=50.2..50.2 rows=10 loops=1)
  -> Sort  (cost=...) (actual time=50.1..50.1 rows=10 loops=1)
       Sort Key: (count(o.id)) DESC
       Sort Method: quicksort  Memory: 256kB
       -> HashAggregate  (cost=...) (rows=5000) (actual rows=4987)
            Group Key: u.name
            -> Hash Join  (cost=... rows=50000) (actual rows=48932)
                 Hash Cond: (o.user_id = u.id)
                 -> Seq Scan on orders  (cost=...) (rows=500000) actual=498020
                      <- WARNING: full table scan on orders!
                 -> Hash  (cost=...)
                      -> Index Scan on users  (actual rows=5000)
                           Index Cond: (created_at > '2024-01-01')

Execution Time: 50.234 ms

Key problems:
- Seq Scan on orders: reading 500K rows! Need index on orders.user_id
- Without that index, every join does a full table scan
```

```sql
-- Fix: add missing index
CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders(user_id);

-- After index:
-- Hash Join now uses Index Scan on orders
-- Execution time drops from 50ms to 2ms for 500K rows

-- Even better: covering index includes all needed columns
CREATE INDEX CONCURRENTLY idx_orders_user_id_id 
ON orders(user_id) INCLUDE (id);
-- Now PostgreSQL never touches the orders table heap for this query
```

### Common slow query patterns and fixes
```sql
-- PROBLEM 1: LIKE with leading wildcard (can't use index)
SELECT * FROM products WHERE name LIKE '%phone%';  -- full table scan

-- FIX: Use full-text search
CREATE INDEX idx_products_name_fts 
ON products USING gin(to_tsvector('english', name));

SELECT * FROM products 
WHERE to_tsvector('english', name) @@ to_tsquery('phone');
-- Uses index!

-- PROBLEM 2: Function on indexed column (breaks index usage)
SELECT * FROM users WHERE LOWER(email) = 'alice@example.com';  -- no index
SELECT * FROM users WHERE DATE(created_at) = '2024-01-15';     -- no index

-- FIX: Functional indexes
CREATE INDEX idx_users_lower_email ON users(LOWER(email));
CREATE INDEX idx_users_created_date ON users(DATE(created_at));

-- Better fix: enforce at write time
ALTER TABLE users ADD CONSTRAINT email_lowercase CHECK (email = LOWER(email));
-- Now you can query: WHERE email = 'alice@example.com' using regular index

-- PROBLEM 3: N+1 queries (classic ORM trap)
-- BAD: 1 query to get orders, then N queries for each order's items
orders = db.query("SELECT * FROM orders WHERE user_id = 1")
for order in orders:
    items = db.query("SELECT * FROM order_items WHERE order_id = %s", order.id)
    # 100 orders = 101 queries!

-- FIX: JOIN or subquery
orders_with_items = db.query("""
    SELECT o.*, 
           json_agg(oi.*) as items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.user_id = 1
    GROUP BY o.id
""")
# 1 query, gets all data

-- PROBLEM 4: Large OFFSET pagination (gets slower as offset grows)
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 10000;
-- Must scan and discard 10,000 rows!

-- FIX: Cursor-based pagination
SELECT * FROM posts 
WHERE created_at < '2024-01-15 12:30:00'  -- last seen cursor
ORDER BY created_at DESC 
LIMIT 20;
-- Uses index efficiently regardless of page number
```

---

## 4) Transactions and ACID (with Internals)

### Atomicity
All operations in a transaction succeed or all are rolled back. No partial updates.

```sql
-- Classic money transfer: must be atomic
BEGIN;
  -- Deduct from sender
  UPDATE accounts SET balance = balance - 100 WHERE id = 'alice';
  
  -- Check constraint: balance must stay >= 0
  -- If this check fails, the whole transaction rolls back
  
  -- Add to recipient
  UPDATE accounts SET balance = balance + 100 WHERE id = 'bob';
  
  -- Audit log
  INSERT INTO transactions(from_id, to_id, amount) VALUES ('alice', 'bob', 100);
COMMIT;
-- Either all 3 operations happen, or none
```

### How atomicity works internally
```text
Write-Ahead Log (WAL):
  1. Before modifying any page: write intended change to WAL
  2. WAL is written sequentially (fast)
  3. On COMMIT: flush WAL to disk (fsync)
  4. Then update actual data pages (can be deferred)

Crash recovery:
  - If crash before COMMIT: WAL says "transaction incomplete" -> ROLLBACK
  - If crash after WAL fsync but before data pages written: 
    replay WAL on restart (redo the changes)
  - Result: no partial updates visible ever
```

### Consistency
Transactions maintain database invariants (constraints, foreign keys, check constraints).

```sql
-- Consistency enforced by constraints:
CREATE TABLE orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),  -- FK: user must exist
    total_amount DECIMAL(10,2) NOT NULL CHECK (total_amount > 0),  -- must be positive
    status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'paid', 'cancelled'))
);

-- PostgreSQL enforces these on every write, within a transaction
-- If any constraint fails -> automatic rollback
```

### Isolation
Concurrent transactions should not see each other's intermediate state.

```sql
-- ISOLATION LEVEL 1: READ UNCOMMITTED (avoid this!)
-- Can read data that hasn't been committed yet (dirty read)
-- Alice transfers $100 but then rolls back, but Bob already saw the transfer

-- ISOLATION LEVEL 2: READ COMMITTED (PostgreSQL default)
-- Only see committed data
-- But can see different data on re-read within same transaction (non-repeatable read)

-- Example of non-repeatable read:
-- Transaction 1:
BEGIN;
SELECT balance FROM accounts WHERE id = 'alice';  -- Returns 1000
-- Meanwhile, Transaction 2 commits: alice sends $500
SELECT balance FROM accounts WHERE id = 'alice';  -- Returns 500 (changed!)
COMMIT;

-- ISOLATION LEVEL 3: REPEATABLE READ
-- Once you read a value, you'll see the same value for the rest of the transaction
-- But can see phantom rows (new rows inserted by other transactions)

-- ISOLATION LEVEL 4: SERIALIZABLE
-- Complete isolation, as if transactions ran one after another
-- Prevents all anomalies including write skew
-- Highest overhead

-- MVCC (Multi-Version Concurrency Control):
-- PostgreSQL/MySQL (InnoDB) create row versions instead of locking readers
-- Readers don't block writers, writers don't block readers
-- Each transaction sees a consistent snapshot of the database
```

### Durability
Committed data survives crashes.

```sql
-- PostgreSQL fsync settings (production vs development tradeoff)
-- In postgresql.conf:

-- Production (safe):
synchronous_commit = on    -- wait for WAL to be written to disk before ack
fsync = on                 -- actually call fsync() system call

-- Development (faster but can lose last few commits on crash):
synchronous_commit = off   -- async commit (data safe, WAL not fsynced)
-- Still won't corrupt the database on crash, just may lose recent transactions
```

---

## 5) Isolation Levels (with Anomaly Examples)

```sql
-- ANOMALY 1: Dirty Read (prevented by READ COMMITTED and above)
-- Transaction A reads uncommitted data from Transaction B

-- T1:                        T2:
BEGIN;                         BEGIN;
UPDATE accounts                  -- T1 has not committed yet
  SET balance = 200            
  WHERE id = 1;                SELECT balance FROM accounts WHERE id = 1;
                               -- READ UNCOMMITTED: sees 200 (dirty!)
                               -- READ COMMITTED: sees original value
ROLLBACK;                      -- T1 rolled back: T2 saw non-existent data

-- ANOMALY 2: Non-Repeatable Read (prevented by REPEATABLE READ and above)
-- T1:                        T2:
BEGIN;
SELECT balance                 BEGIN;
  FROM accounts                UPDATE accounts SET balance = 500 WHERE id = 1;
  WHERE id = 1;  -- 1000      COMMIT;
                               
SELECT balance                 -- READ COMMITTED: sees 500 (value changed!)
  FROM accounts                -- REPEATABLE READ: still sees 1000
  WHERE id = 1;                

-- ANOMALY 3: Phantom Read (prevented by SERIALIZABLE)
-- T1:                        T2:
BEGIN;
SELECT COUNT(*)                BEGIN;
  FROM orders                  INSERT INTO orders (user_id) VALUES (1);
  WHERE user_id = 1;  -- 5    COMMIT;

SELECT COUNT(*)                -- REPEATABLE READ: might see 6 (new row appeared!)
  FROM orders                  -- SERIALIZABLE: still sees 5
  WHERE user_id = 1;

-- ANOMALY 4: Write Skew (only prevented by SERIALIZABLE)
-- Example: hospital requires at least 1 doctor on call
-- Doctor A and Doctor B both go off call simultaneously

-- T1 (Doctor A checks and goes off call):
BEGIN;
SELECT COUNT(*) FROM on_call WHERE on_duty = true;  -- 2 (both A and B)
UPDATE on_call SET on_duty = false WHERE doctor = 'A';
COMMIT;

-- T2 (Doctor B checks and goes off call, concurrently):
BEGIN;
SELECT COUNT(*) FROM on_call WHERE on_duty = true;  -- 2 (both A and B)
UPDATE on_call SET on_duty = false WHERE doctor = 'B';
COMMIT;

-- Result: 0 doctors on call (invariant violated!)
-- REPEATABLE READ cannot prevent this (A and B read different rows)
-- SERIALIZABLE detects the conflict and aborts one transaction
```

### Practical guidance
```python
# When to use each isolation level
isolation_guidance = {
    "READ_COMMITTED": {
        "use_for": "Most OLTP workloads, default for most apps",
        "acceptable_anomalies": "Non-repeatable reads (usually OK for short transactions)",
        "performance": "Best",
    },
    "REPEATABLE_READ": {
        "use_for": "Report generation, transactions that re-read rows",
        "acceptable_anomalies": "Phantoms (rarely matters for most apps)",
        "performance": "Good",
    },
    "SERIALIZABLE": {
        "use_for": "Financial transactions, inventory reservations, anything with complex invariants",
        "acceptable_anomalies": "None (strongest guarantee)",
        "performance": "Lower (detects conflicts, may abort transactions)",
    },
}
```

---

## 6) Sharding & Partitioning

### Horizontal partitioning (within one DB server)
```sql
-- PostgreSQL table partitioning by time (range partitioning)
CREATE TABLE events (
    id BIGSERIAL,
    user_id INTEGER NOT NULL,
    event_type VARCHAR(50),
    payload JSONB,
    created_at TIMESTAMP NOT NULL
) PARTITION BY RANGE (created_at);

-- Create partitions (monthly)
CREATE TABLE events_2024_01 PARTITION OF events
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');
    
CREATE TABLE events_2024_02 PARTITION OF events
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- PostgreSQL automatically routes writes to correct partition
-- Queries with WHERE created_at = '2024-01-15' only scan January partition
-- Old partitions can be archived or dropped easily (DROP TABLE events_2024_01)

-- Hash partitioning for even distribution
CREATE TABLE users (
    id BIGINT,
    email TEXT,
    name TEXT
) PARTITION BY HASH (id);

CREATE TABLE users_p0 PARTITION OF users FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE users_p1 PARTITION OF users FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE users_p2 PARTITION OF users FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE users_p3 PARTITION OF users FOR VALUES WITH (MODULUS 4, REMAINDER 3);
```

### Sharding (across multiple DB servers)
```python
# Consistent hashing for shard routing
import hashlib
import bisect

class ShardRouter:
    """
    Routes requests to the correct database shard.
    Uses consistent hashing so adding/removing shards 
    moves minimum data.
    """
    
    def __init__(self, shard_configs: dict):
        """
        shard_configs = {
            "shard1": {"host": "db1.internal", "port": 5432},
            "shard2": {"host": "db2.internal", "port": 5432},
            "shard3": {"host": "db3.internal", "port": 5432},
        }
        """
        self.shard_configs = shard_configs
        self.ring = {}
        self.sorted_keys = []
        self.virtual_nodes = 200  # more virtual nodes = better distribution
        
        for shard_id in shard_configs:
            self.add_shard(shard_id)
    
    def add_shard(self, shard_id: str):
        for i in range(self.virtual_nodes):
            key = self._hash(f"{shard_id}:vnode:{i}")
            self.ring[key] = shard_id
            bisect.insort(self.sorted_keys, key)
    
    def remove_shard(self, shard_id: str):
        for i in range(self.virtual_nodes):
            key = self._hash(f"{shard_id}:vnode:{i}")
            del self.ring[key]
            self.sorted_keys.remove(key)
    
    def get_shard(self, entity_id: str) -> str:
        """Get the shard for a given entity ID."""
        key = self._hash(entity_id)
        idx = bisect.bisect(self.sorted_keys, key) % len(self.sorted_keys)
        shard_id = self.ring[self.sorted_keys[idx]]
        return shard_id
    
    def get_connection(self, entity_id: str):
        """Get a database connection for this entity."""
        shard_id = self.get_shard(entity_id)
        config = self.shard_configs[shard_id]
        return get_db_connection(config)
    
    def _hash(self, key: str) -> int:
        return int(hashlib.md5(key.encode()).hexdigest(), 16)

# Usage
router = ShardRouter({
    "shard1": {"host": "db1.internal", "port": 5432},
    "shard2": {"host": "db2.internal", "port": 5432},
    "shard3": {"host": "db3.internal", "port": 5432},
})

# Always routes user_123 to the same shard
shard = router.get_shard("user_123")
conn = router.get_connection("user_123")
conn.execute("SELECT * FROM users WHERE id = 'user_123'")
```

### Shard key design
```text
Requirements for a good shard key:
1. High cardinality: enough distinct values to spread load evenly
2. Uniform distribution: hotspot if everyone uses same shard
3. Aligns with dominant query pattern: most queries should hit ONE shard
4. Supports future growth: not running out of capacity on one shard

Examples:
  user_id (UUID)     -> GOOD: high cardinality, uniform, queries per user
  user_id (integer)  -> OK: might need to pad or use hash for uniformity
  email              -> OK: high cardinality, but range queries inefficient
  country_code       -> BAD: 10% of users in US = 1 shard gets 10x load
  created_at         -> BAD for shard key: new data always goes to 1 shard (hot write shard)
  product_category   -> BAD: uneven distribution, only 10-50 categories
```

### Common shard pitfalls
```python
# PITFALL 1: Cross-shard query (very expensive)
# Question: "Show me all orders for users who signed up in January"
# - users are sharded by user_id
# - orders are also sharded by user_id
# - This query requires scanning ALL user shards to find January users

# Solution: denormalize or maintain a secondary index
# Store user's signup date in a separate lookup table
# Keep a sparse index: signup_date -> list of user_ids on that date

# PITFALL 2: Cross-shard transaction (distributed transaction needed)
# Moving money between two users on different shards
# Requires either 2PC (slow, locks) or Saga pattern

# PITFALL 3: Hotspot from sequential IDs
# If you use auto-increment IDs as shard keys, all new records go to shard N
# Fix: use UUID v4, or hash the sequential ID

import uuid
def generate_shardable_id() -> str:
    # UUID v4 is random -> distributes evenly across shards
    return str(uuid.uuid4())
    
# Or: prefix with random bucket for time-ordered but shardable IDs
def generate_time_ordered_id(shard_count: int = 1024) -> str:
    import time
    timestamp_ms = int(time.time() * 1000)
    shard_bucket = random.randint(0, shard_count - 1)
    random_suffix = random.randint(0, 999999)
    return f"{timestamp_ms:013d}{shard_bucket:04d}{random_suffix:06d}"
```

---

## 7) Replication Models

### Leader-Follower (Primary-Replica)
```text
Writes: always go to leader
Reads: can go to leader (strong) or followers (eventual)
Failover: automatic promotion of follower to leader

Timeline:
Leader:   W1 --WAL--> W2 --WAL--> W3
Follower:      W1(+5ms)    W2(+5ms)    W3(+5ms)

Replication lag: typically 1-100ms on local network
                 Can spike to seconds during heavy load
```

```python
# Read-after-write consistency with replica lag
class ReplicationAwareDB:
    """
    Problem: User writes data, immediately reads it, gets stale data from replica.
    Solution: After write, route subsequent reads to primary (or use replication token).
    """
    
    def __init__(self):
        self.primary = connect("postgres://primary:5432/db")
        self.replica = connect("postgres://replica:5432/db")
        self.leader_required_until = {}  # session_id -> timestamp
    
    def write(self, session_id: str, query: str, params: tuple):
        result = self.primary.execute(query, params)
        # Mark this session as needing primary reads for next 5 seconds
        # (conservative: replica lag is typically < 1s in practice)
        self.leader_required_until[session_id] = time.time() + 5
        return result
    
    def read(self, session_id: str, query: str, params: tuple):
        # If we just wrote, read from primary to guarantee read-your-writes
        if self.leader_required_until.get(session_id, 0) > time.time():
            return self.primary.execute(query, params)
        
        # Otherwise, replicas are fine (better load distribution)
        return self.replica.execute(query, params)

# Alternative: use replication LSN (log sequence number)
def write_with_lsn(query: str, params: tuple) -> dict:
    result = primary.execute(query, params)
    lsn = primary.query_one("SELECT pg_current_wal_lsn()")[0]
    return {"result": result, "lsn": str(lsn)}

def read_after_write(query: str, params: tuple, min_lsn: str):
    # Wait for replica to catch up, then read from it
    replica.execute("SELECT pg_wal_lsn_diff(pg_last_wal_receive_lsn(), %s)", (min_lsn,))
    # If replica is behind, either wait or fallback to primary
```

### Multi-Leader Replication
```text
Use case: multiple geographic regions each needing low-latency writes
Example: Google Docs (offline edits merge when back online)

Challenges:
  Write conflicts: User A changes "title" to "Hello", User B changes "title" to "World"
  Which wins? Need conflict detection and resolution.

Resolution strategies:
  1. Last-Write-Wins (LWW): timestamp decides. Problem: clock skew.
  2. Application-specific merge: domain logic (e.g., CRDT for counters)
  3. Ask the user: "Conflict detected. Which version do you want to keep?"
  4. Operational Transformation: used by Google Docs for collaborative edits
```

### Quorum Reads and Writes
```python
# Quorum system: N replicas, W write quorum, R read quorum
# Rule: W + R > N guarantees at least one node in read set saw latest write

class QuorumSystem:
    def __init__(self, nodes: list, write_quorum: int, read_quorum: int):
        assert write_quorum + read_quorum > len(nodes), \
            "W + R must be > N for strong consistency"
        self.nodes = nodes
        self.W = write_quorum
        self.R = read_quorum
    
    def write(self, key: str, value: str) -> bool:
        successes = 0
        for node in self.nodes:
            try:
                node.set(key, value)
                successes += 1
                if successes >= self.W:
                    return True  # Quorum achieved
            except NodeError:
                continue
        return False  # Failed to reach write quorum
    
    def read(self, key: str) -> str:
        responses = []
        for node in self.nodes:
            try:
                val, timestamp = node.get_with_timestamp(key)
                responses.append((timestamp, val))
                if len(responses) >= self.R:
                    break
            except NodeError:
                continue
        
        if len(responses) < self.R:
            raise QuorumNotReached()
        
        # Return latest version (highest timestamp)
        return max(responses, key=lambda x: x[0])[1]

# Common configurations for N=3:
# W=2, R=2: W+R=4>3 -> strong consistency, can tolerate 1 node failure
# W=3, R=1: W+R=4>3 -> strong write, fast read, write requires all nodes
# W=1, R=3: W+R=4>3 -> fast write, must read all nodes
# W=1, R=1: W+R=2 < 3 -> eventual consistency, both fast
```

---

## Pseudo-code: Idempotent Write with Retries
```python
def idempotent_write(key: str, payload: dict, idempotency_id: str) -> dict:
    """
    Pattern used by Stripe, Braintree, and other payment APIs.
    Guarantees the same operation is never applied twice.
    """
    # Step 1: Check if we've seen this idempotency key before
    existing = db.query_one(
        "SELECT response FROM idempotency_records WHERE key = %s",
        (idempotency_id,)
    )
    if existing:
        # Return the stored result from the first successful call
        return json.loads(existing["response"])
    
    # Step 2: Execute the operation
    try:
        with db.transaction():
            # Do the actual work
            result = perform_operation(payload)
            
            # Store the idempotency record in the same transaction
            db.execute(
                """INSERT INTO idempotency_records (key, response, created_at) 
                   VALUES (%s, %s, NOW())
                   ON CONFLICT (key) DO NOTHING""",
                (idempotency_id, json.dumps(result))
            )
        
        return result
    
    except Exception as e:
        # Do NOT store failed results as idempotency records
        # Next retry should try again
        raise
```

## Diagram: Typical Data Path
```text
Write Path:
API -> Input validation -> DB transaction {
    -> Check idempotency key
    -> Apply business logic  
    -> Write to WAL          (crash-safe)
    -> Apply to pages        (in memory, async to disk)
    -> Write to outbox       (for async events)
    -> Commit
} -> ACK to client

Read Path (cache-aside):
API -> Check Redis cache ---HIT----> Return response
                         --MISS---> Check DB indexes
                                 -> Read from pages
                                 -> Populate cache
                                 -> Return response

Replication Path (async):
Primary -> WAL -> Stream -> Replica (5-100ms lag typical)
                         -> Analytics (seconds of lag acceptable)
                         -> Search index (minutes of lag acceptable)
```

## Mastery Exercises
1. Design schema + indexes for feed comments with pagination (handle 10M comments per post for viral content).
2. Choose consistency model for cart (AP, eventual OK) vs payment ledger (CP, must be exact).
3. Plan shard split migration with zero downtime: start with 4 shards, add 4 more.
4. Write a query that shows replica lag in PostgreSQL:
```sql
-- On primary:
SELECT 
    client_addr,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    (sent_lsn - replay_lsn) AS replication_lag_bytes
FROM pg_stat_replication;

-- On replica:
SELECT 
    now() - pg_last_xact_replay_timestamp() AS replication_delay;
```

---

## Data Modeling and Query Design Deep Dive

### Access-pattern-first modeling
Before creating any schema, document:
```python
access_patterns = {
    # Format: (frequency, query description, consistency requirement)
    "high_frequency_reads": [
        ("10K/s", "Get user profile by user_id", "eventual OK"),
        ("50K/s", "Get post by post_id", "eventual OK"),
        ("5K/s", "Get user's followers list (paginated)", "eventual OK"),
    ],
    "high_frequency_writes": [
        ("1K/s", "Create new post", "strong (durable before ack)"),
        ("500/s", "Create new user", "strong (must be unique)"),
    ],
    "medium_frequency_reads": [
        ("100/s", "Search posts by hashtag", "eventual OK"),
        ("100/s", "Get trending topics (last 1h)", "approximate OK"),
    ],
    "low_frequency_critical": [
        ("10/s", "Process payment", "serializable"),
        ("5/s", "Transfer credits between users", "serializable"),
    ],
}

# This list drives your entire schema design:
# - user_id and post_id are your primary access keys -> primary indexes
# - follower lookups -> index on (followee_id) in follows table
# - hashtag search -> inverted index or search engine
# - payment -> isolated tables with strongest isolation
```

### Schema migration safety patterns
```sql
-- Safe migration: expand-contract

-- Step 1 (Expand): Add new column (nullable, default)
ALTER TABLE users ADD COLUMN display_name VARCHAR(100);
-- Deploy: this is backward compatible (old code ignores new column)

-- Step 2 (Backfill): Populate existing rows
UPDATE users SET display_name = name WHERE display_name IS NULL;
-- Do in small batches to avoid long-running lock:
DO $$
DECLARE
    batch_size INT := 1000;
    last_id BIGINT := 0;
    max_id BIGINT;
BEGIN
    SELECT MAX(id) INTO max_id FROM users;
    WHILE last_id < max_id LOOP
        UPDATE users 
        SET display_name = name 
        WHERE id > last_id AND id <= last_id + batch_size
          AND display_name IS NULL;
        last_id := last_id + batch_size;
        PERFORM pg_sleep(0.01);  -- Rate limit: don't hammer DB
    END LOOP;
END $$;

-- Step 3: Add NOT NULL constraint (after backfill is complete)
ALTER TABLE users ALTER COLUMN display_name SET NOT NULL;
-- Deploy: new code uses display_name

-- Step 4 (Contract): Remove old column (after all code migrated)
ALTER TABLE users DROP COLUMN name;
-- Deploy: old column gone
```

### Index design checklist
```sql
-- Before adding any index, answer these questions:
-- 1. Is the predicate selective? (returns < 20% of rows)
-- 2. Does the query run frequently?
-- 3. Does the index support the filter + sort together?
-- 4. What is the write overhead? (every INSERT/UPDATE must maintain all indexes)

-- Good index candidates:
-- Primary key lookups (always indexed)
-- Foreign keys (often missed in MySQL, auto-created in PostgreSQL)
-- Where clauses with high selectivity (unique or near-unique columns)
-- ORDER BY columns when combined with WHERE

-- Bad index candidates:
-- Low cardinality columns alone (gender, status with 3 values)
-- Columns never used in WHERE/JOIN/ORDER BY
-- Redundant indexes (already covered by composite index)

-- Check index usage in PostgreSQL:
SELECT 
    schemaname,
    tablename,
    indexname,
    idx_scan,         -- Times the index was used
    idx_tup_read,     -- Tuples read via index
    idx_tup_fetch     -- Tuples actually fetched (heap access)
FROM pg_stat_user_indexes
WHERE idx_scan = 0    -- Never used! Consider dropping
ORDER BY idx_scan;
```
