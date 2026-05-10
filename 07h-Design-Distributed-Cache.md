# Design Distributed Cache (Redis-like, Comprehensive)

## Intuition
Distributed cache provides ultra-low-latency reads/writes for ephemeral or reconstructable data.

## Requirements
- GET/SET/DEL
- TTL expiration
- Replication/failover
- Optional persistence

## NFRs
- Sub-millisecond to low-millisecond latency
- High throughput
- Controlled consistency semantics

## HLD
```text
Client -> Router/Proxy -> Cache Shards (Primary + Replica)
                               |-> Persistence (AOF/Snapshot)
                               |-> Failover Coordinator
```

## LLD
- Consistent hashing with virtual nodes.
- Event loop + command parser.
- Expiration via lazy + active cycle.
- Eviction via policy (`allkeys-lru`, `volatile-lfu`, etc.).

## Data model
```text
key -> {value, type, ttl, version, size}
```

## APIs
- `SET k v EX ttl`
- `GET k`
- `DEL k`
- `MGET`

## Bottlenecks
- Hot keys
- Rehashing during node changes
- Replica lag for read replicas

## Scaling
- Hot-key replication or local cache near caller.
- Request coalescing for stampede protection.
- Background rebalancing with bounded migration rate.

## Failure handling
- Primary failover with fencing tokens.
- Write acknowledgments policy (single vs quorum ack).

## Security
- AuthN, ACLs, network segmentation, TLS for in-transit data.

## Interview framing
"Define cache consistency contract first, then discuss eviction, expiration, and failover behavior."

## Extended Deep Dive

### Replication semantics
- Async replica: lower write latency, possible stale reads.
- Semi-sync/quorum ack: stronger durability, higher latency.

### Memory management concerns
- Fragmentation impacts effective capacity.
- Large values can dominate eviction behavior.
- Serialization overhead can hurt CPU throughput.

### Operational controls
- Per-tenant quotas
- Hot key alerts
- Slow command logging

## Sophisticated Production Expansion

### Product promise
Provide low-latency key-value reads and writes with predictable behavior during node failures and cluster resizing.

### Mature architecture
```text
Client Library -> Hash Ring -> Cache Shards
                         -> Replica Shards
                         -> Cluster Metadata Store
                         -> Metrics/Hot Key Detector
```

### Real-life design choices
- Consistent hashing reduces key movement during scaling.
- Replicas protect against node loss.
- TTL and eviction policy must be explicit.
- Large values can destroy memory efficiency.

### What breaks first
- Hot keys.
- Memory fragmentation and eviction storms.
- Rebalancing load.
- Network saturation between replicas.

### Metrics
- Hit rate.
- p99 get/set latency.
- Evictions.
- Memory usage.
- Hot key distribution.

## Rigorous Architecture Addendum

### Scaled architecture
```text
Client Library -> Cluster Metadata Cache -> Consistent Hash Ring
                                      -> Primary Cache Node
                                      -> Replica Cache Nodes
                                      -> Gossip/Control Plane
                                      -> Metrics and Hot Key Detector
```

### Correctness boundaries
- Cache is not the source of truth unless explicitly configured as durable.
- TTL and eviction can remove data at any time.
- Replication mode determines stale-read risk.
- Rebalancing must not overload active nodes.
- Client routing must handle topology changes.

### Failure table
```text
Failure              Impact                         Mitigation
Node failure         key misses or stale reads       replicas and fast metadata update
Hot key              p99 spike                      local cache, replication, request coalescing
Memory pressure      eviction storm                 quotas and admission control
Rebalance            latency spike                  bounded migration rate
Split brain          inconsistent writes            fencing/control plane quorum
```
