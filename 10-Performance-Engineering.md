# Part 8: Performance Engineering (Deep)

## 1) Profiling Systems

### Goal
Replace guesswork with measurement.

### What to profile
- CPU hotspots
- Memory pressure and GC
- I/O wait
- Lock contention
- Network wait/retransmissions

### Rule
Never optimize before baseline profiling.

---

## 2) Bottleneck Identification

### Method
1. Define SLO and load profile.
2. Measure end-to-end latency breakdown.
3. Find saturated resource.
4. Improve narrowest stage.

### Queueing insight
High utilization drives nonlinear latency growth.

---

## 3) Latency Breakdown

Typical web call:
```text
DNS + TCP + TLS + LB + App + Cache/DB + Downstream + Serialization
```

Maintain per-hop budgets and track budget regressions.

---

## 4) Tail Latency (P99 Problem)

### Why it matters
Users experience tails, not averages.

### Causes
- GC pauses
- Noisy neighbors
- Retries and queue buildup
- Cross-region calls

### Mitigations
- Bounded queues
- Hedged requests (careful)
- Deadline propagation
- Workload isolation

## Sophisticated Performance Roadmap

### Topics and subtopics
- Latency budgets: client, network, edge, service, cache, DB, downstream.
- Throughput: CPU, memory, I/O, connection pools, event loop saturation.
- Tail latency: p95, p99, p999, coordinated omission.
- Queueing theory: utilization, waiting time, backpressure.
- Profiling: CPU flamegraphs, heap snapshots, lock contention, syscall latency.
- Load testing: baseline, stress, soak, spike, failure-injection tests.
- Optimization: caching, batching, async work, indexes, data locality.

### Example latency budget
```text
Total p95 target: 200 ms
Edge + network: 40 ms
API gateway: 10 ms
Service logic: 30 ms
Cache/DB: 70 ms
Downstream calls: 30 ms
Serialization/logging buffer: 20 ms
```

### Architecture for performance testing
```text
Load Generator -> API -> Service -> Cache/DB/Queue
                         -> Metrics
                         -> Traces
                         -> Profiling Output
```

### Real systems to study
- Google search latency culture: every millisecond affects UX.
- Netflix playback startup optimization.
- Trading systems where tail latency directly impacts money.
- E-commerce checkout where slow payment dependencies reduce conversion.

### Design exercise
Given an endpoint with p99 = 2 seconds:
- Break down latency by dependency.
- Identify saturation.
- Add a timeout and fallback.
- Reduce synchronous work.
- Prove improvement with before/after metrics.

## Rigorous Performance Review

### Latency budget template
```text
Endpoint: ...
SLO: p95 <= ... ms, p99 <= ... ms

Client/network: ...
Gateway: ...
Service CPU: ...
Cache: ...
Database: ...
Downstream: ...
Serialization/logging: ...
Safety margin: ...
```

### Load test types
- Smoke: low traffic, correctness.
- Baseline: expected traffic.
- Stress: find breaking point.
- Spike: sudden traffic burst.
- Soak: long-running stability.
- Failure injection: dependency timeouts and partial outages.

### Performance anti-patterns
- Measuring averages only.
- Running load tests without realistic data volume.
- Retrying requests after the caller deadline expired.
- Optimizing code before fixing slow queries.
- Ignoring queue age while request latency looks healthy.
- Adding cache without invalidation rules.

---

## 5) Caching at Scale

### Layers
- Browser/app cache
- CDN edge cache
- Service cache
- DB cache

### Anti-stampede
- Request coalescing
- Soft TTL + background refresh
- Jittered expiry

## Exercises
1. Create latency budget for feed API with P50/P95/P99 targets.
2. Identify top 3 tail-latency causes in chat delivery pipeline and mitigation.

---

## Performance Tuning Playbook

### Profiling loop
1. Baseline measurement
2. Isolate hotspot
3. Optimize one variable at a time
4. Re-measure and compare
5. Keep/rollback based on data

### Common high-impact wins
- Reduce network round trips
- Avoid N+1 DB query patterns
- Improve cache hit ratio
- Bound queue sizes
- Optimize serialization overhead

### Tail-latency controls
- End-to-end deadlines
- Retry budget limits
- Hedged requests only for idempotent reads
- Thread-pool isolation for critical endpoints

### Benchmark hygiene
- Warm-up period
- Representative payloads
- Stable environment
- Include error rates, not only latency
