# Part 1: Foundations (Deep)

> **How to use this file:** For every topic, study in this strict flow:
> 1) Intuition 2) Problem 3) Naive approach 4) Evolution 5) Internals 6) Tradeoffs 7) Real-world usage 8) Pseudo-code 9) Diagram 10) Interview explanation.

---

## 1) What is System Design?

### 1. Intuition
System design is the discipline of turning product requirements into a reliable, scalable, and operable architecture under constraints (time, money, team size, regulation, and failure reality).

### 2. Problem it solves
Without design, software works in demos but fails in production: latency spikes, outages, data loss, impossible deployments, and expensive maintenance.

### 3. Naive approach and limits
Naive: "Just code features quickly."  
Limitations: no scaling plan, no failure handling, poor observability, fragile coupling.

### 4. Optimized evolution
1. Clarify functional + non-functional requirements.
2. Estimate scale (QPS, data growth, read/write ratio).
3. Define APIs and data model.
4. Design baseline architecture.
5. Identify bottlenecks and failure points.
6. Add resilience, scaling, and observability.

### 5. Deep internals
Design is not only components; it is **interfaces, contracts, and failure semantics**:
- Timeouts, retries, backoff, idempotency.
- Consistency contracts for reads/writes.
- Schema evolution strategy.
- Operational model (deploy, rollback, monitor).

### 6. Tradeoffs
- Simplicity vs flexibility
- Correctness vs latency
- Cost vs redundancy
- Team velocity now vs maintainability later

### 7. Real-world usage
FAANG systems evolve through iterative redesigns. Almost no large system is "designed once."

### 8. Pseudo-code (thinking loop)
```text
while (system_in_production):
  observe()
  find_bottleneck()
  redesign_smallest_effective_surface()
  validate()
```

### 9. Diagram
```text
Clients
  -> API Edge
    -> Stateless Services
      -> Cache / DB / Queue / Search
        -> Observability + Ops Control Plane
```

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
                    -> Cart Service
                    -> Inventory Service
                    -> Payment Service
                    -> Order DB
                    -> Outbox -> Notification Worker
```

Key decisions:
- Payment requires idempotency because clients retry.
- Inventory reservation needs compensation if payment fails.
- Email notification must be async so it does not block checkout.
- Order status must be durable before publishing events.

### Real systems to study
- Amazon-style checkout: correctness and reliability dominate.
- Twitter/X timeline: fanout and read latency dominate.
- YouTube playback: CDN bandwidth and startup latency dominate.
- WhatsApp messaging: delivery semantics and connection scale dominate.

### Design exercise
Design a food delivery order flow from restaurant selection to payment confirmation. Include:
- Required APIs.
- Data model.
- Failure modes.
- Idempotency keys.
- Metrics dashboard.

## Rigorous Design Document Template

Use this template for every serious design.

### 1. Scope
```text
In scope:
- ...

Out of scope:
- ...
```

### 2. Requirements
Functional:
- User actions.
- Admin actions.
- Background workflows.

Non-functional:
- Latency target.
- Availability target.
- Durability requirement.
- Consistency contract.
- Compliance/security constraints.

### 3. Architecture
```text
Client -> Edge -> API Gateway -> Service Layer
                                  -> Cache
                                  -> DB
                                  -> Queue/Event Bus
                                  -> Workers
                                  -> Observability
```

### 4. Correctness checklist
- What is acknowledged to the user?
- What is durably written before acknowledgment?
- What can be retried?
- What is idempotent?
- What can be duplicated?
- What can be stale?

### 5. Failure table
```text
Failure                  User impact             Mitigation
Cache unavailable        Higher DB load           Bypass cache, rate-limit misses
DB primary slow          Write latency/error      Circuit breaker, failover, degrade writes
Queue backlog            Delayed async work       Backpressure, autoscale, DLQ
Third-party timeout      Partial workflow fail    Timeout, retry, compensation
Bad deploy               Error spike              Canary, rollback
```

### 10. Interview perspective
A strong answer starts with requirements, then scale, then architecture, then tradeoffs and failures.

**Self-check**
1. Why is "works on my machine" irrelevant for system design?
2. Why is operability a design concern, not an ops concern?

**Exercise**
Design a notes app for:
1. 100 users
2. 10 million users  
Compare architecture delta and justify each new component.

---

## 2) Horizontal vs Vertical Scaling

### Intuition
Scaling means increasing capacity. You can buy a bigger box (vertical) or more boxes (horizontal).

### Problem
Traffic, data, and concurrency grow over time.

### Naive
Keep upgrading machine size forever.

### Evolution
1. Vertical first (fastest operationally).
2. Make services stateless.
3. Add load balancer + multiple app instances.
4. Partition data layer.

### Internals
- Horizontal scaling requires externalized state (DB, cache, object store).
- Session affinity can help short-term but reduces flexibility.

### Tradeoffs
- Vertical: simpler, but hardware limits + larger failure blast radius.
- Horizontal: resilient and elastic, but harder distributed complexity.

### Real-world
Most mature systems use hybrid: moderate vertical + broad horizontal.

### Pseudo-code (autoscaling idea)
```text
if cpu > 70% for 5m or p95_latency > slo:
  scale_out()
if cpu < 30% for 30m:
  scale_in()
```

### Diagram
```text
Vertical: [App on 1 huge node]
Horizontal: LB -> [App1, App2, App3, ...]
```

### Interview
Say: "Scale-up buys time; scale-out buys long-term resiliency."

**Exercise:** Migrate sticky-session architecture to stateless JWT + shared data store.

---

## 3) Latency vs Throughput

### Intuition
- Latency: time for one request.
- Throughput: number of requests completed per unit time.

### Problem
Users feel latency; business needs throughput.

### Naive
Optimize only average latency; ignore queue buildup and tail latencies.

### Evolution
1. Budget latency per hop.
2. Reduce network round trips.
3. Use caching and batching strategically.
4. Manage queue depth and concurrency.

### Internals
Queueing theory: as utilization approaches 100%, wait time grows non-linearly.

### Tradeoffs
- Batching improves throughput, can hurt per-request latency.
- Strong consistency may increase latency.

### Real-world
P99 often drives user complaints and error budgets.

### Pseudo-code
```text
total_latency = dns + tcp + tls + app + db + downstream + serialization
```

### Diagram
```text
Request -> queue(wait) -> service(cpu/io) -> response
```

### Interview
Mention P50/P95/P99 and latency budget per dependency.

**Exercise:** Create a latency budget for login API with P95 target 300ms.

---

## 4) CAP Theorem (Deep Intuition)

### Intuition
In a distributed system, network partitions are inevitable.

### Problem
When partition happens, you cannot guarantee both immediate consistency and full availability for all operations.

### Naive
"We will have strong consistency and 100% availability always."

### Evolution
Define behavior under partition:
- Prefer consistency (reject/timeout some requests), or
- Prefer availability (serve possibly stale data).

### Internals
CAP applies **during partition**. Outside partitions, many systems can deliver both high consistency and high availability.

### Tradeoffs
- CP: safer correctness, potential request failure.
- AP: better uptime, temporary stale/conflicting views.

### Real-world
- Banking ledgers often choose CP semantics for writes.
- Social feeds often choose AP-friendly behavior for reads.

### Interview
Say explicitly: "CAP is partition-time behavior, not an always-on label."

**Exercise:** Decide partition behavior for inventory reservation service.

---

## 5) PACELC

### Intuition
Even without partition, systems trade latency and consistency.

### Rule
If **P**artition: choose **A**vailability or **C**onsistency.  
**EL**se: choose **L**atency or **C**onsistency.

### Example
Global multi-region writes:
- Strong sync replication => higher latency, stronger consistency.
- Async replication => lower latency, possible stale reads.

### Interview
Use PACELC to explain normal-state behavior, not only failure-state behavior.

**Exercise:** Classify three systems with PACELC assumptions and explain.

---

## 6) Availability, Reliability, Durability

### Definitions
- Availability: system responds to requests.
- Reliability: system behaves correctly over time.
- Durability: acknowledged data survives failures.

### Subtle point
A system can be highly available but unreliable (responds quickly with wrong data).

### Internals
- Availability from redundancy, failover, timeout discipline.
- Reliability from correctness, testing, observability, controlled changes.
- Durability from WAL, replication, backups, recovery drills.

### Exercise
For payments service, define objective metrics for each:
1. Availability target
2. Reliability target
3. Durability guarantee

---

## 7) Load vs Stress vs Performance Testing

### Intuition
Different tests answer different risk questions.

### Types
- **Load testing:** expected traffic.
- **Stress testing:** beyond expected until break.
- **Performance profiling:** where time/resources are spent.

### Internals
Track:
- CPU saturation
- Memory leaks / GC pauses
- Disk IOPS and latency
- Network RTT and retransmits
- Queue depth and thread pool starvation

### Interview
Explain what fails first and what protection exists (shed load, degrade gracefully, autoscale).

**Exercise**
Create a test matrix for 1x/2x/5x/10x load and define pass/fail criteria.

---

## Foundation Mastery Questions
1. Why is idempotency a design primitive?
2. Why is "no single point of failure" still insufficient?
3. What is the difference between graceful degradation and hidden failure?
4. Why should every design include rollback strategy?

---

## Advanced Foundation Layer: SLOs, Error Budgets, and Operational Semantics

### SLO Basics
- **SLI**: measured signal (e.g., successful request ratio).
- **SLO**: target level (e.g., 99.9% success over 30 days).
- **SLA**: external contract with penalties.

### Why this matters for design
SLOs convert architecture decisions into measurable objectives.  
Example: choosing synchronous cross-region writes may improve consistency but may violate latency SLO.

### Error Budget thinking
If reliability target is 99.9%, downtime budget is ~43.2 minutes/month.  
Use budget intentionally for safe velocity (deployments, experiments) and stop risky changes if budget burns too fast.

### Operational Semantics Checklist
For each endpoint/workflow, define:
1. Timeout and deadline
2. Retry policy
3. Idempotency key scope
4. Partial failure behavior
5. Degradation mode
6. Audit logging obligations

### Decision log template
```text
Decision:
Context:
Options considered:
Chosen option:
Tradeoffs accepted:
Rollback trigger:
```

### Foundation exercise (production realism)
Design a "place order" workflow and define:
- consistency guarantees,
- timeout/retry policy,
- what user sees during downstream payment outage,
- what support team sees in logs/metrics.
