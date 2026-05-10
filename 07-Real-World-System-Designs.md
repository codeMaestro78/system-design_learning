# Part 5: Real-World System Design (Comprehensive Framework)

For each system file (`07a` to `07i`), follow this **exact sequence**:

1. **Intuition**  
2. **Functional requirements**  
3. **Non-functional requirements** (latency, availability, durability, consistency)  
4. **Capacity estimation**  
5. **API design**  
6. **Data model/schema**  
7. **High-level design (HLD)**  
8. **Low-level design (LLD)**  
9. **Critical flows** (write/read/update/delete where relevant)  
10. **Bottlenecks and scaling strategy**  
11. **Failure handling and recovery**  
12. **Security, abuse, and compliance considerations**  
13. **Interview explanation strategy**  

## Capacity Estimation Checklist
- Users (DAU/MAU)
- Peak QPS and peak concurrency
- Read/write ratio
- Storage growth per day
- Network bandwidth
- Cache hit ratio target

## Reliability Checklist
- Timeout and retry policy
- Idempotency for writes
- DLQ/retry strategy for async work
- Degradation mode during dependency outages
- Backup and restore plan

## Interview Checklist
1. Clarify scope and assumptions.
2. State scale.
3. Present HLD first.
4. Deep dive one critical path.
5. Discuss tradeoffs and failure strategy.

---

## Reusable Design Review Rubric

Score each section from 1 (weak) to 5 (strong):
1. Requirements completeness
2. Scale realism
3. Data model correctness
4. Consistency and failure semantics
5. Operational observability
6. Cost-awareness
7. Security/compliance depth

### Mandatory "what breaks first?" section
For every system answer:
- First expected bottleneck
- First likely outage mode
- Fastest mitigation path
- Long-term fix

### Quality bar for production-grade answer
An answer is not production-grade unless it includes:
- SLO targets
- retry/idempotency policy
- deployment/rollback strategy
- abuse/security controls

## Sophisticated Case Study Template

Use this expanded template for every real-world design.

### Product promise
State the user-facing guarantee in one sentence.

Examples:
- Twitter/X: show a fresh personalized timeline quickly despite celebrity fanout.
- WhatsApp: deliver messages reliably across online and offline devices.
- YouTube: start playback quickly and keep it smooth globally.

### Domain model
List core entities and ownership:
- Users/accounts.
- Content, messages, orders, trips, videos, or links.
- Relationship graph.
- Events and analytics.
- Moderation, audit, and policy objects.

### Read/write shape
Quantify:
- Reads per write.
- Fanout multiplier.
- Payload size.
- Hot key risk.
- Data retention.

### Architecture evolution
```text
MVP -> Regional scale -> Global scale -> Mature platform
```

For each phase, write what changes and what does not.

### Production design review
Include:
- SLOs.
- Dependency map.
- Failure modes.
- Backpressure strategy.
- Security and abuse controls.
- Cost drivers.
- Migration plan.

### Real-world comparison
Use known systems as reasoning anchors:
- Social feeds use hybrid fanout.
- Video platforms use object storage, transcoding, and CDN.
- Messaging systems use persistent connections, sequence numbers, and offline replay.
- Search systems split indexing and serving.

## Rigorous Architecture Review Template

Use this table in every `07*` system file.

```text
Layer                 Decision                         Why
Edge                  CDN/WAF/LB                       latency, TLS, attack filtering
API                   gateway/service boundary          auth, routing, validation
Write store           source of truth                   durability and consistency
Read store/cache      optimized serving path            low latency and scale
Async pipeline        queue/stream/workers              fanout, analytics, slow work
Search/index          projection if needed              query and ranking performance
Observability         logs/metrics/traces               operations and debugging
Security              auth, abuse, privacy              trust and compliance
```

### Required consistency matrix
```text
Feature               Consistency requirement           Reason
Primary write         strong/read-after-write           user expects durable result
Counters              eventual                          low correctness risk
Search/feed           eventual                          async projection acceptable
Payments/safety       strong/auditable                  money or safety risk
Presence/typing       best-effort                       ephemeral signal
```
