# Part 1: Data & Storage (Deep)

## 1) SQL vs NoSQL (When and Why)

### Intuition
Data model should follow access patterns and correctness requirements.

### Problem
One storage engine rarely optimizes all workloads (OLTP, analytics, search, graph).

### Naive
Choose DB by popularity.

### Evolution
1. List query patterns.
2. Define consistency and transaction needs.
3. Estimate scale.
4. Pick primary DB + supporting specialized stores when necessary.

### Deep internals
- SQL engines optimize relational joins and ACID transactions.
- NoSQL systems optimize scale dimensions (key-value, document, wide-column, graph).
- Polyglot persistence is common but adds complexity.

### Tradeoffs
- SQL: stronger relational semantics, potential sharding pain.
- NoSQL: easier horizontal scale, weaker ad-hoc relational querying.

### Interview
Answer with workload-driven criteria, not SQL-vs-NoSQL ideology.

---

## 2) Indexing (B-Tree vs LSM Tree)

## B-Tree
- Balanced tree index, logarithmic seek.
- Great read performance for point/range queries.

## LSM Tree
- Write to memtable + WAL, flush sorted SSTables to disk.
- Compaction merges files, removes obsolete versions/tombstones.

### Internals to know
- Write amplification
- Read amplification
- Space amplification
- Bloom filters for negative lookup acceleration

### Diagram
```text
Write -> WAL -> Memtable -> SSTable L0 -> Compaction -> L1/L2...
```

### Tradeoffs
- LSM: write-heavy wins, can suffer under read-heavy without tuning.
- B-Tree: balanced mixed workloads, random write cost higher in some cases.

## Advanced Roadmap: Data and Storage

### Topics and subtopics
- Data modeling: entities, relationships, access patterns, denormalization.
- Indexes: primary, secondary, composite, covering, inverted, geospatial.
- Transactions: ACID, isolation levels, locks, MVCC, deadlocks.
- Replication: leader-follower, multi-leader, quorum, lag.
- Partitioning: range, hash, tenant, time, composite keys.
- Storage engines: B-tree, LSM, columnar, object storage.
- Data lifecycle: retention, archival, deletion, legal hold, backup, restore.

### Storage selection matrix
```text
Payments ledger       -> Relational DB with transactions
Session store         -> Redis/key-value
Product search        -> Search index
Video files           -> Object storage + CDN
Clickstream analytics -> Kafka + ClickHouse/BigQuery-style OLAP
Chat messages         -> Wide-column or relational partitioned by conversation
```

### Example architecture: analytics pipeline
```text
Application Events
  -> Stream Broker
  -> Validation/Enrichment
  -> Hot Aggregates Store
  -> Data Lake/Object Storage
  -> OLAP Warehouse
  -> Dashboard/API
```

### Real systems to study
- Banking ledger: strong consistency and auditability.
- Instagram media metadata: relational/document metadata plus object storage.
- Search engines: inverted index optimized for query latency.
- Event analytics systems: append-only logs and batch/stream aggregation.

### Design exercise
Design storage for a messaging app:
- Message history by conversation.
- Search across messages.
- Media attachments.
- Read receipts.
- Retention and deletion.

## Rigorous Storage Architecture

### Storage decision workflow
```text
Access patterns -> Consistency needs -> Transaction needs -> Data volume
                -> Query flexibility -> Retention -> Operational maturity
                -> Storage choice
```

### Example: order storage
```text
Order API -> Order Service -> Postgres orders table
                          -> Outbox table
                          -> CDC/Event Publisher
                          -> Analytics/Search projections
```

### Schema review checklist
- Primary key is stable and non-guessable where needed.
- Indexes match real query patterns.
- High-cardinality fields are understood.
- Partition key avoids hot partitions.
- Retention/deletion is explicit.
- Migrations are backward compatible.
- Backups are tested with restore drills.

### Common flaws
- Choosing NoSQL to avoid modeling data.
- Adding indexes without understanding write amplification.
- Ignoring replica lag in read-after-write flows.
- Sharding before knowing access patterns.
- Storing large blobs in relational tables.
- Treating backup existence as restore readiness.

---

## 3) Query Optimization Basics

### Pipeline
SQL -> parse -> logical plan -> optimize -> physical plan -> execute.

### Internals
- Cardinality estimation drives plan quality.
- Join choices: nested loop, hash join, merge join.
- Index-only scans reduce table I/O.

### Naive pitfalls
- Missing composite indexes for frequent filter+sort queries.
- Unbounded scans due to non-sargable predicates.

### Interview
Explain expected index + query plan + why.

---

## 4) Transactions and ACID

### Atomicity
All or nothing.

### Consistency
State transitions respect invariants.

### Isolation
Concurrent transactions appear safe under chosen isolation model.

### Durability
Committed data survives crash.

### Internals
- WAL and checkpoints.
- Locking and/or MVCC.
- Commit protocol.

### Tradeoff
Higher isolation often reduces concurrency and throughput.

---

## 5) Isolation Levels

### Levels (common)
1. Read Uncommitted
2. Read Committed
3. Repeatable Read
4. Serializable

### Anomalies
- Dirty reads
- Non-repeatable reads
- Phantom reads
- Write skew (depends on engine behavior)

### Practical guidance
Use strongest level required by business correctness, not default everywhere.

---

## 6) Sharding & Partitioning

### Intuition
Split data to distribute load and storage.

### Shard key design
- High cardinality
- Uniform distribution
- Aligns with dominant query paths
- Supports future growth

### Pitfalls
- Hot partitions
- Cross-shard transactions
- Rebalancing complexity

### Mitigation
- Consistent hashing / virtual shards
- Dual-write migration with verification
- Query router aware of shard map

---

## 7) Replication Models

### Leader-Follower
- Writes to leader, reads optional from followers.
- Replication lag can return stale reads.

### Multi-Leader
- Lower regional write latency.
- Conflict detection and resolution required.

### Leaderless / Quorum (conceptual)
- Choose `N`, `R`, `W`.
- If `R + W > N`, read/write overlap for stronger consistency probability.

### Tradeoffs
- Sync replication: stronger consistency, higher latency, lower write availability.
- Async replication: better latency, possible data loss window on failover.

---

## Pseudo-code: Idempotent Write with Retries
```text
if idempotency_key exists:
  return stored_result
begin transaction
  insert business_row
  insert idempotency_record(result)
commit
return result
```

## Diagram: Typical Data Path
```text
API -> Write validation -> DB transaction -> WAL -> ACK
API -> Read -> Cache? -> DB/index -> response
```

## Mastery Exercises
1. Design schema + indexes for feed comments with pagination.
2. Choose consistency model for cart vs payment ledger.
3. Plan shard split migration with zero downtime.

---

## Data Modeling and Query Design Deep Dive

### Access-pattern-first modeling
Before schema creation, document:
1. Top 10 read queries by frequency
2. Top write paths by criticality
3. Required consistency guarantees per path

### Index design checklist
- Is predicate selective?
- Does index support filter + sort order?
- Do we need covering index?
- What is write overhead of this index?

### Migration safety patterns
- Expand-contract schema migration
- Backfill in small chunks
- Dual-read verification
- Cutover with rollback toggle

### Replication lag aware reads
Use read-after-write consistency tokens where necessary:
```text
write returns commit_lsn
subsequent read from replica only if replica_lsn >= commit_lsn
else read primary
```

### Data retention and compliance
- Define TTL and archival policy by table.
- Separate operational DB from analytical warehouse.
- Encrypt sensitive columns and audit access.

### Failure drill
Simulate:
1. primary DB crash
2. replica lag spike
3. accidental bad migration  
Then document recovery runbook.
