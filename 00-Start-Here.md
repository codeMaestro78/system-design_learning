# Start Here: Step-by-Step Learning Flow

## Session Flow (Use daily)
1. Pick one topic section from current phase.
2. Explain it in your own words using 10-step method.
3. Solve the exercise.
4. Review one real-world failure scenario.
5. Write one interview-style answer (5 minutes).

## Beginner Sequence (Do not skip)
1. `01-Foundations.md`  
2. `02-Networking-Basics.md`  
3. `03-Data-and-Storage.md`

## Intermediate Sequence
4. `04-Core-Components.md`  
5. `05-Architecture-Patterns.md`  
6. `06-Scaling-Systems.md`

## Advanced Sequence
7. `07*` system design files  
8. `08*` hands-on project files  
9. `09` to `12` advanced + production + interview files

## Weekly Checkpoint Questions
1. Can I estimate scale before drawing architecture?
2. Can I justify consistency model with business impact?
3. Can I describe failure handling, retries, and idempotency?
4. Can I explain P99 bottlenecks and mitigation?
5. Can I communicate tradeoffs clearly?

## Minimum Mastery Criteria
- You can design at least 3 large systems end-to-end.
- You can build and test all 7 projects.
- You can run a 45-minute system design interview confidently.

## Daily Active Recall Template (Append to your notes)
Use this exact template after every study session:
1. **Core idea in one sentence**
2. **Failure mode if ignored**
3. **Two tradeoffs I can articulate**
4. **One production metric to monitor**
5. **One interview-quality explanation (90 seconds)**

## Progress Scorecard (self-evaluation)
Rate 1-5 every week:
- Requirement clarification quality
- Estimation accuracy
- Data-model quality
- Failure-handling depth
- Tradeoff communication clarity

If any area is `<=2`, revisit corresponding part before moving ahead.

## Drill Mode (High-intensity practice)
1. Pick one random system (e.g., URL shortener).
2. Spend 10 min on scope + scale.
3. Spend 15 min on architecture.
4. Spend 10 min on bottlenecks/failures.
5. Spend 10 min on tradeoff defense.
6. Spend 5 min retrospective: what was vague?

## Sophisticated Elite Roadmap Structure

Use the curriculum in four passes.

### Pass 1: Conceptual Understanding
- Goal: understand vocabulary and why each component exists.
- Output: one-page summary per file.
- Success signal: you can explain the topic without drawing a memorized diagram.

### Pass 2: Architecture Construction
- Goal: design systems from requirements and constraints.
- Output: one design doc per `07*` file.
- Success signal: every component in your diagram has a reason to exist.

### Pass 3: Implementation and Failure
- Goal: build small working versions and break them.
- Output: tests, load runs, failure notes, and fixes in `nodejs-system-design-lab/`.
- Success signal: you can explain how the code maps to the architecture.

### Pass 4: Senior Communication
- Goal: communicate tradeoffs under time pressure.
- Output: recorded 45-minute mock interviews and written retrospectives.
- Success signal: you quantify scale, name failure modes, and defend choices.

## Master Topic Map

### Foundations
- Client/server model
- Latency, throughput, availability, durability
- CAP, PACELC, consistency models
- Back-of-the-envelope estimation

### Networking
- DNS, TCP, UDP, TLS
- HTTP/1.1, HTTP/2, HTTP/3
- WebSockets and long polling
- Load balancing and CDN routing

### Storage
- Relational modeling
- Document and key-value stores
- Indexes, transactions, locks
- Replication, partitioning, sharding

### Distributed Systems
- Consensus, leader election, leases
- Idempotency, retries, timeouts
- Eventual consistency, sagas, outbox
- Stream processing and replay

### Production
- Metrics, logs, traces
- SLOs and error budgets
- Deployment strategies
- Security and compliance

## Real System Study Method

For every real company example, write:

1. Product promise.
2. Core entities.
3. Read/write ratio.
4. Hottest path.
5. Most dangerous failure.
6. Scaling strategy.
7. Operational metrics.
8. Evolution from simple version to global version.

## Rigorous Study Gates

Do not mark a topic complete until you can answer all of these without looking at notes.

### Gate A: first principles
- What problem does this component solve?
- What happens if we remove it?
- What simpler alternative exists?
- What hidden complexity does it introduce?

### Gate B: architecture
For each system, draw:

```text
Client -> Edge -> API -> Service -> Storage
                         -> Async Pipeline
                         -> Observability
```

Then annotate:
- Synchronous path.
- Async path.
- Durable write boundary.
- Cache boundary.
- Failure boundary.
- Security boundary.

### Gate C: production reasoning
- Define p95/p99 targets.
- Define RPO/RTO where relevant.
- Define retry policy and timeout budget.
- Define rollback and migration path.
- Define the metrics that prove the design works.
