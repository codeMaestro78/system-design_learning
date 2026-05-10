# Project 3: Rate Limiter (Multiple Strategies)

## Architecture
```text
Client -> API Gateway/Middleware -> Limiter Engine -> Redis/Local State
```

## Strategies to implement
1. Fixed Window
2. Sliding Window Counter
3. Sliding Log
4. Token Bucket
5. Leaky Bucket

## Step-by-step plan
1. Build interface `allow(key, now) -> bool`.
2. Implement fixed window local memory version.
3. Add Redis-backed distributed version.
4. Add token bucket with burst control.
5. Add per-route/per-user/per-IP policy layers.
6. Add shadow mode for safe rollout.

## Scaling improvements
- Hierarchical limiting (edge + service).
- Local fast-path with periodic sync.
- Adaptive dynamic limit under incident mode.

## Production concerns
- Clock skew handling
- Key cardinality explosion
- Fairness vs strictness
- Observability (reject rate, near-limit rate)

## Exercises
1. Compare false positives/negatives across algorithms.
2. Simulate regional outage and ensure global limit behavior remains sane.

## Extended Build Tasks

### Policy language
Support rules like:
`user:100/min`, `ip:20/min`, `route:/login:10/min`

### Distributed correctness
- Lua/transactional updates for atomic counters.
- Deterministic key hashing across nodes.

### Observability
- Near-limit warnings
- Rejection reason labels
- Per-policy hit/reject dashboard

## Sophisticated Build Expansion

### Real-world equivalent
Public API platforms, login systems, payment APIs, and messaging systems use rate limits for fairness, overload protection, and abuse control.

### Architecture
```text
Request -> Policy Resolver -> Limiter Engine -> Decision
                         -> Counter Store
                         -> Metrics/Alerts
                         -> Admin Override
```

### Advanced topics
- Distributed token bucket using Redis/Lua.
- Sliding window logs versus counters.
- Hierarchical limits: IP, user, tenant, route.
- Shadow mode policy testing.
- Quota reset and billing integration.

### Production questions
- Is the limiter fail-open or fail-closed?
- How are counters replicated?
- How do you avoid blocking legitimate bursty users?
- How are limits communicated to clients?

## Rigorous Acceptance Criteria

### Minimum architecture
```text
Request -> Identity Extractor -> Policy Resolver -> Limiter Algorithm
                                      -> Counter Store
                                      -> Decision + Headers
                                      -> Metrics
```

### Required behaviors
- Returns remaining quota.
- Returns retry-after for rejected requests.
- Supports per-route policy.
- Supports burst capacity.
- Handles invalid identity consistently.
- Exposes reject counters by policy.

### Failure tests
- Counter store timeout.
- High-cardinality identities.
- Clock skew between nodes.
- Burst at window boundary.
