# Project 5: Log Aggregation System

## Architecture
```text
Agents -> Ingestion Gateway -> Message Stream -> Indexer -> Storage
                                                   -> Query API/UI
```

## Tech choices
- Agent: Fluent Bit/Vector-style custom shipper
- Stream: Kafka
- Storage: object store + search index (OpenSearch/ClickHouse)

## Step-by-step plan
1. Agent tailing local logs.
2. Structured log schema (JSON fields).
3. Ingestion service with backpressure.
4. Partitioned stream by tenant/service/date.
5. Indexer for searchable fields.
6. Query API with time-range filters.

## Scaling improvements
- Hot/warm/cold storage tiers.
- Compression and retention policy.
- Query federation across partitions.

## Production concerns
- PII redaction
- Multi-tenant isolation
- Burst handling during incidents

## Exercises
1. Add alerting on error-rate patterns.
2. Add trace correlation via request_id.

## Extended Build Tasks

### Parsing and indexing
- Dynamic field extraction pipeline
- Schema evolution handling for new log fields
- Cardinality guardrails

### Query system
- Time-range pruning
- Full-text plus structured filters
- Saved query support

### Security/compliance
- Redaction processors
- Tenant-scoped query authorization
- Retention/legal hold policy switches

## Sophisticated Build Expansion

### Real-world equivalent
Datadog, Splunk, Elastic, Loki, and cloud logging platforms ingest high-volume logs and provide search, alerting, and retention controls.

### Architecture
```text
Agent -> Ingestion Gateway -> Stream -> Parser/Redactor
                                 -> Hot Search Index
                                 -> Object Storage Archive
                                 -> Query API
                                 -> Alert Engine
```

### Advanced topics
- Backpressure from ingestion to agents.
- Multi-tenant isolation.
- High-cardinality field controls.
- Time partitioning.
- Compression and retention tiers.
- PII redaction and legal hold.

### Production questions
- What happens during incident log bursts?
- How are noisy tenants isolated?
- Which fields are indexed?
- How are logs deleted for compliance?

## Rigorous Acceptance Criteria

### Minimum architecture
```text
Agent -> Ingestion API -> Stream Buffer -> Parser/Redactor
                                  -> Index Writer
                                  -> Archive Writer
                                  -> Query API
```

### Required behaviors
- Rejects oversized log events.
- Redacts configured sensitive fields.
- Preserves tenant isolation.
- Indexes timestamp, service, level, trace ID.
- Supports retention deletion.
- Applies backpressure during bursts.

### Failure tests
- Stream unavailable.
- Index writer slow.
- Tenant sends high-cardinality fields.
- PII appears in payload.
