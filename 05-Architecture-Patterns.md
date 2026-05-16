# Part 5: Architecture Patterns (Deep)

## 1) Monolith vs Microservices

### Monolith
A monolith is a single deployable unit. All features are compiled and deployed together. One codebase, one database, one process.

```text
Monolith structure:
  myapp/
    src/
      users/      <- user management module
      orders/     <- order management module
      payments/   <- payment module
      inventory/  <- inventory module
      shared/     <- shared utilities
    main.py       <- one entry point
    
Deploy: deploy one artifact -> everything is updated together
Database: one shared PostgreSQL database
```

**When monolith wins:**
- Small team (< 10 engineers)
- Early product (requirements still changing)
- Strong transactional consistency needed across domains
- Want fast iteration without distributed systems complexity

**Monolith strengths:**
```python
# Direct function calls = zero network latency
# This is a checkout operation spanning users, inventory, orders, payments
# All in ONE transaction!

@db.transaction()
def checkout(user_id: str, cart_id: str):
    user = UserService.get_user(user_id)           # direct call, no HTTP
    items = CartService.get_items(cart_id)         # direct call, no HTTP
    inventory = InventoryService.reserve(items)    # direct call, no HTTP
    order = OrderService.create(user, items)       # direct call, no HTTP
    payment = PaymentService.charge(user, order)   # direct call, no HTTP
    NotificationService.send_confirmation(user, order)  # direct call, no HTTP
    return order

# All 6 operations in ONE ACID transaction.
# If payment fails, EVERYTHING rolls back automatically.
# In microservices: this requires a Saga pattern with compensating transactions.
```

### Microservices
Independent services that communicate over the network. Each owns its data and can be deployed independently.

```text
Microservices structure:
  user-service/      <- owns users table, deployed independently
  order-service/     <- owns orders table, deployed independently  
  payment-service/   <- owns payments table, deployed independently
  inventory-service/ <- owns inventory table, deployed independently
  notification-service/ <- owns notification state
  
Each has its own:
  - Codebase and repository
  - Database (no shared database!)
  - Deployment pipeline
  - Team (Conway's Law: team structure mirrors service structure)
  - SLO and on-call rotation
```

**When microservices win:**
- Large organization (multiple teams needing independent deployments)
- Clear domain boundaries (payments team doesn't need to know about recommendations)
- Different scaling requirements (video processing needs GPU, API needs CPU)
- Different technology requirements (ML models in Python, APIs in Go)

**Microservices cost:**
```python
# The same checkout operation in microservices requires:
# 1. HTTP call to user-service (10ms + possible failure)
# 2. HTTP call to cart-service (10ms + possible failure)
# 3. HTTP call to inventory-service (10ms + possible failure + needs lock)
# 4. HTTP call to order-service (10ms + possible failure)
# 5. HTTP call to payment-service (10ms + possible failure)
# 6. HTTP call to notification-service (10ms + possible failure)

# Total: 60ms minimum (serial) vs <1ms for monolith
# And: no ACID transaction across services -> need Saga pattern
# And: any one service down -> checkout fails unless gracefully handled

async def checkout_microservices(user_id: str, cart_id: str):
    # Need distributed saga with compensating transactions
    saga = SagaOrchestrator()
    
    try:
        user = await user_service.get(user_id)
        items = await cart_service.get_items(cart_id)
        
        # Reserve inventory (compensating action: release reservation)
        reservation_id = await inventory_service.reserve(items)
        saga.register_compensation(inventory_service.release, reservation_id)
        
        # Create order (compensating action: cancel order)
        order = await order_service.create(user, items)
        saga.register_compensation(order_service.cancel, order.id)
        
        # Charge payment (compensating action: refund)
        payment = await payment_service.charge(user, order)
        saga.register_compensation(payment_service.refund, payment.id)
        
        # Notify (no compensation needed for notifications)
        await notification_service.send(user, order)
        
        return order
    
    except Exception as e:
        # Execute all compensating transactions in reverse order
        await saga.compensate()
        raise
```

### The modular monolith: best of both worlds
```text
Start here:
  myapp/
    modules/
      users/
        api.py      <- HTTP handlers
        service.py  <- business logic
        models.py   <- data models
        tests/
      orders/
        api.py
        service.py
        models.py
        tests/
    shared/
      database.py
      auth.py
    
Key rule: modules CAN share a database but MUST NOT call each other's 
          internal functions directly. Communication through defined interfaces.

Evolution path:
  Phase 1: Modular monolith (shared DB, no network calls)
  Phase 2: Identify bottleneck modules (e.g., video processing needs 10x more CPU)
  Phase 3: Extract that module as a service with its own DB
  Phase 4: Migrate data (dual-write pattern), switch traffic
  Phase 5: Decommission old module from monolith
```

---

## 2) Event-Driven Architecture

### Intuition
Services publish facts (events) about things that happened. Other services subscribe and react. The publisher doesn't know or care who is listening.

**Before (tight coupling):**
```python
# Order service directly calls each downstream service
def create_order(cart):
    order = save_order(cart)
    
    # Order service KNOWS about all these downstream services
    inventory_service.decrease_stock(order.items)  # What if inventory is down?
    email_service.send_confirmation(order)         # What if email is slow?
    analytics_service.track_purchase(order)        # What if analytics is overloaded?
    loyalty_service.add_points(order)              # New requirement: edit order service!
    
    return order
    # Problems:
    # 1. Order creation fails if ANY downstream service fails
    # 2. Order creation is as slow as the SLOWEST downstream service
    # 3. Every new downstream feature requires editing order service
```

**After (loose coupling with events):**
```javascript
// Order service only publishes an event. Done.
const { Kafka } = require('kafkajs');
const kafka = new Kafka({ brokers: ['kafka:9092'] });
const producer = kafka.producer();

async function createOrder(cart) {
    // Only save the order itself
    const order = await saveOrder(cart);
    
    // Publish event and return immediately
    await producer.send({
        topic: 'order-events',
        messages: [{
            key: order.id,
            value: JSON.stringify({
                type: 'ORDER_CREATED',
                orderId: order.id,
                userId: order.userId,
                items: order.items,
                total: order.total,
                createdAt: new Date().toISOString()
            })
        }]
    });
    
    return order;
    // Order creation: ~10ms (save to DB + publish event)
    // All downstream processing happens independently, asynchronously
}
```

```javascript
// Inventory service subscribes independently
const inventoryConsumer = kafka.consumer({ groupId: 'inventory-service' });

await inventoryConsumer.subscribe({ topic: 'order-events' });
await inventoryConsumer.run({
    eachMessage: async ({ message }) => {
        const event = JSON.parse(message.value.toString());
        if (event.type === 'ORDER_CREATED') {
            await decreaseStock(event.items);
        }
    }
});

// Email service subscribes independently (separate consumer group)
const emailConsumer = kafka.consumer({ groupId: 'email-service' });
// Same event, different consumer group = independent delivery

// NEW loyalty service can be added WITHOUT changing order service!
const loyaltyConsumer = kafka.consumer({ groupId: 'loyalty-service' });
```

### Event schema versioning
```python
# Events must be backward compatible (old consumers can read new events)

# V1 event:
order_created_v1 = {
    "version": "1.0",
    "type": "ORDER_CREATED",
    "order_id": "ord_123",
    "user_id": "usr_456",
    "total": 99.99
}

# V2 event: added items field (backward compatible - v1 consumers ignore new fields)
order_created_v2 = {
    "version": "2.0",
    "type": "ORDER_CREATED",
    "order_id": "ord_123",
    "user_id": "usr_456",
    "total": 99.99,
    "items": [{"product_id": "p1", "quantity": 2}],  # New: v1 consumers ignore this
    "currency": "USD"  # New: v1 consumers ignore this
}

# Breaking change (requires migration):
# Renaming "user_id" to "customer_id" breaks v1 consumers!
# Strategy: dual-publish both fields during migration period
order_created_migration = {
    "version": "2.1",
    "type": "ORDER_CREATED",
    "order_id": "ord_123",
    "user_id": "usr_456",        # Keep for backward compat
    "customer_id": "usr_456",   # New name
    # After all consumers updated, remove "user_id" in v3
}
```

---

## 3) CQRS (Command Query Responsibility Segregation)

### Intuition
Read workloads and write workloads often have very different optimal data models.

```text
Write model (Command):
  - Normalized relational tables (no redundancy, easy to update)
  - Strong consistency
  - Transactional

Read model (Query):
  - Denormalized, pre-computed aggregations
  - Optimized for specific query patterns
  - Can be stale (eventual consistency)
  - Can be in different storage (Redis, Elasticsearch, read replicas)
```

### Example: E-commerce product catalog
```sql
-- Write model: normalized relational tables
-- Easy to update a product's price without touching other tables
CREATE TABLE products (id, name, description, category_id, brand_id, created_at);
CREATE TABLE product_prices (product_id, currency, amount, effective_date);
CREATE TABLE product_inventory (product_id, warehouse_id, quantity);
CREATE TABLE product_images (product_id, url, is_primary, sort_order);

-- Write: UPDATE product_prices SET amount = 29.99 WHERE product_id = 'p1'
-- Simple, normalized, atomic

-- Problem: Read model for product listing page requires:
-- JOIN products, product_prices, product_inventory, product_images, brands, categories
-- Complex joins, slow for 100K concurrent reads
```

```python
# CQRS: maintain separate read model optimized for product listing

# Command side: write to normalized tables
def update_product_price(product_id: str, new_price: float, currency: str):
    # Write to normalized tables (source of truth)
    db.execute(
        "UPDATE product_prices SET amount=$1 WHERE product_id=$2 AND currency=$3",
        (new_price, product_id, currency)
    )
    # Publish event to update read model
    event_bus.publish("PRODUCT_PRICE_UPDATED", {
        "product_id": product_id,
        "new_price": new_price,
        "currency": currency
    })

# Query side: read from denormalized view in Redis
async def get_product_listing(product_id: str) -> dict:
    # Single key lookup in Redis, no joins needed
    return await redis.hgetall(f"product:listing:{product_id}")

# Event handler: update read model when data changes
async def handle_product_price_updated(event: dict):
    product_id = event["product_id"]
    
    # Rebuild the denormalized product listing document
    product = await db.fetch_product_with_all_joins(product_id)
    
    # Update Redis read model
    await redis.hmset(f"product:listing:{product_id}", {
        "id": product.id,
        "name": product.name,
        "price_usd": product.price_usd,
        "image_url": product.primary_image_url,
        "brand": product.brand_name,
        "category": product.category_name,
        "in_stock": product.total_inventory > 0,
        "updated_at": time.time()
    })
    await redis.expire(f"product:listing:{product_id}", 3600)
```

---

## 4) Transactional Outbox Pattern

### The problem it solves
```python
# PROBLEM: Database write + event publish are NOT atomic

def create_order(cart):
    order = db.save(cart)  # Succeeds
    
    # What if this fails? (Kafka down, network error, process crash)
    kafka.publish("ORDER_CREATED", order)  # Can fail!
    
    # Result: order created but no event published
    # Inventory never decremented, email never sent, analytics missed
    # Inconsistent system state!
```

```python
# SOLUTION: Transactional Outbox
# Save order AND outbox entry in ONE transaction
# Separate process reliably publishes from outbox to Kafka

def create_order_with_outbox(cart):
    with db.transaction():
        # Save the business data
        order = db.save_order(cart)
        
        # Save the event to outbox TABLE (same transaction!)
        db.execute("""
            INSERT INTO outbox (id, event_type, payload, status, created_at)
            VALUES (%s, %s, %s, 'pending', NOW())
        """, (uuid4(), 'ORDER_CREATED', json.dumps(order.to_dict())))
        
        # If this transaction commits, BOTH order and outbox are written
        # If it fails, BOTH are rolled back
    
    return order
    # The outbox worker will publish to Kafka asynchronously
```

```python
# Outbox worker: polls outbox table and publishes to Kafka
async def outbox_worker():
    while True:
        # Fetch pending events (with lock to prevent duplicate processing)
        pending = db.execute("""
            SELECT id, event_type, payload
            FROM outbox
            WHERE status = 'pending' 
            AND created_at < NOW() - INTERVAL '1 second'  -- brief delay for ordering
            ORDER BY created_at
            LIMIT 100
            FOR UPDATE SKIP LOCKED  -- Skip rows locked by other workers
        """)
        
        for event in pending:
            try:
                # Publish to Kafka
                await kafka.publish(
                    topic=event.event_type.lower().replace('_', '-'),
                    key=event.id,
                    value=event.payload
                )
                
                # Mark as published
                db.execute(
                    "UPDATE outbox SET status='published', published_at=NOW() WHERE id=%s",
                    (event.id,)
                )
                
            except Exception as e:
                # Leave as 'pending' to retry next poll
                logger.error(f"Failed to publish event {event.id}: {e}")
        
        await asyncio.sleep(0.5)  # Poll every 500ms

# Alternative: Use Debezium CDC (Change Data Capture)
# Reads PostgreSQL WAL directly, publishes changes to Kafka
# No polling, lower latency, no outbox table needed
```

### CDC (Change Data Capture)
```text
Debezium / Maxwell / pglogical architecture:

PostgreSQL WAL -> Debezium Connector -> Kafka -> Consumers

Debezium reads PostgreSQL's WAL as a stream of changes.
Every INSERT/UPDATE/DELETE becomes a Kafka event.

Benefits over outbox polling:
- No polling delay (WAL is immediate)
- No outbox table to maintain
- Captures changes from ANYWHERE (not just app code)

Use for:
- Search indexing (every product update -> Elasticsearch)
- Analytics (every event -> data warehouse)
- Cache invalidation (every user update -> delete Redis key)
- Audit logging (every change -> immutable audit log)
```

---

## 5) Saga Pattern

### The problem
```text
Business transactions often span multiple services.
You need "all-or-nothing" semantics but cannot use distributed 2PC (slow, fragile).

Example: Hotel + Flight + Car rental booking
  - Book hotel: success
  - Book flight: success  
  - Book car: FAILS (sold out)
  - What do we do about the hotel and flight we already booked?
  -> Need to CANCEL them (compensating transactions)
```

### Orchestration-based Saga
```python
# Central orchestrator coordinates the saga
class BookingOrchestrator:
    """
    Pros: Clear visibility of saga state, easier debugging, single place to change flow
    Cons: Orchestrator can become a bottleneck, slight coupling to orchestrator
    """
    
    def __init__(self):
        self.steps = [
            {
                "name": "book_hotel",
                "execute": hotel_service.book,
                "compensate": hotel_service.cancel
            },
            {
                "name": "book_flight", 
                "execute": flight_service.book,
                "compensate": flight_service.cancel
            },
            {
                "name": "book_car",
                "execute": car_service.book,
                "compensate": car_service.cancel
            },
            {
                "name": "process_payment",
                "execute": payment_service.charge,
                "compensate": payment_service.refund
            }
        ]
    
    async def execute(self, booking_request: dict) -> dict:
        completed_steps = []
        
        for step in self.steps:
            try:
                result = await step["execute"](booking_request)
                completed_steps.append((step, result))
                booking_request["results"][step["name"]] = result
                
            except Exception as e:
                # Compensate all completed steps in reverse order
                for completed_step, step_result in reversed(completed_steps):
                    try:
                        await completed_step["compensate"](step_result)
                    except Exception as comp_error:
                        # Log compensation failure - may need manual intervention
                        logger.critical(
                            f"Compensation failed for {completed_step['name']}: {comp_error}"
                        )
                        await alert_on_call(completed_step["name"], comp_error)
                
                raise BookingFailedError(f"Booking failed at step {step['name']}: {e}")
        
        return booking_request["results"]
```

### Choreography-based Saga
```python
# Services react to events - no central coordinator
# Each service publishes events when it completes its step

# Hotel service
async def handle_booking_initiated(event):
    if event["type"] == "BOOKING_INITIATED":
        try:
            hotel = await book_hotel(event["booking_id"], event["hotel_params"])
            await publish("HOTEL_BOOKED", {"booking_id": event["booking_id"], "hotel": hotel})
        except Exception:
            await publish("HOTEL_BOOKING_FAILED", {"booking_id": event["booking_id"]})

# Flight service listens for HOTEL_BOOKED
async def handle_hotel_booked(event):
    if event["type"] == "HOTEL_BOOKED":
        try:
            flight = await book_flight(event["booking_id"], event["flight_params"])
            await publish("FLIGHT_BOOKED", {"booking_id": event["booking_id"], "flight": flight})
        except Exception:
            # Must undo hotel booking
            await publish("FLIGHT_BOOKING_FAILED", {"booking_id": event["booking_id"]})

# Hotel service listens for FLIGHT_BOOKING_FAILED to compensate
async def handle_flight_booking_failed(event):
    if event["type"] == "FLIGHT_BOOKING_FAILED":
        booking = await get_booking(event["booking_id"])
        await cancel_hotel(booking.hotel_reservation_id)
        await publish("HOTEL_CANCELLED", {"booking_id": event["booking_id"]})

# Pros: fully decoupled, no single point of failure
# Cons: hard to track overall saga state, debugging is complex
```

---

## 6) API Gateway

### Responsibilities
```python
# API Gateway as a middleware chain
class APIGateway:
    def __init__(self):
        self.middleware = [
            RateLimiter(redis_client),     # 1. Rate limiting (protect backend)
            AuthMiddleware(jwt_secret),    # 2. Authentication
            AuthzMiddleware(policy_store), # 3. Authorization (what can user do?)
            RequestValidator(),            # 4. Input validation
            RequestRouter(services_map),   # 5. Route to correct service
            ResponseTransformer(),         # 6. Normalize response format
        ]
    
    async def handle(self, request: Request) -> Response:
        for mw in self.middleware:
            result = await mw.process(request)
            if result.should_stop:
                return result.response  # e.g., 401 Unauthorized
            request = result.modified_request
        
        return await self.proxy_to_service(request)

# What NOT to put in API gateway:
# - Business logic ("if user is premium, apply 20% discount")
# - Database queries
# - Heavy computation
# - Domain-specific transformations
# These belong in services!
```

---

## 7) Service Mesh

### What it solves
```text
Without service mesh, every service implements:
  - mTLS (mutual authentication)
  - Retry logic
  - Circuit breakers
  - Distributed tracing
  - Rate limiting
  - Traffic routing

This leads to:
  - Logic duplicated in Go, Python, Node.js services
  - Inconsistent implementation (one service's retry doesn't respect another's timeout)
  - Hard to update (change retry policy = update all services)
```

```text
With service mesh (e.g., Istio with Envoy sidecar):
  App container ←→ Sidecar proxy ←→ Network ←→ Sidecar proxy ←→ App container
  
  All networking concerns handled by sidecar, not app code.
  App just makes plain HTTP calls to localhost.
  
  Sidecar provides:
  - mTLS automatically (every service-to-service call is encrypted)
  - Circuit breaker (configurable without code changes)
  - Retry policy (configurable without code changes)
  - Distributed tracing (automatic trace headers)
  - Traffic shaping (canary releases: send 5% to v2)
```

```yaml
# Istio VirtualService: traffic splitting for canary deployment
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: checkout-service
spec:
  hosts:
    - checkout-service
  http:
    - route:
        - destination:
            host: checkout-service
            subset: v1
          weight: 95  # 95% to stable version
        - destination:
            host: checkout-service
            subset: v2
          weight: 5   # 5% to new version (canary)
```

---

## 8) Backpressure Handling

### Why backpressure matters
```text
Without backpressure:
  Producer (10,000 messages/second)
    -> Queue (grows infinitely until OOM crash)
    -> Consumer (can only process 1,000 messages/second)

System crashes when queue exhausts memory (usually ~30 minutes into load test).

With backpressure:
  Producer (10,000 messages/second)
    -> Queue (bounded at 10,000 max)  <- rejects when full
  
  When queue is full:
    Option A: Reject new messages (499 Service Unavailable)
    Option B: Block producer (TCP backpressure, PAUSE frames)
    Option C: Drop low-priority messages (load shedding)
    Option D: Scale up consumers
```

```python
import asyncio
from asyncio import Queue

class BackpressureQueue:
    """
    Bounded queue with multiple backpressure strategies.
    """
    
    def __init__(self, max_size: int = 1000):
        self.queue = Queue(maxsize=max_size)
        self.dropped = 0
        self.rejected = 0
    
    async def enqueue_or_reject(self, item) -> bool:
        """Strategy: reject if full (return 429 to caller)"""
        if self.queue.full():
            self.rejected += 1
            return False  # Caller should return 429
        await self.queue.put(item)
        return True
    
    async def enqueue_or_drop_oldest(self, item) -> None:
        """Strategy: drop oldest item when full (keep newest)"""
        if self.queue.full():
            # Remove oldest item from queue
            try:
                self.queue.get_nowait()
                self.dropped += 1
            except asyncio.QueueEmpty:
                pass
        await self.queue.put(item)
    
    async def enqueue_or_block(self, item, timeout: float = 5.0) -> bool:
        """Strategy: block producer until space available"""
        try:
            await asyncio.wait_for(self.queue.put(item), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False  # Timeout: reject the request

# Load shedding: different strategies for different request types
class PriorityLoadShedder:
    """
    Under overload, shed low-priority requests first.
    
    Priority tiers:
    1. Critical (payment, auth): never shed
    2. High (order creation): shed if CPU > 90%  
    3. Medium (feed loading): shed if CPU > 70%
    4. Low (analytics, recommendations): shed if CPU > 50%
    """
    
    CPU_THRESHOLDS = {
        "critical": 1.0,  # Never shed
        "high": 0.90,
        "medium": 0.70,
        "low": 0.50,
    }
    
    def should_process(self, priority: str) -> bool:
        cpu_usage = get_cpu_usage()
        threshold = self.CPU_THRESHOLDS.get(priority, 0.50)
        return cpu_usage < threshold
```

---

## 9) Rate Limiting Algorithms (Comparison)

```python
rate_limiting_algorithms = {
    "fixed_window": {
        "description": "Count requests in fixed time windows (1 minute, 1 hour)",
        "pros": "Extremely simple, O(1) time and space",
        "cons": "Boundary attacks: burst 2x at window boundary",
        "use_when": "Approximate limiting, simple quotas, high performance needed",
        "implementation": "INCR key:floor(now/window), EXPIRE window",
    },
    "sliding_window_log": {
        "description": "Store timestamp of every request in sorted set",
        "pros": "Perfectly accurate (no boundary attack)",
        "cons": "Memory: O(requests_in_window) per user",
        "use_when": "Strict accuracy required, high-value API limits",
        "implementation": "ZADD with timestamp, ZRANGEBYSCORE to count window",
    },
    "sliding_window_counter": {
        "description": "Hybrid: interpolate between two fixed windows",
        "pros": "Good accuracy with O(1) space",
        "cons": "Slightly inaccurate at window boundaries (up to ~5% error)",
        "use_when": "Best default choice: accurate enough, efficient",
        "implementation": "Two fixed window counters, weighted interpolation",
    },
    "token_bucket": {
        "description": "Tokens added at fixed rate, consumed per request",
        "pros": "Handles bursts naturally, smooth rate enforcement",
        "cons": "Slightly more complex to implement correctly",
        "use_when": "API rate limiting with burst allowance, traffic shaping",
        "implementation": "Track tokens and last_refill timestamp",
    },
    "leaky_bucket": {
        "description": "Requests drain from bucket at fixed rate (smooths bursts)",
        "pros": "Enforces absolutely smooth output rate",
        "cons": "Poor burst handling (doesn't let you use saved capacity)",
        "use_when": "Packet shaping, smooth downstream call rates",
        "implementation": "Fixed-rate drain with bounded queue",
    },
}
```

---

## Exercises

1. **Monolith to microservices:** Take a checkout monolith. What single service would you extract first? Why? What data does it need? What events does it emit?

2. **Saga implementation:** Implement an orchestrated Saga for a 3-step workflow: create-order -> charge-payment -> send-email. Include compensation logic.

3. **Outbox pattern:** Add a transactional outbox to a simple order service. Write the outbox poller. Test that: (a) no event lost if Kafka is down, (b) events are published exactly once.

4. **API gateway design:** Design an API gateway that supports: JWT auth, per-user rate limiting (100 req/min), routing to 3 different backend services, and request logging.

---

## Boundary Design and Team Topology Addendum

### Service boundary rules
```text
Align boundaries with business capability, not technical layers.

BAD (technical layers):
  "Database Service" (owns all data)
  "API Service" (owns all HTTP endpoints)
  "Frontend Service" (owns all UI)
  -> Every feature change touches all 3 services

GOOD (business capabilities):
  "User Service" (everything about user identity, auth, profiles)
  "Order Service" (everything about orders, cart, checkout)
  "Payment Service" (everything about charging, refunds, billing)
  -> A new payment feature only touches Payment Service
```

```python
# Data ownership rule: each service owns its data completely
# NO shared database between services!

# BAD: payment service reads directly from user service's DB
def get_user_credit_limit(user_id: str) -> float:
    # Direct DB query to user service's database!
    return user_db.query("SELECT credit_limit FROM users WHERE id = %s", user_id)

# GOOD: call user service API
async def get_user_credit_limit(user_id: str) -> float:
    response = await http.get(f"http://user-service/users/{user_id}/credit-limit")
    return response.json()["credit_limit"]

# EVEN BETTER: user service publishes user data as events
# Payment service caches relevant user data locally
# No synchronous call needed at payment time
```

### Contract discipline
```python
# API versioning: breaking changes require new version
routes = {
    "/v1/users/{id}":   old_user_handler,   # v1 still works (3-month deprecation window)
    "/v2/users/{id}":   new_user_handler,   # v2 with new schema
}

# Deprecation process:
# 1. Add Deprecation header: Deprecation: Sat, 01 Jan 2025 00:00:00 GMT
# 2. Add Sunset header: Sunset: Sun, 01 Apr 2025 00:00:00 GMT
# 3. Log which clients are still using deprecated version
# 4. Contact teams using deprecated version
# 5. Remove on Sunset date
```

### When NOT to use microservices
```text
Red flags that microservices will hurt you:
1. Small team (< 10 engineers): operational overhead will dominate feature time
2. Unclear domain boundaries: splitting at wrong seams creates distributed monolith
3. No CI/CD maturity: deploying 20 services without automation = chaos
4. No distributed tracing: debugging failures across services without Jaeger/Zipkin is painful
5. Shared database: having separate services share one database gives worst of both worlds
6. Synchronous coupling everywhere: microservices calling each other synchronously in chains
   is just distributed monolith with more failure modes

The extract-when-needed rule:
- Start modular monolith
- Identify module that needs to scale differently or is owned by different team
- Extract that single module
- Validate it works well as a service before extracting next one
```
