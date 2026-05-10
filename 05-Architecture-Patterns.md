# Part 3: Architecture Patterns (Deep)

## 1) Monolith vs Microservices

### Monolith
- Single deployable unit.
- Strong transactional consistency within one DB boundary.
- Fast early-stage development.

### Microservices
- Independent deployability and scaling.
- Team autonomy and bounded contexts.
- Distributed complexity: network failures, data consistency, observability.

### When to choose
- Early product/small team: modular monolith.
- Mature org/complex domains: evolve to service boundaries.

---

## 2) Event-Driven Architecture

### Intuition
Services communicate by publishing facts (events), not blocking direct calls.

### Benefits
- Loose coupling
- Async scaling
- Replay and auditability

### Costs
- Event schema evolution challenges
- Debugging async flows
- Eventual consistency handling

### Design guidance
- Use schema registry/versioning.
- Make consumers idempotent.
- Track event lineage and correlation IDs.

---

## 3) CQRS

### Intuition
Read and write workloads have different optimal models.

### Pattern
- Command model for writes/validation.
- Query model for read optimization.

### Tradeoffs
- Better read scalability and UX.
- More infrastructure and consistency-lag complexity.

## Advanced Roadmap: Architecture Patterns

### Topics and subtopics
- Modular monolith: internal module boundaries, shared DB, deployment simplicity.
- Microservices: service ownership, API contracts, data ownership, observability.
- Event-driven systems: events as facts, schema evolution, replay, idempotency.
- CQRS: separate write model and read model.
- Saga: orchestration, choreography, compensation.
- Transactional outbox: reliable event publication after local DB commits.
- CDC: database changes as stream inputs.
- Multi-region patterns: active-passive, active-active, regional isolation.

### Pattern selection guide
```text
Small team, early product       -> Modular monolith
Clear domain boundaries         -> Services
Heavy async side effects        -> Event-driven architecture
Complex read views              -> CQRS/materialized views
Multi-step business transaction -> Saga + outbox
Global low-latency reads        -> Regional replicas + CDN/cache
```

### Example: order platform
```text
Order Service
  -> Local Order DB
  -> Transactional Outbox
  -> Event Bus
    -> Inventory Projection
    -> Email Service
    -> Analytics Pipeline
```

Why this works:
- Order write and event record commit together.
- Event publication is retryable.
- Consumers are independently scalable.
- Duplicate events are handled by idempotent consumers.

### Real systems to study
- Shopify-style modular commerce platform evolution.
- Uber-style domain services around trips, matching, payments, and maps.
- Netflix-style microservices with strong observability and fallback patterns.

### Design exercise
Take a monolithic e-commerce app and propose a staged migration:
- Which module splits first?
- What data ownership changes?
- What APIs are introduced?
- What failure modes get worse?

## Rigorous Pattern Selection

### Pattern comparison
```text
Pattern                 Use when                         Avoid when
Modular monolith        early product, small team         independent scaling is mandatory
Microservices           clear domains, many teams         boundaries are unclear
Event-driven            async fanout, loose coupling      immediate consistency is required
CQRS                    read/write models differ          consistency lag is unacceptable
Saga                    multi-step business workflow      single DB transaction is enough
Outbox                  reliable event publication        event loss is acceptable
CDC                     projections/search/analytics      schema churn is unmanaged
```

### Rigorous architecture evolution
```text
Phase 1: Modular Monolith + DB
Phase 2: Add queue for slow side effects
Phase 3: Add outbox for reliable events
Phase 4: Split service where ownership/scale requires
Phase 5: Add projections and regional replicas
```

### Review questions
- What transaction boundary exists today?
- Which data belongs to which service?
- What happens if the event bus is unavailable?
- How are duplicate events handled?
- How are contracts versioned?
- How do you migrate without downtime?

---

## 4) Saga Pattern

### Problem
Distributed transaction across services without 2PC.

### Approach
Sequence of local transactions + compensating actions on failure.

### Styles
- Choreography: events drive next steps.
- Orchestration: central coordinator controls flow.

### Risk
Compensation may not perfectly "undo" side effects; domain design matters.

---

## 5) API Gateway

### Responsibilities
- AuthN/AuthZ at edge
- Routing and protocol translation
- Rate limiting and quotas
- Request/response transformation

### Anti-pattern
Putting business logic in gateway.

---

## 6) Service Mesh

### Intuition
Move cross-cutting networking concerns out of app code.

### Features
- mTLS
- Retry/timeout policies
- Traffic shaping
- Distributed tracing hooks

### Tradeoff
Strong control and security vs operational complexity and overhead.

---

## 7) Backpressure Handling

### Why
Without backpressure, overload cascades into full outages.

### Techniques
- Bounded queues
- Concurrency limits
- Circuit breakers
- Load shedding
- Degraded mode

---

## 8) Rate Limiting

### Algorithms
- Fixed window
- Sliding window log/counter
- Token bucket
- Leaky bucket

### Dimensions
- Per API key
- Per user
- Per IP
- Per route
- Global

### Interview
Explain correctness under distributed deployment and clock skew.

---

## Exercises
1. Convert checkout monolith to modular architecture with Saga.
2. Add backpressure and circuit breakers to async worker pipeline.
3. Design gateway + mesh policy for zero-trust internal traffic.

---

## Boundary Design and Team Topology Addendum

### Service boundary rules
- Align boundaries with business capability, not technical layers.
- One service should own one authoritative data model for its domain.
- Cross-service writes require explicit workflow orchestration.

### Contract discipline
- API schema versioning strategy
- Backward compatibility window
- Deprecation process with telemetry

### Operational ownership model
Each service should have:
1. SLOs
2. Alert runbook
3. On-call ownership
4. Capacity plan

### When not to use microservices
- Team too small to absorb operational overhead
- Domain boundaries still unclear
- No mature observability/deployment platform

### Interview scenario prompt
You have a modular monolith with growth pain.  
Explain staged extraction plan for one domain (e.g., payments) without big-bang rewrite.
