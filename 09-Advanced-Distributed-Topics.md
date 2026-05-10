# Part 7: Advanced Distributed Systems Topics (Deep)

## 1) Distributed Consensus (Raft, Paxos)

### Why it exists
Need a safe way for multiple nodes to agree on ordered state transitions despite failures.

### Core concepts
- Single leader (in many practical protocols)
- Log replication
- Majority quorum commit
- Safety over availability under partition

### Practical understanding
Consensus is often used for metadata/config/control planes, not for every user-data operation.

---

## 2) Leader Election
- Ensures one active coordinator.
- Needs split-brain prevention.
- Requires leases/fencing and monotonic terms/epochs.

## 3) Gossip Protocols
- Probabilistic dissemination for membership and state.
- Scales well, converges eventually, not instantaneously.

## 4) CRDTs
- Data structures that merge deterministically without coordination.
- Useful for collaborative/offline edits.
- Tradeoff: semantics complexity and storage overhead in some designs.

## 5) Time Synchronization and Clock Problems
- Wall clocks drift.
- NTP adjustments can move time backward/forward.
- Use monotonic clock for durations/timeouts.
- Use logical timestamps for ordering when strict wall-clock order is unsafe.

## 6) Distributed Locking
- Lock with lease timeout.
- Use fencing token to avoid stale lock holder writes.
- Prefer idempotency/commutative updates when possible.

## 7) Idempotency
- Required in distributed retries.
- Same operation key should produce same effect.

### Pattern
```text
if key_seen: return stored_result
process_once()
store_result_for_key()
```

## Advanced Exercises
1. Design distributed cron scheduler with leader election.
2. Add fencing-token lock to prevent stale writer corruption.
3. Compare Raft-based config store vs DB table-based config storage.

## Sophisticated Distributed Systems Roadmap

### Topics and subtopics
- Consensus: Raft log replication, quorum, leader terms, commit index.
- Leader election: leases, fencing tokens, split-brain prevention.
- Replication: sync, async, quorum, multi-leader conflict resolution.
- Time: wall clock, monotonic clock, logical clock, vector clock.
- Coordination: locks, leases, barriers, service discovery.
- Consistency: linearizability, serializability, causal consistency, eventual consistency.
- Conflict-free data: CRDT counters, sets, registers, collaborative state.
- Multi-region: data residency, latency, failover, active-active writes.

### Example: distributed scheduler
```text
Scheduler Nodes
  -> Leader Election Store
  -> Job Metadata DB
  -> Lease Table
  -> Work Queue
  -> Worker Pool
```

Correctness requirements:
- Only one scheduler instance claims a job lease at a time.
- Workers use idempotency keys.
- Expired leases can be reclaimed.
- Fencing tokens prevent stale leaders from writing.

### Real systems to study
- ZooKeeper/etcd/Consul for coordination.
- Kafka partitions and consumer groups.
- Dynamo-style quorum systems.
- Google Spanner-style globally consistent transactions.

### Design exercise
Design a feature flag control plane:
- Strongly consistent writes.
- Low-latency reads.
- Multi-region replication.
- Emergency kill switch.
- Audit log and rollback.

## Rigorous Distributed Correctness

### Correctness vocabulary
```text
Linearizable      -> every read sees latest completed write
Serializable      -> transactions behave as some serial order
Causal            -> causally related events are observed in order
Eventual          -> replicas converge if writes stop
At-least-once     -> duplicates possible, loss unlikely
At-most-once      -> loss possible, duplicates avoided
Exactly-once      -> usually achieved as idempotent processing + transactions
```

### Distributed lock checklist
- Use leases with expiry.
- Use fencing tokens.
- Never trust wall-clock alone for correctness.
- Design for lock holder crash.
- Prefer idempotent operations over locks where possible.

### Multi-region architecture
```text
Users -> Global Traffic Manager
      -> Nearest Region
        -> Regional Services
        -> Regional Data Store
        -> Async Replication Stream
      -> Control Plane / Conflict Resolution
```

### Failure questions
- What happens during network partition?
- Which side accepts writes?
- How are conflicts resolved?
- What is the maximum data loss window?
- How is failback performed safely?

---

## Advanced Failure Semantics Addendum

### Exactly-once reality check
In distributed systems, "exactly once" is usually achieved by:
- at-least-once delivery
- idempotent processing
- dedupe keys and state

### Split-brain prevention checklist
- Majority quorum enforcement
- Epoch/term monotonicity
- Fencing tokens on side effects
- Fast fail-safe mode if quorum lost

### Logical clocks and causality
- Lamport clocks: order events, not true causality richness.
- Vector clocks: detect concurrent updates.

### Consensus operational concerns
- Snapshotting and log compaction
- Membership changes (joint consensus patterns)
- Slow follower impact

### Exercise
Design lock service API with:
`acquire(lock, ttl)`, `renew(token)`, `release(token)` and fencing guarantees.
