# Part 1: Foundations (Deep)

> **How to use this file:** For every topic, study in this strict flow:
> 1) Intuition 2) Problem 3) Naive approach 4) Evolution 5) Internals 6) Tradeoffs 7) Real-world usage 8) Pseudo-code 9) Diagram 10) Interview explanation.

---

## 1) What is System Design?

### 1. Intuition
System design is the discipline of turning product requirements into a reliable, scalable, and operable architecture under constraints (time, money, team size, regulation, and failure reality).

Think of it like designing a city. You have to plan roads (networking), water supply (data pipelines), power grid (compute), buildings (services), and emergency services (failure handling) — all before the first citizen arrives. And then it has to scale from 100 people to 10 million without being torn down and rebuilt from scratch.

### 2. Problem it solves
Without design, software works in demos but fails in production: latency spikes, outages, data loss, impossible deployments, and expensive maintenance.

Real failure examples:
- Reddit went down in 2012 due to database overload from no caching strategy.
- Knight Capital lost $440 million in 45 minutes due to a deployment without rollback capability.
- GitHub had a 24-hour outage in 2018 due to a split-brain in their replicated MySQL setup.

### 3. Naive approach and limits
Naive: "Just code features quickly."
Limitations: no scaling plan, no failure handling, poor observability, fragile coupling.

```python
# Naive approach: everything in one function, no separation of concerns
def handle_checkout(user_id, cart_id):
    user = db.query("SELECT * FROM users WHERE id = %s", user_id)
    cart = db.query("SELECT * FROM carts WHERE id = %s", cart_id)
    items = db.query("SELECT * FROM cart_items WHERE cart_id = %s", cart_id)
    
    # Check inventory (no locking, race condition!)
    for item in items:
        stock = db.query("SELECT stock FROM inventory WHERE product_id = %s", item.product_id)
        if stock < item.quantity:
            raise Exception("Out of stock")
    
    # Charge card (no idempotency, can double charge on retry!)
    charge = payment_service.charge(user.card_token, cart.total)
    
    # Reduce inventory (no transaction, can go negative if concurrent!)
    for item in items:
        db.execute("UPDATE inventory SET stock = stock - %s WHERE product_id = %s",
                   item.quantity, item.product_id)
    
    # Send email (synchronous, blocks checkout if email service is down!)
    email_service.send(user.email, "Your order is confirmed!")
    
    return {"status": "success", "charge_id": charge.id}
```

Problems with the above:
- Race condition: two users can buy the last item simultaneously.
- No idempotency: retrying on timeout double-charges the user.
- No transaction: inventory update can fail after charge.
- Synchronous email: if email is down, checkout fails.

### 4. Optimized evolution
```python
# Better approach: idempotency, transactions, async side effects
def handle_checkout(user_id, cart_id, idempotency_key: str):
    # Check if we already processed this exact request
    existing = db.query(
        "SELECT result FROM idempotency_keys WHERE key = %s", 
        idempotency_key
    )
    if existing:
        return json.loads(existing.result)
    
    with db.transaction():
        # Lock rows for update (prevents race condition)
        items = db.query(
            "SELECT * FROM cart_items WHERE cart_id = %s FOR UPDATE", 
            cart_id
        )
        
        # Check and reserve inventory atomically
        for item in items:
            updated = db.execute(
                """UPDATE inventory 
                   SET stock = stock - %s, reserved = reserved + %s
                   WHERE product_id = %s AND stock >= %s""",
                item.quantity, item.quantity, item.product_id, item.quantity
            )
            if updated.rowcount == 0:
                raise InsufficientStockError(item.product_id)
        
        # Create order record
        order = db.execute(
            "INSERT INTO orders (user_id, cart_id, status) VALUES (%s, %s, 'pending')",
            user_id, cart_id
        )
        
        # Store in outbox for async processing (transactional outbox pattern)
        db.execute(
            """INSERT INTO outbox (event_type, payload) 
               VALUES ('ORDER_CREATED', %s)""",
            json.dumps({"order_id": order.id, "user_id": user_id})
        )
        
        # Store idempotency record
        result = {"status": "success", "order_id": order.id}
        db.execute(
            "INSERT INTO idempotency_keys (key, result) VALUES (%s, %s)",
            idempotency_key, json.dumps(result)
        )
    
    # Payment is triggered asynchronously by order worker
    # Email is sent when payment succeeds (event-driven)
    return result
```

### 5. Deep internals
Design is not only components; it is **interfaces, contracts, and failure semantics**:
- Timeouts: every network call must have a timeout. What is your timeout for the payment API? 5 seconds? 30 seconds?
- Retries: can you safely retry? Only if the operation is idempotent (safe to call twice with same result).
- Backoff: exponential backoff prevents retry storms. Start at 100ms, then 200ms, 400ms, 800ms...
- Idempotency: the same operation key should always produce the same result.
- Consistency contracts: does the user always see their own writes? Can they see stale data from a replica?
- Schema evolution: if you add a field to your API response, do old clients break?
- Operational model: how do you deploy this? How do you roll back? What alerts fire?

### 6. Tradeoffs
Every architectural decision has a cost:

| Decision | Benefit | Cost |
|---|---|---|
| Microservices | Independent scaling and deployment | Network failures, distributed tracing complexity |
| Strong consistency | Correct data always | Higher latency, potential unavailability |
| Caching | Lower DB load | Stale data, invalidation complexity |
| Async processing | Better throughput | Complex failure handling, eventual consistency |
| Sharding | More write capacity | Cross-shard queries harder, rebalancing pain |

### 7. Real-world usage
FAANG systems evolve through iterative redesigns. Almost no large system is "designed once."

- Instagram started on a single PostgreSQL server, added read replicas, then partitioned.
- Uber originally used a monolith, evolved to microservices as teams grew.
- Amazon moved from monolith to services over years, writing the "API Mandate" memo.

### 8. Pseudo-code (thinking loop)
```text
while (system_in_production):
  observe()         # What are the metrics saying?
  find_bottleneck() # CPU? DB? Network? Queue?
  redesign_smallest_effective_surface()  # Don't over-engineer
  validate()        # Does the metric improve?
```

### 9. Diagram
```text
Clients
  -> API Edge (rate limiting, auth, TLS termination)
    -> Stateless Services (business logic, can scale horizontally)
      -> Cache / DB / Queue / Search (stateful, needs careful scaling)
        -> Observability + Ops Control Plane (metrics, logs, traces)
          -> Alerts -> On-call -> Runbook -> Fix
```

---

## Back-of-the-Envelope Estimation

### Why this matters
In a 45-minute interview, you have ~5 minutes to estimate scale. Your architecture MUST be sized correctly. Proposing a single DB for 1B users or over-engineering for 1K users both signal poor judgment.

### The estimation framework

**Step 1: Establish scale**
- DAU (Daily Active Users)
- QPS (Queries Per Second)
- Data growth per day/month

**Step 2: Calculate QPS**
```python
def estimate_qps(dau: int, requests_per_user_per_day: int, peak_factor: float = 3.0):
    """
    peak_factor: traffic is NOT uniform. 
    Assume 3x average during peak hours (typically 6pm-10pm local time).
    """
    avg_qps = (dau * requests_per_user_per_day) / 86400  # seconds in a day
    peak_qps = avg_qps * peak_factor
    return {
        "avg_qps": round(avg_qps),
        "peak_qps": round(peak_qps),
        "note": f"1 server handles ~1000 QPS for simple requests"
    }

# Twitter-scale example
result = estimate_qps(
    dau=200_000_000,       # 200M DAU
    requests_per_user_per_day=50,  # timeline views, likes, posts
    peak_factor=3.0
)
# avg_qps: 115,740 | peak_qps: 347,222
# Need ~350 app servers at 1000 QPS each
print(result)

# Instagram feed example
result = estimate_qps(
    dau=500_000_000,       # 500M DAU
    requests_per_user_per_day=30,  # feed loads, story views
    peak_factor=2.5
)
print(result)
```

**Step 3: Calculate storage**
```python
def estimate_storage(
    write_qps: int,
    record_size_bytes: int,
    retention_years: int = 5
):
    """
    Calculate total storage needed.
    Always add 3x for:
    - Replication (3 replicas typically)
    - Indexes (~20-30% overhead)
    - WAL and temp files
    """
    writes_per_day = write_qps * 86400
    raw_storage_per_year_gb = (writes_per_day * record_size_bytes * 365) / (1024**3)
    total_with_overhead_gb = raw_storage_per_year_gb * retention_years * 3
    return {
        "writes_per_day": writes_per_day,
        "raw_gb_per_year": round(raw_storage_per_year_gb, 2),
        "total_with_overhead_gb": round(total_with_overhead_gb, 2),
        "total_with_overhead_tb": round(total_with_overhead_gb / 1024, 2)
    }

# Tweet storage example
# 500M tweets/day, each tweet ~500 bytes
tweet_storage = estimate_storage(
    write_qps=5787,        # 500M / 86400
    record_size_bytes=500,
    retention_years=5
)
# ~1.2TB/year raw -> ~18TB with overhead over 5 years
print(tweet_storage)

# Photo metadata storage (photos stored separately in object storage)
photo_storage = estimate_storage(
    write_qps=1157,        # 100M uploads/day
    record_size_bytes=1000, # metadata record
    retention_years=5
)
print(photo_storage)
```

### Memory rule-of-thumb numbers to memorize
```
Operation              Latency
L1 cache reference     0.5 ns
L2 cache reference     7 ns
RAM read               100 ns
SSD random read        150 microseconds (150,000 ns)
HDD random read        10 ms (10,000,000 ns)
Network same DC        0.5 ms
Network cross-region   150 ms

Storage sizes
1 ASCII character = 1 byte
1 UUID = 16 bytes
Average tweet = 284 chars = ~500 bytes with metadata
Average user profile = ~1 KB
Average photo metadata = ~1 KB
Average compressed photo = ~100 KB
Average video (1 min 720p) = ~50 MB
```

---

## Advanced Roadmap: Foundations

### Topics and subtopics
- Requirement analysis: users, product flows, exclusions, business constraints.
- Non-functional requirements: latency, availability, consistency, durability, privacy, cost.
- Scale math: QPS, peak factor, concurrency, storage growth, bandwidth, fanout.
- Failure thinking: partial failure, retry storms, overload, data loss, stale reads.
- System evolution: MVP, single-region scale, multi-region scale, platform maturity.

### Example: E-commerce checkout
```text
Client -> API Gateway -> Checkout Service
                    -> Cart Service (read cart contents)
                    -> Inventory Service (reserve stock)
                    -> Payment Service (charge card)
                    -> Order DB (persist order)
                    -> Outbox -> Notification Worker -> Email/SMS
                             -> Analytics Worker -> Data warehouse
```

Key decisions:
- Payment requires idempotency because clients retry on network timeout.
- Inventory reservation needs compensation (release stock) if payment fails.
- Email notification must be async so it does not block checkout response.
- Order status must be durable before publishing events.

```python
# Idempotency key pattern - critical for payment APIs
import hashlib
import time

def generate_idempotency_key(user_id: str, cart_id: str) -> str:
    """
    Key must be:
    1. Unique per logical operation (not per retry)
    2. Scoped to the right entity (user + cart, not just user)
    3. Time-bounded to avoid stale results from previous orders
    """
    # Include a time window so same user can checkout again tomorrow
    time_window = int(time.time() / 3600)  # changes every hour
    raw = f"{user_id}:{cart_id}:{time_window}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]

# Usage
key = generate_idempotency_key("user_123", "cart_456")
# client sends this key in every retry attempt
# server returns same result if key seen before
```

---

## Rigorous Design Document Template

Use this template for every serious design.

### 1. Scope
```text
In scope:
- User authentication (registration, login, JWT token)
- Post creation (text only, max 280 chars)
- Home timeline (last 50 posts from follows)
- Follow/unfollow

Out of scope (to discuss but not design today):
- Direct messaging
- Media uploads
- Notifications
- Analytics dashboard
- Ads system
```

### 2. Requirements

**Functional:**
- User actions: register, login, post tweet, follow user, view timeline.
- Admin actions: ban user, remove content.
- Background workflows: fanout timeline updates.

**Non-functional (be specific with numbers):**
- Latency: timeline API P95 < 300ms, P99 < 500ms.
- Availability: 99.99% (52 minutes downtime/year).
- Durability: tweets must not be lost after successful write ack.
- Consistency: timeline can be eventually consistent (few seconds of lag acceptable).
- Scale: 200M DAU, 500M tweets/day, 50B timeline reads/day.

### 3. Architecture
```text
Client -> CDN/WAF (edge caching, DDoS protection)
       -> Global Load Balancer (geo-routing)
         -> API Gateway (auth, rate limiting, routing)
           -> Tweet Service -> Tweet DB (Postgres, sharded)
           -> Timeline Service -> Timeline Cache (Redis) -> Timeline Store (Cassandra)
           -> Follow Service -> Graph DB (Postgres)
           -> Fanout Workers (subscribed to tweet events)
         -> Observability (Prometheus, Grafana, Jaeger)
```

### 4. Correctness checklist
- What is acknowledged to the user? Tweet stored durably → ack.
- What is durably written before acknowledgment? Tweet row in DB + outbox event.
- What can be retried? Fanout workers (idempotent timeline insert).
- What is idempotent? Timeline insert uses UPSERT on (user_id, tweet_id).
- What can be duplicated without harm? Fanout events (deduped by idempotent consumer).
- What can be stale? Timeline (seconds of lag is acceptable).

### 5. Failure table
```text
Failure                  User impact              Mitigation
Cache unavailable        Higher DB load           Bypass cache, rate-limit cache misses
DB primary slow          Write latency/error      Circuit breaker, failover, degrade writes
Queue backlog            Delayed async work       Backpressure, autoscale, DLQ
Third-party timeout      Partial workflow fail    Timeout, retry, compensation transaction
Bad deploy               Error spike              Canary, rollback within 5 minutes
Fanout service down      Stale timelines          Merge from author timelines at read time
```

---

## 2) Horizontal vs Vertical Scaling

### Intuition
Scaling means increasing capacity. You can buy a bigger box (vertical) or more boxes (horizontal).

**Vertical analogy:** Upgrading from a bicycle to a motorcycle to a truck.
**Horizontal analogy:** Hiring more bicycle couriers and splitting the deliveries.

### Problem
Traffic, data, and concurrency grow over time. A single server eventually hits hardware limits (CPU, RAM, network I/O).

### Naive
Keep upgrading machine size forever — eventually you hit the biggest AWS instance and it's still not enough, or the cost is prohibitive.

### Evolution
1. **Vertical first** (fastest operationally, no code changes needed).
2. **Make services stateless** (sessions in Redis, not server memory).
3. **Add load balancer + multiple app instances.**
4. **Partition data layer** (read replicas first, then sharding if needed).

### Internals

The key challenge with horizontal scaling: **state**.

```python
# WRONG: Session stored on server memory (breaks with multiple servers)
sessions = {}  # in-memory

def login(user_id):
    token = generate_token()
    sessions[token] = {"user_id": user_id, "created_at": time.time()}
    return token

def verify(token):
    session = sessions.get(token)  # only works on SAME server!
    return session

# RIGHT: Session stored in external Redis (works with any server)
import redis
r = redis.Redis(host='redis-cluster', port=6379)

def login(user_id):
    token = generate_token()
    r.setex(
        f"session:{token}",
        3600,  # 1 hour TTL
        json.dumps({"user_id": user_id, "created_at": time.time()})
    )
    return token

def verify(token):
    data = r.get(f"session:{token}")
    return json.loads(data) if data else None
```

### Autoscaling logic
```python
# Simplified autoscaling decision logic (like AWS Auto Scaling)
def should_scale(metrics: dict) -> str:
    cpu_util = metrics["cpu_utilization_percent"]
    p95_latency = metrics["p95_latency_ms"]
    slo_latency = 300  # ms
    
    # Scale out
    if cpu_util > 70 or p95_latency > slo_latency:
        return "scale_out"
    
    # Scale in (only after sustained low load)
    if cpu_util < 25 and p95_latency < slo_latency * 0.5:
        # Check this has been true for 30 minutes to avoid flapping
        return "scale_in_candidate"
    
    return "no_action"
```

### Tradeoffs
- **Vertical:** Simpler, no distributed coordination needed. But hardware limits exist, larger failure blast radius (1 server fails → everything down), and more expensive at the high end.
- **Horizontal:** Resilient and elastic. But requires stateless design, distributed coordination, and more complex deployment.

### Diagram
```text
Vertical: [App on 1 huge 64-core node]   <- single point of failure

Horizontal: LB -> [App1 (4 cores)]
               -> [App2 (4 cores)]
               -> [App3 (4 cores)]       <- any node can fail
               -> [App4 (4 cores)]       <- scale by adding more
```

### Interview
Say: "Scale-up buys time; scale-out buys long-term resiliency. I'd scale up first for simplicity, make the service stateless early, then scale out as load demands."

**Exercise:** Migrate a sticky-session architecture to stateless JWT + Redis session store.

---

## 3) Latency vs Throughput

### Intuition
- **Latency:** time for one request (like how long it takes one car to cross a bridge).
- **Throughput:** number of requests completed per unit time (how many cars cross per hour).

You can have high throughput with high latency (a slow but wide highway) or low latency with low throughput (a fast but narrow road). The tradeoff depends on your workload.

### Problem
Users feel latency directly (waiting for a page to load). Business cares about throughput (transactions per second). Optimizing one can hurt the other.

### The math
```python
# Little's Law: L = λW
# L = average number of requests in system
# λ = arrival rate (requests/second)
# W = average time request spends in system (latency)

def littles_law(arrival_rate: float, avg_latency_seconds: float) -> dict:
    """
    If you know arrival rate and latency, you can calculate concurrency needed.
    
    Example: API handles 1000 req/s, each request takes 50ms
    -> Need to handle 1000 * 0.05 = 50 concurrent requests in flight
    -> Size your thread pool / connection pool accordingly!
    """
    concurrency = arrival_rate * avg_latency_seconds
    return {
        "arrival_rate_rps": arrival_rate,
        "avg_latency_seconds": avg_latency_seconds,
        "avg_concurrency_in_flight": concurrency,
        "thread_pool_recommendation": int(concurrency * 1.5)  # add buffer
    }

# Practical example: checkout API
result = littles_law(
    arrival_rate=500,     # 500 checkout requests per second
    avg_latency_seconds=0.1  # 100ms average checkout time
)
# Need to handle 50 concurrent checkouts in flight
# Thread pool: at least 75 threads
print(result)
```

### Queueing theory insight
```text
As utilization (traffic / capacity) approaches 100%, wait time grows NON-LINEARLY.

Utilization 50% → wait ≈ 1x service time
Utilization 80% → wait ≈ 4x service time
Utilization 90% → wait ≈ 9x service time
Utilization 95% → wait ≈ 19x service time
Utilization 99% → wait ≈ 99x service time

This is WHY you need autoscaling to kick in at 70% CPU, not 95%.
```

### Latency budget
Every API should have a latency budget broken down per hop:
```python
# Login API with P95 target 300ms
latency_budget = {
    "dns_lookup":         5,   # ms - only for cold requests
    "tcp_handshake":      10,  # ms
    "tls_handshake":      15,  # ms - only for new connections
    "load_balancer":      2,   # ms
    "api_gateway":        5,   # ms (auth token verification)
    "service_logic":      20,  # ms (JWT decode, input validation)
    "redis_session":      5,   # ms (check existing session)
    "postgres_user":      30,  # ms (SELECT with index)
    "password_verify":    80,  # ms (bcrypt - intentionally slow)
    "response_serialize": 3,   # ms
    "network_return":     10,  # ms
    "safety_margin":      115, # ms (40% buffer for variance)
    "total_p95_target":   300  # ms
}
# Sum: 300ms

# If postgres_user is taking 150ms (index missing!), 
# you've blown the budget with 0 safety margin
```

### Batching tradeoff
```python
# Low throughput, low latency: process immediately
def process_single(event):
    db.insert(event)  # 5ms per call
    # 1000 events = 5000ms total (5 seconds)

# High throughput, slightly higher per-item latency: batch
def process_batch(events: list, max_batch_size=100, max_wait_ms=50):
    """
    Buffer events for up to 50ms or until batch is full, then flush.
    
    Trade-off:
    - Throughput: 100 events in one 8ms DB call (vs 500ms for 100 individual calls)
    - Latency: each event waits UP TO 50ms before being inserted
    - Good for: analytics, log ingestion, notification batching
    - Bad for: payment writes (user is waiting for confirmation)
    """
    buffer = []
    for event in events:
        buffer.append(event)
        if len(buffer) >= max_batch_size:
            db.insert_many(buffer)
            buffer = []
    if buffer:
        db.insert_many(buffer)
```

---

## 4) CAP Theorem (Deep Intuition)

### Intuition
In any distributed system with two or more nodes, when a **network partition** occurs (nodes can't talk to each other), you must choose:
- **C (Consistency):** Every read returns the most recent write (or an error).
- **A (Availability):** Every request receives a response (but data might be stale).

**P (Partition Tolerance)** is not optional — partitions happen in the real world. You **must** handle them. So the real choice is **C vs A during a partition**.

### Real-world analogy
You have two ATMs (Node A and Node B) connected by a network. The network breaks. ATM A has balance $100.

- **Choose Consistency (CP):** ATM B rejects all balance queries with "system unavailable." Customers are annoyed but never see wrong data.
- **Choose Availability (AP):** ATM B allows withdrawals using its last-known balance of $100. Customer might overdraft if they withdrew from ATM A during the partition.

Banks choose CP for account balances. Shopping carts often choose AP (you can add items even if offline, merge later).

### Internals
CAP applies **during partition**. Outside partitions (normal operation), many systems can deliver both:
- Strong consistency at low-ish latency.
- High availability.

The partition is what forces the choice.

```python
# CP system example: distributed counter with strong consistency
class CPCounter:
    """
    Uses consensus (e.g., Raft/Paxos) for every operation.
    During partition: minority partition returns error.
    Never returns stale data.
    """
    def increment(self, key: str) -> int:
        # Must get majority quorum (3/5 nodes) to proceed
        # If network partition isolates this node: RAISES ERROR
        return raft_consensus.propose({"op": "increment", "key": key})

# AP system example: eventual consistency counter
class APCounter:
    """
    Each node accepts writes independently.
    During partition: both sides accept increments.
    After partition heals: merge by summing all increments.
    Might serve stale reads during partition.
    """
    def __init__(self, node_id: str):
        self.node_id = node_id
        self.local_increments = 0
    
    def increment(self, key: str) -> int:
        self.local_increments += 1  # Always succeeds, even during partition
        # Async sync to other nodes when network recovers
        async_replicate()
        return self.local_increments  # Might be stale
    
    def merge(self, other_increments: dict) -> int:
        # G-Counter CRDT: final value = sum of all node increments
        return sum(other_increments.values()) + self.local_increments
```

### Real-world examples
```text
CP systems (prefer consistency):
- ZooKeeper: config management, leader election
- etcd: Kubernetes metadata store
- Traditional SQL databases with sync replication
- HBase

AP systems (prefer availability):
- CouchDB, DynamoDB
- Cassandra (tunable, defaults to AP)
- DNS (caches stale records rather than failing)
- Shopping cart systems

Context-dependent:
- Kafka (AP for data ingestion, but ordered within partition)
- Redis (AP by default, can configure for more consistency)
```

---

## 5) PACELC

### Intuition
CAP only tells you what happens **during a partition**. But what about **normal operation** (no partition)?

Even when the network is healthy, you still trade:
- **L (Latency):** write to local node and return immediately (fast).
- **C (Consistency):** write to all replicas before returning (slow but consistent).

PACELC says: 
- If **P**artition: choose **A**vailability or **C**onsistency.
- **EL**se (no partition): choose **L**atency or **C**onsistency.

### Why it matters for design
```text
Global multi-region write example:
User in India writes a post.

Option 1 (Low Latency, Eventual Consistency - PA/EL):
  - Write to Mumbai region immediately
  - Async replicate to US/EU regions (might lag 500ms-5s)
  - US users might see slightly stale data after Indian user's post
  - Latency for Indian user: ~5ms

Option 2 (Strong Consistency, Higher Latency - PC/EC):  
  - Write to Mumbai region
  - Synchronously replicate to US/EU regions before acknowledging
  - Wait for all 3 regions to confirm
  - US users always see latest data
  - Latency for Indian user: ~300ms (cross-region round trips)
```

### Classification examples
```text
System              Partition   Else
DynamoDB (default)  AP          EL  (prioritizes latency and availability)
ZooKeeper           CP          EC  (always prioritizes consistency)
Cassandra (tunable) PA          EL  (defaults to availability/latency)
Postgres (sync rep) CP          EC  (strong consistency)
MySQL async repl    CP          EL  (partition=CP, normal=latency ok with lag)
Spanner (Google)    CP          EC  (TrueTime for global strong consistency)
```

---

## 6) Availability, Reliability, Durability

### Definitions
- **Availability:** system responds to requests (% of time it's up).
- **Reliability:** system behaves correctly over time (right answer, not just a response).
- **Durability:** acknowledged data survives failures (data not lost).

### The subtlety
A system can be:
- **Available but unreliable:** responds with 200 OK but returns cached wrong data.
- **Reliable but unavailable:** correctly refuses requests during maintenance.
- **Durable but unavailable:** data is safe but can't be read (backup exists but restore takes 4 hours).

### Nines of availability
```python
def availability_to_downtime(availability_percent: float) -> dict:
    """
    Convert availability percentage to annual downtime.
    Note: 'downtime' includes PARTIAL degradation in strict SLOs.
    """
    downtime_fraction = 1.0 - (availability_percent / 100)
    seconds_per_year = 365.25 * 24 * 3600
    
    downtime_seconds = downtime_fraction * seconds_per_year
    downtime_minutes = downtime_seconds / 60
    downtime_hours = downtime_minutes / 60
    
    return {
        "availability": f"{availability_percent}%",
        "annual_downtime_seconds": round(downtime_seconds),
        "annual_downtime_minutes": round(downtime_minutes, 1),
        "annual_downtime_hours": round(downtime_hours, 2)
    }

for slo in [99.0, 99.9, 99.95, 99.99, 99.999]:
    print(availability_to_downtime(slo))

# 99.0%   -> 3.65 days / year   (Two nines)
# 99.9%   -> 8.7 hours / year   (Three nines)
# 99.95%  -> 4.38 hours / year
# 99.99%  -> 52.6 minutes / year (Four nines) <- common target
# 99.999% -> 5.26 minutes / year (Five nines) <- very hard, expensive
```

### How to achieve each
```text
Availability:
- Multiple instances (eliminate single points of failure)
- Health checks and automatic traffic removal for unhealthy nodes
- Graceful degradation (serve cached/stale data when backend is slow)
- Fast failover (automatic, not manual)

Reliability:
- Correctness testing (unit, integration, property-based)
- Circuit breakers to prevent cascading failures
- Idempotency to prevent double-processing
- Automated rollbacks on error rate increase
- Chaos engineering (test failure scenarios proactively)

Durability:
- Write-ahead log (WAL) - data survives process crash
- Synchronous replication to at least 2 nodes before ack
- Regular backups with TESTED restore (not just backup existence)
- Point-in-time recovery (PITR) for databases
- Regular "fire drills" to practice restore
```

---

## 7) Load vs Stress vs Performance Testing

### Types
- **Smoke testing:** 1 user, verify basic correctness. "Does it work at all?"
- **Load testing:** Expected normal and peak traffic. "Does it work under real load?"
- **Stress testing:** Beyond peak until system breaks. "Where does it break and how?"
- **Soak/endurance testing:** Extended load over hours/days. "Does it leak memory over time?"
- **Spike testing:** Sudden huge traffic burst. "What happens when it's featured on the news?"

### Test matrix
```text
Test Type      Users    Duration    Goal
Smoke          1        1 min       Basic functionality
Load (normal)  100      15 min      Performance at expected load
Load (peak)    500      15 min      Performance at peak load
Stress         1000+    15 min      Find breaking point
Soak           200      8 hours     Memory leaks, connection pool exhaustion
Spike          0→2000   instant     Autoscaling, connection queuing
```

### k6 load test example
```javascript
// load_test.js - run with: k6 run load_test.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const dbLatency = new Trend('db_latency');

export const options = {
  stages: [
    { duration: '2m', target: 50 },    // ramp up to 50 users
    { duration: '5m', target: 50 },    // hold at 50 users
    { duration: '2m', target: 200 },   // ramp to 200 (2x expected peak)
    { duration: '5m', target: 200 },   // hold
    { duration: '2m', target: 0 },     // ramp down
  ],
  thresholds: {
    // SLO enforcement: these thresholds FAIL the test if breached
    'http_req_duration': ['p(95)<300', 'p(99)<500'],
    'http_req_failed':   ['rate<0.01'],    // < 1% error rate
    'errors':            ['rate<0.01'],
  },
};

export default function() {
  // Simulate realistic user behavior
  const loginRes = http.post('http://api.example.com/login', 
    JSON.stringify({ email: 'user@test.com', password: 'pass123' }),
    { headers: { 'Content-Type': 'application/json' } }
  );
  
  const loginOk = check(loginRes, {
    'login status 200': (r) => r.status === 200,
    'login < 300ms': (r) => r.timings.duration < 300,
  });
  errorRate.add(!loginOk);
  
  if (loginOk) {
    const token = loginRes.json('token');
    
    // Fetch timeline
    const timelineRes = http.get('http://api.example.com/timeline', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    check(timelineRes, {
      'timeline status 200': (r) => r.status === 200,
      'timeline < 300ms': (r) => r.timings.duration < 300,
    });
  }
  
  sleep(1); // think time between requests
}
```

### What to profile during load tests
```python
# Metrics to collect during load testing
monitoring_checklist = {
    "application": [
        "request_rate (RPS)",
        "error_rate (% 5xx)",
        "p50/p95/p99 latency",
        "active_connections",
        "thread_pool_queue_depth",
    ],
    "database": [
        "query_latency_p99",
        "connection_pool_utilization",
        "lock_wait_time",
        "slow_query_count",
        "replication_lag",
    ],
    "cache": [
        "hit_rate",
        "eviction_rate",
        "latency_p99",
        "memory_usage_percent",
    ],
    "infrastructure": [
        "cpu_utilization",
        "memory_utilization", 
        "disk_io_wait",
        "network_bytes_in_out",
        "open_file_descriptors",
    ],
}
```

---

## Foundation Mastery Questions
1. Why is idempotency a design primitive? (Because clients always retry on network timeout — your server must handle receiving the same request twice gracefully.)
2. Why is "no single point of failure" still insufficient? (Multiple failure modes can compound: correlated failures, thundering herds, cascading degradation.)
3. What is the difference between graceful degradation and hidden failure? (Degradation is intentional, visible, and communicated. Hidden failure silently returns wrong data.)
4. Why should every design include rollback strategy? (Bad deploys happen. Without rollback, you're one bad release away from an extended outage.)

---

## Advanced Foundation Layer: SLOs, Error Budgets, and Operational Semantics

### SLO Basics
- **SLI (Service Level Indicator):** A measurable metric. E.g., "ratio of successful requests in last 5 minutes."
- **SLO (Service Level Objective):** Target. E.g., "SLI >= 99.9% over 30 days."
- **SLA (Service Level Agreement):** External contract with financial penalties.

### Calculating error budgets
```python
def error_budget_calculator(slo_percent: float, period_days: int = 30) -> dict:
    """
    Error budget is the allowed "failure time" within your SLO.
    
    Usage pattern:
    - Good: spend budget on risky deploys, experiments, migrations
    - Bad: burn through budget on incidents, then freeze all changes
    """
    availability = slo_percent / 100
    error_budget_fraction = 1.0 - availability
    
    period_minutes = period_days * 24 * 60
    error_budget_minutes = period_minutes * error_budget_fraction
    
    # Burn rate: if you've used 50% of budget in first 10% of period,
    # you're burning 5x too fast
    return {
        "slo": f"{slo_percent}%",
        "period_days": period_days,
        "error_budget_minutes": round(error_budget_minutes, 1),
        "fast_burn_threshold": "alert if 2% budget used in 1 hour",
        "slow_burn_threshold": "alert if 5% budget used in 6 hours",
    }

print(error_budget_calculator(99.9, 30))
# error_budget_minutes: 43.2 minutes in a 30-day period
# Meaning: you can afford ~43 minutes of complete downtime OR
# 100% of requests failing for 43 minutes OR
# 50% of requests failing for 86 minutes OR
# 1% of requests failing forever (always)
```

### SLO-driven architecture decisions
```text
Decision: Should we use synchronous cross-region replication?

Without SLO thinking: "Strong consistency is better, always."

With SLO thinking:
- Current latency SLO: P95 < 300ms
- Cross-region replication adds ~150ms round trip
- Current P95: 120ms
- With sync replication: P95 = 270ms (barely within SLO)
- Tradeoff: meet consistency requirements but P95 is now fragile
- Alternative: async replication + read-your-writes token for 50ms lower latency

Decision: use async replication with read-your-writes, monitor closely.
```

### Operational Semantics Checklist
For each endpoint/workflow, define:
```text
Endpoint: POST /checkout
Timeout: 10 seconds (caller's deadline)
Retry policy: 3 attempts with exponential backoff (100ms, 200ms, 400ms)
Idempotency key: X-Idempotency-Key header, required
Partial failure: if payment succeeds but order insert fails, run compensation
Degradation mode: if inventory service is down, reject with 503 (cannot proceed safely)
Audit logging: log user_id, amount, cart_id, outcome, timestamp
```

### Decision log template
```text
Decision: Use Cassandra for timeline storage instead of Postgres
Date: 2024-01-15
Context: Timeline reads are 100K QPS, writes are 50K QPS, 50B rows over 5 years
Options considered:
  1. Postgres with partitioning - simpler, but won't scale to 100K QPS writes well
  2. Cassandra - designed for write-heavy time-series at massive scale
  3. DynamoDB - managed, but higher cost and vendor lock-in
Chosen option: Cassandra
Tradeoffs accepted:
  - No ACID transactions (timeline inserts are idempotent, acceptable)
  - Operational complexity (requires team training and careful data modeling)
  - Eventual consistency (acceptable for timeline, not for payment)
Rollback trigger:
  - If Cassandra stability issues require > 2 incidents/month
  - If team cannot handle operations within 3 months
```

### Foundation exercise (production realism)
Design a "place order" workflow and define:
- Consistency guarantees: order record is strongly consistent. Timeline counter is eventually consistent.
- Timeout/retry policy: payment call has 10s timeout, 3 retries with backoff.
- What user sees during downstream payment outage: "Payment service temporarily unavailable. Your cart is saved. Please try again in a moment."
- What support team sees in logs/metrics: error type: PAYMENT_TIMEOUT, order_id, user_id, retry_count, timestamps.
