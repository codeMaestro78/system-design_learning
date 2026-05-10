# Project 1: Mini Redis (In-Memory KV Store)

## Architecture
```text
TCP Listener -> Command Parser -> In-Memory Store
                             -> TTL Manager
                             -> Persistence (AOF)
```

## Tech choices
- Language: Go or Rust
- Protocol: RESP-like text/binary
- Persistence: append-only file (AOF), optional snapshots

## Step-by-step implementation
1. **Core protocol**: `PING`, `SET`, `GET`, `DEL`.
2. **Concurrency model**: event loop or worker pool.
3. **TTL support**: store expiration metadata.
4. **Eviction policy**: LRU/LFU with max memory config.
5. **Persistence**: append command log + replay on startup.
6. **Replication**: primary-replica with offset-based sync.
7. **Observability**: qps, latency histogram, memory usage.

## Scaling improvements
- Sharding with consistent hashing.
- Read replicas for GET-heavy workloads.
- Hot-key detection and local near-cache.

## Production concerns
- AOF fsync policy tradeoff (latency vs durability).
- Snapshot pause impact.
- Failover split-brain protection.

## Milestone exercises
1. Add `MGET` and pipelining.
2. Add sorted set data type.
3. Implement benchmark and compare against Redis baseline behavior qualitatively.

## Extended Build Tasks

### Protocol rigor
- Add RESP error categories.
- Add command latency stats endpoint.

### Durability options
- AOF fsync modes: always/everysec/no.
- Snapshot cadence and restore-time benchmarking.

### Failure drills
- Crash during write burst
- Disk full during AOF append
- Replica disconnect and catch-up validation

## Sophisticated Build Expansion

### Real-world equivalent
Redis-like systems are used as caches, session stores, rate limiter backends, leaderboards, and lightweight queues.

### Architecture
```text
Client -> TCP/HTTP Protocol Layer -> Command Parser -> Data Structures
                                      -> Expiry Manager
                                      -> Eviction Manager
                                      -> Metrics
```

### Advanced topics
- TTL wheel or min-heap expiry.
- LRU/LFU eviction.
- Persistence via append-only log.
- Snapshotting.
- Replication.
- Cluster key routing.

### Production questions
- What happens when memory is full?
- Are writes durable?
- Can stale replicas serve reads?
- How are large values handled?
- How do clients reconnect after failover?

## Rigorous Acceptance Criteria

### Minimum architecture
```text
Client -> Protocol Parser -> Command Router -> Data Type Engine
                                      -> TTL Index
                                      -> Eviction Policy
                                      -> Persistence Log
                                      -> Metrics
```

### Required behaviors
- `GET` expired key returns missing and removes key.
- `SET` supports TTL.
- Eviction is deterministic under memory limit.
- Invalid commands return structured errors.
- Persistence replay restores expected state.

### Failure tests
- Crash after write before fsync.
- Expire many keys at once.
- Evict under mixed key sizes.
- Receive malformed command.
