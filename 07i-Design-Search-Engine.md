# Design Search Engine (Google-like, Comprehensive)

## Intuition
Search is a crawl-index-rank-serve pipeline where freshness, relevance, and latency are in constant tension.

## Requirements
- Crawl web pages
- Parse and index content
- Serve ranked results
- Support query operators/filters

## NFRs
- Very high query throughput
- Low search latency
- High index freshness

## HLD
```text
Crawlers -> URL Frontier -> Fetcher -> Parser -> Index Builder
                               |                     |
                               -> Link Graph --------|
Index Shards + Doc Store -> Query Processor -> Ranker -> Results API
```

## LLD
- URL frontier prioritizes recrawl based on change frequency.
- Parser extracts terms, anchors, metadata, language.
- Inverted index shards by term hash.
- Ranking combines BM25/text relevance + authority/personalization signals.

## Data model
```text
inverted_index(term -> postings[doc_id, tf, positions])
documents(doc_id, url, title, snippet, lang, quality_signals)
link_graph(src_doc, dst_doc)
```

## APIs
- `GET /search?q=...&page=...`
- `GET /autocomplete?q=...`

## Bottlenecks
- Query fanout to many shards
- Freshness lag from crawl to serving
- Ranking feature computation latency

## Scaling
- Tiered index (hot vs cold shards)
- Query caching and shard-local caching
- Incremental indexing pipeline

## Failure handling
- Partial shard timeout handling with degraded but usable results.
- Stale index fallback for high availability.

## Security/abuse
- Spam detection and ranking demotion.
- Safe search and policy filtering.

## Interview framing
"I split problem into ingest pipeline and serving path, then explain how to balance relevance quality with latency/freshness."

## Extended Deep Dive

### Index freshness pipeline
- Crawl scheduling by historical change rate
- Near-real-time incremental indexing for hot pages
- Batch compaction/merge for cost control

### Ranking quality controls
- Offline relevance evaluation datasets
- Online A/B metrics (CTR, dwell time, reformulation rate)
- Spam and low-quality content suppression

### Query serving optimizations
- Top-K early termination
- Result caching for frequent queries
- Shard timeout with partial result policy

## Sophisticated Production Expansion

### Product promise
Return relevant results quickly while continuously ingesting and indexing new or changed content.

### Mature architecture
```text
Crawler/Ingest -> Parser -> Document Store
                       -> Index Builder -> Inverted Index Shards
Query API -> Query Planner -> Shard Fanout -> Ranking -> Results
Signals Pipeline -> Ranking Features
```

### Real-life design choices
- Indexing path is separate from query serving path.
- Search shards are replicated for availability.
- Ranking is feature-heavy and latency constrained.
- Fresh index rollout should be atomic or versioned.

### What breaks first
- Query fanout p99.
- Index build lag.
- Hot queries.
- Ranking feature lookup latency.

### Metrics
- Query p95/p99.
- Index freshness lag.
- Empty result rate.
- Shard error rate.
- Click-through and relevance metrics.

## Rigorous Architecture Addendum

### Scaled architecture
```text
Crawler/Ingest -> Parser/Normalizer -> Document Store
                                -> Index Build Queue
                                -> Inverted Index Builder
                                -> Index Shards + Replicas

Query API -> Query Parser -> Query Planner -> Shard Fanout
                                  -> Top-K Merge -> Ranking -> Results

Signals Pipeline -> Feature Store -> Ranking Model
```

### Correctness boundaries
- Source document store is the durable record.
- Index is a derived projection and can lag.
- Query results can be partial only if policy allows.
- Ranking features can be stale within a defined freshness SLO.
- Index rollout should be versioned and reversible.

### Failure table
```text
Failure              Impact                         Mitigation
Shard timeout        partial/slow results           timeout budget and partial result policy
Index build lag      stale search                   freshness monitoring and catch-up workers
Bad ranking rollout  relevance drop                 A/B, canary, rollback
Hot query            cache pressure                 result cache and admission control
Crawler flood        ingest backlog                 rate limits and priority scheduling
```
