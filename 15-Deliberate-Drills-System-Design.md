# Deliberate Drills: Requirements, Estimation, Tradeoffs, Failure Handling

## Goal
Build precision in the 4 skills interviewers and senior engineers value most.

---

## Drill 1: Requirements Clarification

## Why
Bad requirements produce perfect solutions to the wrong problem.

## 10-question requirement checklist
1. Who are users?
2. Core functional features?
3. Non-functional priorities (latency, availability, consistency)?
4. Read/write ratio?
5. Peak traffic pattern?
6. Data retention/compliance needs?
7. Multi-region requirement?
8. Failure tolerance level?
9. Cost sensitivity?
10. Scope exclusions?

## Exercise format
- Take one system prompt.
- Spend 7 minutes writing only requirements.
- No architecture until this is complete.

---

## Drill 2: Estimation

## Why
Scale determines architecture choices.

## Estimation template
1. DAU/MAU assumption
2. Requests per user per day
3. Peak factor
4. Peak QPS
5. Average payload size
6. Daily storage growth
7. Yearly storage growth
8. Network bandwidth approximation

## Quick formulas
```text
peak_qps = (daily_requests * peak_factor) / 86400
daily_storage = writes_per_day * avg_record_size
```

## Exercise
Estimate for:
1. URL shortener
2. Chat service
3. Video platform metadata service

## Sophisticated Drill System

### Drill: architecture from bottleneck
Pick one bottleneck and design backward:
- Hot key.
- Slow database.
- Queue lag.
- Regional outage.
- Celebrity fanout.
- CDN miss storm.

Output:
- Root cause.
- Immediate mitigation.
- Long-term architecture change.
- Metrics proving recovery.

### Drill: consistency decision
For each feature, label consistency:
- Strong.
- Read-your-writes.
- Eventual.
- Best-effort.

Examples:
- Payment ledger: strong.
- Like counter: eventual.
- Message send ack: durable before ack.
- Presence: best-effort.

### Drill: real-world comparison
Compare your design to a known system:
- What is similar?
- What is simplified?
- What would only appear at massive scale?
- What is intentionally excluded?

## Rigorous Drill Bank

### Drill: one component, five failures
Pick cache, queue, database, search, or payment provider.
Write five failures and mitigations.

### Drill: scale trigger
For one system, define the exact metric that triggers:
- Add cache.
- Add queue.
- Add read replica.
- Shard database.
- Add regional deployment.

### Drill: remove a component
Take a design and remove one component. Explain:
- What breaks?
- What gets simpler?
- What new limit appears?
- When would removal be correct?

---

## Drill 3: Tradeoff Reasoning

## Why
Senior design quality = clear, explicit tradeoffs.

## Tradeoff matrix template
| Option | Latency | Throughput | Consistency | Cost | Complexity | Decision |
|---|---|---|---|---|---|---|
| A |  |  |  |  |  |  |
| B |  |  |  |  |  |  |

## Must-practice tradeoff topics
1. SQL vs NoSQL
2. Sync vs async replication
3. Fanout-on-write vs fanout-on-read
4. REST vs gRPC
5. Monolith vs microservices

## Exercise
For each topic, defend both sides in 2 minutes each, then choose one.

---

## Drill 4: Failure Handling

## Why
Production success depends on behavior under failure, not happy path.

## Failure checklist per dependency
1. Timeout configured?
2. Retry policy defined?
3. Idempotency guaranteed?
4. Circuit breaker/bulkhead applied?
5. Degradation behavior defined?
6. Alerting metric in place?

## Failure scenarios to drill
1. DB primary down
2. Cache cluster unavailable
3. Queue lag spikes
4. Regional outage
5. Third-party payment timeout

---

## Daily 30-minute Drill Routine
1. 8 min requirements
2. 8 min estimation
3. 8 min tradeoff defense
4. 6 min failure strategy

---

## Weekly Evaluation
Score 1–5:
1. Requirement quality
2. Estimation speed/accuracy
3. Tradeoff clarity
4. Failure-depth realism

If any score < 4, repeat same drill category next week.
