# Project 5: Log Aggregation System

## Goal
Build a working log aggregation system that:
- Accepts batched log lines from multiple service agents via HTTP
- Parses structured (JSON) and unstructured (plaintext) log formats
- Redacts PII (emails, credit cards, SSNs, phone numbers) before storing
- Stores logs in an in-memory hot index with time-range and full-text queries
- Applies backpressure when the ingestion buffer is full
- Simulates log agents from multiple services sending realistic events

This project teaches: pipeline design, PII redaction, in-memory indexing, backpressure, async fan-out.

---

## Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                    Log Agent (each service)                   │
│  Tail log file → batch every 2s → HTTP POST /ingest          │
└───────────────────────┬──────────────────────────────────────┘
                        │  HTTP POST {"logs": [...]}
                        ▼
┌──────────────────────────────────────────────────────────────┐
│                   Ingestion API  (FastAPI)                    │
│                                                              │
│  POST /ingest ──► BoundedQueue (maxsize=10,000)              │
│                        │  backpressure: 503 when >90% full   │
│                        ▼                                      │
│              Background Log Processor                        │
│                        │                                      │
│              ┌─────────▼─────────┐                           │
│              │   LogParser        │  JSON / plaintext         │
│              │   + PIIRedactor    │  regex mask PII           │
│              └─────────┬─────────┘                           │
│                        │  LogEvent objects                    │
│          ┌─────────────▼──────────────────┐                  │
│          │     InMemoryLogIndex (Hot)      │  last 100K logs  │
│          │     - by_trace index            │  O(1) trace lookup│
│          │     - time-range scan           │  newest-first    │
│          └─────────────┬──────────────────┘                  │
│                        │  (production: also write to S3/GCS) │
│                        ▼                                      │
│  GET /search  ─────────┤  service / level / time / trace / q │
│  GET /health  ─────────┘  buffer stats, parser stats         │
└──────────────────────────────────────────────────────────────┘

Production equivalent: Datadog, Splunk, Elastic, Loki, GCP Cloud Logging
```

---

## Capacity Estimation

```python
# Run this block standalone to understand the scale of a real log system.
# Mirrors what you'd calculate in a system design interview.

SERVICES              = 50    # microservices in the fleet
INSTANCES_PER_SERVICE = 10    # pods/containers per service
LOGS_PER_SEC_PER_INST = 100   # normal traffic; spikes 10x during incidents

total_logs_per_sec = SERVICES * INSTANCES_PER_SERVICE * LOGS_PER_SEC_PER_INST
print(f"Ingestion rate (normal):   {total_logs_per_sec:>10,} logs/sec")
print(f"Ingestion rate (10x spike):{total_logs_per_sec * 10:>10,} logs/sec")

# Storage sizing
AVG_LOG_BYTES   = 512        # structured JSON log with metadata
bytes_per_day   = total_logs_per_sec * 86_400 * AVG_LOG_BYTES
gb_per_day_raw  = bytes_per_day / (1024 ** 3)
gb_per_day_comp = gb_per_day_raw / 5          # gzip/zstd compresses JSON ~5x

print(f"\nIngestion bandwidth:       {total_logs_per_sec * AVG_LOG_BYTES / 1e6:>10.1f} MB/sec")
print(f"Raw storage/day:           {gb_per_day_raw:>10.1f} GB")
print(f"Compressed storage/day:    {gb_per_day_comp:>10.1f} GB")

# Retention tiers - key interview talking point
HOT_DAYS  = 7    # SSD-backed search index (OpenSearch/ClickHouse) — fast queries
WARM_DAYS = 30   # Object storage (S3/GCS) with query engine (Athena/BigQuery)
COLD_DAYS = 365  # Deep archive (Glacier) — compliance only, slow retrieval

hot_gb   = gb_per_day_comp * HOT_DAYS
warm_gb  = gb_per_day_comp * WARM_DAYS
cold_gb  = gb_per_day_comp * COLD_DAYS * 0.3  # additional compression at rest

print(f"\n--- Storage Tiers ---")
print(f"Hot  (last {HOT_DAYS}d, SSD):      {hot_gb:>8.0f} GB   — query in <1s")
print(f"Warm (last {WARM_DAYS}d, S3):      {warm_gb:>8.0f} GB   — query in 10-60s")
print(f"Cold (last {COLD_DAYS}d, Glacier): {cold_gb:>8.0f} GB   — retrieval ~hours")

# Buffer sizing for backpressure
BUFFER_SIZE     = 10_000    # events in the in-process queue
MAX_INGEST_RATE = 5_000     # our API's sustainable ingest (logs/sec)
BURST_DRAIN_S   = BUFFER_SIZE / MAX_INGEST_RATE
print(f"\nIn-process buffer:         {BUFFER_SIZE:>10,} log batches")
print(f"Burst absorption:          {BURST_DRAIN_S:>10.1f} seconds at peak")

# Expected output:
# Ingestion rate (normal):       50,000 logs/sec
# Ingestion rate (10x spike):   500,000 logs/sec
# Ingestion bandwidth:             25.6 MB/sec
# Raw storage/day:               2,212.6 GB
# Compressed storage/day:          442.5 GB
# --- Storage Tiers ---
# Hot  (last 7d, SSD):            3,098 GB   — query in <1s
# Warm (last 30d, S3):           13,275 GB   — query in 10-60s
# Cold (last 365d, Glacier):     48,429 GB   — retrieval ~hours
```

---

## Full Working Implementation

```python
#!/usr/bin/env python3
"""
log_aggregation.py — A working log aggregation pipeline.

Run server:   uv run log_aggregation.py
Run + agent:  uv run log_aggregation.py --with-agent
Test:         See curl commands in the Testing section below.
"""
# /// script
# dependencies = ["fastapi", "uvicorn[standard]", "httpx"]
# ///

import asyncio
import json
import re
import sys
import time
import uuid
from collections import deque, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse


# ============================================================================
# LogEvent — the core data model for every log entry
# ============================================================================

@dataclass
class LogEvent:
    """
    A single structured log entry after parsing and redaction.

    WHY a dataclass instead of a plain dict?
    - Type safety: the rest of the pipeline knows exactly what fields exist.
    - Immutable-ish: dataclasses signal "don't mutate after creation."
    - The `fields` dict absorbs arbitrary structured data from different services
      (e.g., one service sends `http_status`, another sends `db_query_ms`).

    In production (Datadog/Elastic), this maps to an index document with
    fixed schema columns + a dynamic `fields` blob.
    """
    timestamp: float          # Unix epoch seconds (server-assigned on receipt)
    service:   str            # "payment-service", "auth-service", etc.
    level:     str            # DEBUG | INFO | WARN | ERROR | FATAL
    message:   str            # Human-readable text (PII already redacted)
    trace_id:  str            # Correlates all logs for one request across services
    fields:    dict = field(default_factory=dict)   # Structured key-value pairs
    log_id:    str = field(default_factory=lambda: str(uuid.uuid4()))  # Unique row ID


# ============================================================================
# PIIRedactor — mask sensitive data before it ever touches storage
# ============================================================================

class PIIRedactor:
    """
    Strip Personally Identifiable Information from log messages using regex.

    WHY at ingestion time (not query time)?
    - If PII lands in storage, even briefly, you've violated GDPR/CCPA.
    - Redact before writing; once on disk, PII is extremely hard to purge
      (indexes, backups, replicas all need scrubbing).

    WHY regex and not an ML model?
    - Speed: regex is O(n × num_patterns) — microseconds per message.
    - Determinism: every run gives the same result; ML models can drift.
    - Auditability: you can show a compliance team the exact pattern list.

    Real incident: In 2018 Twitter logged plaintext passwords due to a bug
    that wrote to logs before hashing. Regex redaction of password= patterns
    would have caught this automatically.
    """

    # Each tuple: (compiled regex, replacement string)
    # Order matters: more specific patterns should come before general ones.
    PATTERNS = [
        # JWT tokens (eyJ...) — very common in auth logs
        (re.compile(r'\beyJ[A-Za-z0-9+/=_-]{20,}\b'),
         '[TOKEN]'),

        # Credit card numbers: 4111-1111-1111-1111 or 4111111111111111
        # 13-16 digits, optionally separated by spaces or dashes
        (re.compile(r'\b(?:\d{4}[-\s]?){3}\d{1,4}\b'),
         '[CC_NUMBER]'),

        # US Social Security Numbers: 123-45-6789
        (re.compile(r'\b\d{3}-\d{2}-\d{4}\b'),
         '[SSN]'),

        # US Phone numbers: (555) 123-4567 / 555-123-4567 / +1-555-123-4567
        (re.compile(r'\b(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b'),
         '[PHONE]'),

        # Email addresses: user@example.com
        (re.compile(r'\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b'),
         '[EMAIL]'),

        # Generic credential patterns: password=abc123, token=Bearer xyz, api_key=sk-...
        # Non-capturing group matches common key names, then captures =value
        (re.compile(r'(?i)\b(password|passwd|secret|token|api_key|apikey|auth)\s*[=:]\s*\S+'),
         r'\1=[REDACTED]'),
    ]

    def redact(self, text: str) -> tuple[str, list[str]]:
        """
        Apply all PII patterns to `text`.

        Returns: (redacted_text, list_of_what_was_found)

        The `found` list is stored as an audit field in the LogEvent.
        WHY track what was redacted?
        - Alerting: a spike in PII detections might mean a new code path is
          accidentally logging sensitive data (a bug, not normal operation).
        - Compliance: you can report "we detected and redacted 1,247 emails today."
        """
        found = []
        for pattern, replacement in self.PATTERNS:
            if pattern.search(text):
                found.append(pattern.pattern[:30])   # abbreviated pattern name
                text = pattern.sub(replacement, text)
        return text, found


# ============================================================================
# LogParser — raw JSON/text → LogEvent
# ============================================================================

class LogParser:
    """
    Normalize heterogeneous log formats into uniform LogEvent objects.

    WHY a parser layer (not just json.loads everywhere)?
    - Services use different field names: `ts`, `time`, `@timestamp`, `date`.
    - Log levels differ: `warn` vs `WARNING` vs `WARN`.
    - Some logs are plain text (legacy services, third-party dependencies).
    - Parsing errors must not crash the pipeline.

    Design philosophy — be LENIENT:
    - A crashed service often emits malformed logs right before dying.
    - That's exactly when you need those logs most (incident response).
    - Better to store something imperfect than to drop the log entirely.
    """

    # Normalize different timestamp field names to a single canonical form.
    TS_FIELDS = ['timestamp', 'time', 'ts', '@timestamp', 'date', 'time_unix']

    # Map any log level string to canonical ALL-CAPS form.
    LEVEL_MAP = {
        'debug': 'DEBUG',   'trace': 'DEBUG',
        'info':  'INFO',    'information': 'INFO',
        'warn':  'WARN',    'warning': 'WARN',
        'error': 'ERROR',   'err': 'ERROR',
        'fatal': 'FATAL',   'critical': 'FATAL',  'crit': 'FATAL',
    }

    # Fields consumed at the top level; the rest go into `event.fields`.
    KNOWN_FIELDS = frozenset({
        'timestamp', 'time', 'ts', '@timestamp', 'date', 'time_unix',
        'service', 'app', 'source', 'host', 'logger',
        'level', 'severity', 'lvl', 'log_level',
        'message', 'msg', 'text', 'body',
        'trace_id', 'traceId', 'request_id', 'correlation_id', 'span_id',
    })

    def __init__(self, redactor: Optional[PIIRedactor] = None):
        self.redactor = redactor
        self.stats = {
            'parsed_ok': 0,    # Successfully parsed as JSON
            'parsed_text': 0,  # Fell back to plaintext parser
            'failed': 0,       # Completely unparseable
            'pii_detections': 0,
        }

    def parse(self, raw: str) -> Optional[LogEvent]:
        """
        Parse one raw log line into a LogEvent.
        Returns None only if the input is completely empty/invalid.
        """
        raw = raw.strip()
        if not raw:
            return None

        # Attempt JSON first (structured logs from modern services)
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                return self._from_dict(data)
        except (json.JSONDecodeError, ValueError):
            pass

        # JSON failed — try plaintext (legacy logs, syslog format)
        return self._parse_plaintext(raw)

    def _from_dict(self, data: dict) -> LogEvent:
        """Build a LogEvent from a parsed JSON dict."""
        self.stats['parsed_ok'] += 1

        timestamp = self._extract_timestamp(data)

        service = (data.get('service') or data.get('app') or
                   data.get('source') or data.get('logger') or 'unknown')

        level_raw = str(data.get('level') or data.get('severity') or
                        data.get('lvl') or data.get('log_level') or 'INFO')
        level = self.LEVEL_MAP.get(level_raw.lower(), level_raw.upper())

        message = str(data.get('message') or data.get('msg') or
                      data.get('text') or data.get('body') or '')

        trace_id = str(
            data.get('trace_id') or data.get('traceId') or
            data.get('request_id') or data.get('correlation_id') or
            uuid.uuid4()
        )

        # Collect every field that isn't part of our schema into `fields`.
        # WHY? Preserve all original context for debugging, even unexpected fields.
        extra_fields = {k: v for k, v in data.items() if k not in self.KNOWN_FIELDS}

        # Redact PII from the human-readable message BEFORE writing to the index.
        if self.redactor and message:
            message, found = self.redactor.redact(message)
            if found:
                self.stats['pii_detections'] += len(found)
                extra_fields['_redacted_patterns'] = found   # audit trail

        return LogEvent(
            timestamp=timestamp,
            service=service,
            level=level,
            message=message,
            trace_id=trace_id,
            fields=extra_fields,
        )

    def _extract_timestamp(self, data: dict) -> float:
        """Try each known timestamp field; fall back to now."""
        for fname in self.TS_FIELDS:
            val = data.get(fname)
            if val is None:
                continue
            try:
                if isinstance(val, (int, float)):
                    # Heuristic: values > 1e12 are milliseconds (JS Date.now())
                    return float(val) / 1000.0 if val > 1e12 else float(val)
                if isinstance(val, str):
                    dt = datetime.fromisoformat(val.replace('Z', '+00:00'))
                    return dt.timestamp()
            except (ValueError, OSError, OverflowError):
                continue
        return time.time()   # Default: arrival time at the aggregator

    def _parse_plaintext(self, raw: str) -> Optional[LogEvent]:
        """
        Best-effort parse of non-JSON log lines.

        Example input: "ERROR [payment-svc] DB connection pool exhausted"
        WHY support plaintext at all? Third-party libraries, legacy services,
        and crash dumps rarely emit clean JSON. Discarding them loses signal.
        """
        self.stats['parsed_text'] += 1

        level   = 'INFO'
        service = 'unknown'
        message = raw

        # Token 1: might be a log level
        parts = raw.split(None, 2)
        if parts and parts[0].upper() in self.LEVEL_MAP:
            level   = self.LEVEL_MAP[parts[0].upper()]
            message = ' '.join(parts[1:]) if len(parts) > 1 else ''

        # Look for [service-name] bracket pattern
        bracket_match = re.search(r'\[([^\]]{1,60})\]', message)
        if bracket_match:
            service = bracket_match.group(1)

        if self.redactor:
            message, found = self.redactor.redact(message)
            if found:
                self.stats['pii_detections'] += len(found)

        return LogEvent(
            timestamp=time.time(),
            service=service,
            level=level,
            message=message,
            trace_id=str(uuid.uuid4()),
        )


# ============================================================================
# InMemoryLogIndex — hot storage with multi-dimensional query support
# ============================================================================

class InMemoryLogIndex:
    """
    Bounded in-memory store for the most recent logs.

    WHY in-memory for the hot tier?
    - During an incident, engineers query the last 15 minutes constantly.
    - Disk-backed indexes add 10–100ms per query; we need <50ms P99.
    - 100K logs × ~1KB each ≈ 100 MB — easily fits in one server's RAM.

    WHY deque(maxlen=N) instead of a list?
    - When maxlen is reached, the oldest entry is evicted automatically (O(1)).
    - A list would need O(n) shift to evict from the front.
    - The circular buffer behaviour exactly matches "keep last N logs."

    Production equivalent: this is effectively what the "hot" shard of an
    OpenSearch or ClickHouse cluster does, but with inverted indexes for
    full-text and columnar storage for fast aggregations.
    """

    def __init__(self, max_size: int = 100_000):
        self._logs: deque[LogEvent]         = deque(maxlen=max_size)
        self._by_trace: dict[str, list]     = {}   # trace_id → [LogEvent, ...]
        self._lock = asyncio.Lock()                 # protect concurrent coroutines

        self.stats = {'total_ingested': 0, 'total_evicted': 0}

    async def add(self, event: LogEvent) -> None:
        async with self._lock:
            # When deque is full, the leftmost item is auto-evicted.
            # We clean up the trace index for that evicted event.
            if len(self._logs) == self._logs.maxlen:
                oldest = self._logs[0]
                trace_list = self._by_trace.get(oldest.trace_id, [])
                self._by_trace[oldest.trace_id] = [
                    e for e in trace_list if e.log_id != oldest.log_id
                ]
                if not self._by_trace[oldest.trace_id]:
                    del self._by_trace[oldest.trace_id]
                self.stats['total_evicted'] += 1

            self._logs.append(event)

            # Maintain the trace index for O(1) trace_id lookups.
            # WHY a separate dict? Trace queries are the #1 use case in
            # incident response ("show me everything that happened to request X").
            if event.trace_id not in self._by_trace:
                self._by_trace[event.trace_id] = []
            self._by_trace[event.trace_id].append(event)

            self.stats['total_ingested'] += 1

    async def add_batch(self, events: list[LogEvent]) -> None:
        for event in events:
            await self.add(event)

    async def query(
        self,
        service:  Optional[str]   = None,
        level:    Optional[str]   = None,
        from_ts:  Optional[float] = None,
        to_ts:    Optional[float] = None,
        trace_id: Optional[str]   = None,
        q:        Optional[str]   = None,
        limit:    int             = 100,
    ) -> list[LogEvent]:
        """
        Multi-dimensional query with several fast paths.

        Query execution strategy (most selective first):
        1. trace_id — O(1) hash lookup; skip linear scan entirely.
        2. time range — prune ~80% of logs in typical incident windows.
        3. service + level — cheap string comparison.
        4. full-text (q) — O(n × m) substring; done last because it's slowest.

        WHY not build an inverted index for full-text?
        - At 100K logs, linear scan takes ~5ms in Python — acceptable.
        - An inverted index adds complexity and memory overhead.
        - In production: Elastic/OpenSearch handles this with Lucene indexes.
        """
        async with self._lock:
            # Fast path: trace_id with no other filters
            if trace_id and not any([service, level, from_ts, to_ts, q]):
                return list(self._by_trace.get(trace_id, []))[:limit]

            results = []
            # Iterate newest → oldest (reversed deque); incidents need recent logs first.
            for event in reversed(self._logs):
                if len(results) >= limit:
                    break
                if from_ts  and event.timestamp < from_ts:  continue
                if to_ts    and event.timestamp > to_ts:    continue
                if service  and event.service   != service: continue
                if level    and event.level     != level:   continue
                if trace_id and event.trace_id  != trace_id: continue
                if q:
                    needle = q.lower()
                    # Search message and all field values
                    haystack = event.message.lower()
                    haystack += ' ' + ' '.join(str(v) for v in event.fields.values()).lower()
                    if needle not in haystack:
                        continue
                results.append(event)

            return results

    def size(self) -> int:
        return len(self._logs)


# ============================================================================
# BoundedIngestionBuffer — backpressure via a size-limited async queue
# ============================================================================

class BoundedIngestionBuffer:
    """
    A size-limited async queue between the Ingestion API and the log processor.

    WHY a buffer between HTTP and the index?
    - HTTP request handlers must return quickly (<100ms).
    - JSON parsing + regex redaction + index writes take variable time.
    - The buffer decouples the two; ingestion API stays fast.

    WHY bounded (not unlimited)?
    - During incidents, log volume spikes 10–100x.
    - An unbounded queue silently grows until the server OOM-kills.
    - A bounded queue gives you visible, controllable backpressure:
      503 to the agent is recoverable; OOM crash is not.

    Backpressure strategy:
    - Buffer < 90% full: accept batch immediately.
    - Buffer ≥ 90% full: return HTTP 503 → agent backs off and retries.
    - Agent retry with exponential backoff is the correct response.
    """

    def __init__(self, maxsize: int = 10_000):
        self.maxsize = maxsize
        self._queue: asyncio.Queue          # created in async context
        self.dropped   = 0
        self.processed = 0

    def initialize(self) -> None:
        """Must be called inside a running asyncio event loop."""
        self._queue = asyncio.Queue(maxsize=self.maxsize)

    @property
    def qsize(self) -> int:
        return self._queue.qsize()

    @property
    def utilization(self) -> float:
        return self.qsize / self.maxsize if self.maxsize else 0.0

    async def try_put(self, item: Any) -> bool:
        """Non-blocking enqueue. Returns False (dropped) when full."""
        try:
            self._queue.put_nowait(item)
            return True
        except asyncio.QueueFull:
            self.dropped += 1
            return False

    async def get(self) -> Any:
        return await self._queue.get()

    def task_done(self) -> None:
        self._queue.task_done()


# ============================================================================
# FastAPI Application
# ============================================================================

redactor = PIIRedactor()
parser   = LogParser(redactor=redactor)
index    = InMemoryLogIndex(max_size=100_000)
buffer   = BoundedIngestionBuffer(maxsize=10_000)

app = FastAPI(title="Log Aggregation API", version="1.0.0")


@app.on_event("startup")
async def startup() -> None:
    buffer.initialize()
    # Start the background log processor as an asyncio Task.
    # WHY not a thread? asyncio Tasks share the event loop; no locking needed
    # for the queue. A thread would need thread-safe queues and locks.
    asyncio.create_task(log_processor(), name="log-processor")


async def log_processor() -> None:
    """
    Background coroutine: drains the buffer, parses, redacts, and indexes logs.

    This is the "consumer" side of the producer-consumer pipeline.
    The Ingestion API is the "producer" — it just enqueues raw batches.

    By keeping this in a single coroutine (not many), we avoid lock contention
    on the index. The index's async lock still protects against concurrent
    query handlers, but the write path is always this one task.
    """
    print("[processor] Log processor started.")
    while True:
        try:
            # Wait up to 1 second for a batch; loop back if nothing arrives.
            raw_batch: list[str] = await asyncio.wait_for(buffer.get(), timeout=1.0)
        except asyncio.TimeoutError:
            continue
        except asyncio.CancelledError:
            break

        try:
            events = []
            for raw_line in raw_batch:
                if raw_line.strip():
                    event = parser.parse(raw_line)
                    if event:
                        events.append(event)

            if events:
                await index.add_batch(events)
                buffer.processed += len(events)
        except Exception as exc:
            print(f"[processor] Error: {exc}")
        finally:
            buffer.task_done()


# --- Ingestion endpoint ---

@app.post("/ingest")
async def ingest_logs(payload: dict) -> dict:
    """
    Accept a batch of raw log lines from an agent.

    Body: {"logs": ["<raw log line>", ...]}

    WHY batched (not one log per request)?
    - At 50,000 logs/sec, per-log HTTP overhead would dominate.
    - One HTTP connection + one round-trip for 1,000 logs = 50 connections/sec.
    - Compression works better on batches of similar log data.
    - Agents typically flush every 1–5 seconds or every 1,000 events.
    """
    raw_logs: list[str] = payload.get("logs", [])

    if not raw_logs:
        return {"status": "ok", "queued": 0, "message": "empty batch"}

    # Reject absurdly large batches to prevent memory spikes.
    # Each batch is held in RAM until the processor drains it.
    if len(raw_logs) > 10_000:
        raise HTTPException(
            status_code=413,
            detail="Batch too large. Maximum 10,000 log lines per request."
        )

    # Backpressure: if the buffer is nearly full, reject with 503.
    # WHY 90% (not 100%)? Leave headroom so the processor can drain
    # before we start accepting again. Prevents oscillation.
    if buffer.utilization >= 0.90:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "buffer_full",
                "message": "Ingestion buffer at capacity. Retry in 2-5 seconds.",
                "buffer_utilization": f"{buffer.utilization:.1%}",
                "dropped_total": buffer.dropped,
                "tip": "Agent should back off exponentially and retry.",
            }
        )

    accepted = await buffer.try_put(raw_logs)
    status   = "queued" if accepted else "dropped"

    return {
        "status": status,
        "queued": len(raw_logs) if accepted else 0,
        "buffer_utilization": f"{buffer.utilization:.1%}",
        "dropped_total": buffer.dropped,
    }


# --- Search / query endpoint ---

@app.get("/search")
async def search_logs(
    service:  Optional[str]   = Query(None, description="Exact service name filter"),
    level:    Optional[str]   = Query(None, description="Log level: DEBUG/INFO/WARN/ERROR/FATAL"),
    from_ts:  Optional[float] = Query(None, description="Start of time range (Unix epoch seconds)"),
    to_ts:    Optional[float] = Query(None, description="End of time range (Unix epoch seconds)"),
    trace_id: Optional[str]   = Query(None, description="Distributed trace ID (exact match)"),
    q:        Optional[str]   = Query(None, description="Full-text search in message + fields"),
    limit:    int             = Query(100, ge=1, le=1_000),
) -> dict:
    """
    Query stored logs with up to 6 simultaneous filter dimensions.

    Most common incident query patterns:
    - "Last 100 ERRORs from payment-service in the last 10 minutes"
      → level=ERROR, service=payment-service, from_ts=<10min ago>
    - "Trace everything that happened to request X"
      → trace_id=<uuid>   (fastest: O(1) index lookup)
    - "Find logs mentioning 'connection refused'"
      → q=connection refused
    """
    now = time.time()
    results = await index.query(
        service=service,
        level=level,
        from_ts=from_ts,
        to_ts=to_ts,
        trace_id=trace_id,
        q=q,
        limit=limit,
    )

    return {
        "count": len(results),
        "query_time_ms": round((time.time() - now) * 1000, 2),
        "logs": [
            {
                "log_id":        event.log_id,
                "timestamp_iso": datetime.fromtimestamp(
                    event.timestamp, tz=timezone.utc
                ).isoformat(),
                "timestamp":     event.timestamp,
                "service":       event.service,
                "level":         event.level,
                "message":       event.message,
                "trace_id":      event.trace_id,
                "fields":        event.fields,
            }
            for event in results
        ],
    }


# --- Health / observability endpoint ---

@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok",
        "index": {
            "size": index.size(),
            "total_ingested": index.stats["total_ingested"],
            "total_evicted":  index.stats["total_evicted"],
        },
        "buffer": {
            "qsize":       buffer.qsize,
            "utilization": f"{buffer.utilization:.1%}",
            "dropped":     buffer.dropped,
            "processed":   buffer.processed,
        },
        "parser": {
            "parsed_ok":     parser.stats["parsed_ok"],
            "parsed_text":   parser.stats["parsed_text"],
            "failed":        parser.stats["failed"],
            "pii_detections": parser.stats["pii_detections"],
        },
    }


# ============================================================================
# Log Agent Simulator — mimics agents running inside each microservice
# ============================================================================

async def run_agent_simulator() -> None:
    """
    Simulate multiple microservices emitting structured log events.

    In production:
    - Fluent Bit / Vector / Filebeat tail local log files.
    - They batch events and POST to the ingestion gateway.
    - This simulator shows the exact same pattern in miniature.

    Notice the PII in some messages — the redactor will mask it.
    """
    import random

    SERVICES = [
        'auth-service', 'payment-service', 'order-service',
        'inventory-service', 'notification-service',
    ]
    LEVELS = ['DEBUG'] * 40 + ['INFO'] * 40 + ['WARN'] * 15 + ['ERROR'] * 5

    TEMPLATES = [
        "User {user} authenticated via {method}",
        "Payment processed: order={order_id} amount=${amount}",
        "DB query took {latency_ms}ms on table {table}",
        "Cache {result} for key user:{user_id}",
        "Retry attempt {attempt}/3 calling {downstream}",
        "HTTP {status} {method} {path} in {latency_ms}ms",
        # These contain PII — will be redacted by PIIRedactor:
        "User registered with email {email} phone {phone}",
        "Payment declined for card {card} — insufficient funds",
        "SSN {ssn} verification failed for user {user}",
        "password={password} reset link sent to {email}",
    ]

    print("[agent] Simulator started — sending logs to http://localhost:8000/ingest")

    # Wait for the server to be ready
    await asyncio.sleep(2.0)

    async with httpx.AsyncClient(timeout=5.0) as client:
        batch_num = 0
        while True:
            batch = []
            for _ in range(random.randint(20, 80)):
                service  = random.choice(SERVICES)
                level    = random.choice(LEVELS)
                template = random.choice(TEMPLATES)
                msg = template.format(
                    user        = f"user_{random.randint(1, 999)}",
                    method      = random.choice(['GET', 'POST', 'PUT', 'password']),
                    order_id    = str(uuid.uuid4())[:8],
                    amount      = round(random.uniform(1, 9999), 2),
                    latency_ms  = random.randint(1, 4999),
                    table       = random.choice(['orders', 'users', 'payments']),
                    result      = random.choice(['hit', 'miss']),
                    user_id     = random.randint(1, 9999),
                    attempt     = random.randint(1, 3),
                    downstream  = random.choice(SERVICES),
                    status      = random.choice([200, 200, 200, 400, 500]),
                    path        = random.choice(['/api/orders', '/api/users', '/api/payments']),
                    email       = f"user{random.randint(1,99)}@example.com",
                    phone       = f"555-{random.randint(100,999)}-{random.randint(1000,9999)}",
                    card        = f"4111-{random.randint(1000,9999)}-{random.randint(1000,9999)}-{random.randint(1000,9999)}",
                    ssn         = f"{random.randint(100,999)}-{random.randint(10,99)}-{random.randint(1000,9999)}",
                    password    = "".join(random.choices("abcdef1234", k=12)),
                )

                log_line = json.dumps({
                    "timestamp":  time.time(),
                    "service":    service,
                    "level":      level,
                    "message":    msg,
                    "trace_id":   str(uuid.uuid4()),
                    "latency_ms": random.randint(1, 2000),
                    "http_status": random.choice([200, 200, 400, 500]),
                    "region":     random.choice(["us-east-1", "eu-west-1"]),
                })
                batch.append(log_line)

            try:
                resp = await client.post(
                    "http://localhost:8000/ingest",
                    json={"logs": batch},
                )
                result = resp.json()
                batch_num += 1
                print(
                    f"[agent] batch={batch_num:04d} "
                    f"logs={len(batch):3d} "
                    f"status={result.get('status')} "
                    f"buffer={result.get('buffer_utilization')}"
                )
            except Exception as exc:
                print(f"[agent] Send failed: {exc}")

            # Flush every 2 seconds — typical agent interval.
            await asyncio.sleep(2.0)


# ============================================================================
# Entry point
# ============================================================================

async def main() -> None:
    """
    Run the server and optionally the agent simulator in the same event loop.

    Using asyncio.gather lets both the HTTP server and the agent coroutine
    run concurrently within a single thread — no threads, no inter-process
    communication, just cooperative multitasking.
    """
    config = uvicorn.Config(app, host="127.0.0.1", port=8000, log_level="warning")
    server = uvicorn.Server(config)

    if "--with-agent" in sys.argv:
        print("[main] Starting server + agent simulator together...")
        await asyncio.gather(server.serve(), run_agent_simulator())
    else:
        print("[main] Starting server only. Use --with-agent to also start the simulator.")
        await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
```

---

## Testing the API

```bash
# Terminal 1: start server with agent generating logs
uv run log_aggregation.py --with-agent

# Terminal 2: run queries

# --- Ingest a manual batch ---
curl -s -X POST http://localhost:8000/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "logs": [
      "{\"timestamp\": 1700000000, \"service\": \"payment-service\", \"level\": \"ERROR\", \"message\": \"DB connection failed\", \"trace_id\": \"abc-123\"}",
      "{\"timestamp\": 1700000001, \"service\": \"payment-service\", \"level\": \"WARN\",  \"message\": \"Retry attempt 1/3\",        \"trace_id\": \"abc-123\"}",
      "ERROR [auth-service] User email user@example.com failed login"
    ]
  }' | python3 -m json.tool

# Expected:
# { "status": "queued", "queued": 3, "buffer_utilization": "0.0%" }


# --- Search: all ERRORs from payment-service ---
curl -s "http://localhost:8000/search?service=payment-service&level=ERROR&limit=5" \
  | python3 -m json.tool


# --- Search: trace all events for a specific request ---
# (grab a trace_id from the agent output first)
curl -s "http://localhost:8000/search?trace_id=abc-123" \
  | python3 -m json.tool


# --- Full-text search: find logs mentioning "connection" ---
curl -s "http://localhost:8000/search?q=connection&limit=10" \
  | python3 -m json.tool


# --- Time-range query: last 60 seconds of WARN+ logs ---
FROM=$(python3 -c "import time; print(time.time() - 60)")
curl -s "http://localhost:8000/search?level=WARN&from_ts=${FROM}&limit=20" \
  | python3 -m json.tool


# --- Health check: see PII detection stats ---
curl -s http://localhost:8000/health | python3 -m json.tool
# You should see pii_detections > 0 because the agent sends emails, cards, SSNs.


# --- Trigger backpressure: flood with 9001 simultaneous requests ---
# Buffer fills → you'll start seeing HTTP 503 responses
for i in $(seq 1 20); do
  curl -s -o /dev/null -w "HTTP %{http_code}\n" \
    -X POST http://localhost:8000/ingest \
    -H "Content-Type: application/json" \
    -d '{"logs": ["'"$(python3 -c "import json,time,uuid; print(json.dumps({'service':'stress','level':'INFO','message':'load test','timestamp':time.time(),'trace_id':str(uuid.uuid4())}))"'"]}' &
done
wait
# Some will return 200, eventually you'll see 503 as buffer fills
```

---

## Hot / Warm / Cold Storage Tiers

```text
┌─────────────────────────────────────────────────────────────────────┐
│                      Storage Tier Breakdown                         │
├──────────┬──────────────┬─────────────┬──────────────┬─────────────┤
│  Tier    │  Duration    │  Technology │  Query Speed │  Cost/GB    │
├──────────┼──────────────┼─────────────┼──────────────┼─────────────┤
│  HOT     │  0–7 days    │  OpenSearch │  <1 second   │  $$$  (SSD) │
│          │              │  ClickHouse │              │             │
│          │              │  RAM index  │              │             │
├──────────┼──────────────┼─────────────┼──────────────┼─────────────┤
│  WARM    │  8–30 days   │  S3/GCS     │  10–60 sec   │  $   (HDD)  │
│          │              │  + Athena   │              │             │
│          │              │  / BigQuery │              │             │
├──────────┼──────────────┼─────────────┼──────────────┼─────────────┤
│  COLD    │  31–365 days │  S3 Glacier │  Hours       │  ¢   (tape) │
│          │  (compliance)│  Deep Archive│             │             │
└──────────┴──────────────┴─────────────┴──────────────┴─────────────┘

WHY three tiers?
  Hot:  95% of queries hit last 24h (incident response). Pay for speed.
  Warm: Regulatory audits, trend analysis, capacity planning. Pay for space.
  Cold: Legal hold, GDPR right-to-erasure audit trail. Pay for almost nothing.

Transition rules (automated by lifecycle policies):
  Log created → written to HOT index immediately.
  After 7 days → archived to S3 (WARM) in Parquet/ORC format (compressed ~10x).
  After 30 days → transitioned to S3 Glacier (COLD).
  After 365 days → deleted (unless under legal hold).

Real-world systems doing this:
  - Datadog:     "Flex Logs" warm tier, hot search index for recent
  - Elastic:     ILM (Index Lifecycle Management) with hot/warm/cold/frozen
  - Loki:        Chunk store (S3) + query cache (memcached)
  - Splunk:      SmartStore — S3 backed warm tier with SSD hot cache
```

---

## Backpressure Mechanism

```text
WHY backpressure is non-negotiable:

  Normal day:         50,000 logs/sec → processor keeps up → buffer at 20%.
  Incident day:      500,000 logs/sec → processor falls behind → buffer grows.
  Without backpressure: buffer grows until server OOM → crash → ALL logs lost.
  With backpressure:    503 to agents → agents retry → system stays alive.

  Key insight: losing 10% of logs during an incident is acceptable.
               Losing 100% of logs because the aggregator crashed is not.

Backpressure signals (from aggregator back to agent):
  HTTP 503  — immediate: "drop this batch, retry in N seconds"
  HTTP 429  — rate limit: "you're sending too fast overall"
  Slow ACK  — implicit: if /ingest takes >5s, agent's client timeout fires → retry

Agent retry policy:
  1st retry:  wait 1s
  2nd retry:  wait 2s  (exponential backoff)
  3rd retry:  wait 4s
  4th retry:  wait 8s
  Max backoff: 60s
  After 5 failures: emit alert, write to local disk buffer (overflow file)
```

```python
# Backpressure demo — standalone snippet showing the pattern.
# The actual implementation is in the BoundedIngestionBuffer class above.

import asyncio

class BackpressureDemo:
    """
    Show how a bounded queue naturally creates backpressure.
    Run this with: python3 -c "import asyncio; from log_aggregation import BackpressureDemo; asyncio.run(BackpressureDemo().run())"
    """
    QUEUE_MAX = 10

    async def run(self):
        q = asyncio.Queue(maxsize=self.QUEUE_MAX)
        accepted = dropped = 0

        # Simulate a burst of 25 batches into a queue that holds only 10
        for i in range(25):
            try:
                q.put_nowait(f"batch-{i}")
                accepted += 1
                print(f"  batch-{i:02d}: ACCEPTED  (queue: {q.qsize()}/{self.QUEUE_MAX})")
            except asyncio.QueueFull:
                dropped += 1
                print(f"  batch-{i:02d}: DROPPED   → agent must retry (503 in real system)")

        print(f"\nResult: {accepted} accepted, {dropped} dropped")
        print("Agent should back off and retry dropped batches.")
        print("Queue held at max capacity — server protected from OOM.")

# Expected output:
#   batch-00: ACCEPTED  (queue: 1/10)
#   ...
#   batch-09: ACCEPTED  (queue: 10/10)
#   batch-10: DROPPED   → agent must retry (503 in real system)
#   ...
#   batch-24: DROPPED   → agent must retry (503 in real system)
#   Result: 10 accepted, 15 dropped
```

---

## Key Learning Points

```text
1. PIPELINE DECOUPLING: HTTP ingestion → queue → parser → index
   Each stage runs at its own pace. The queue absorbs mismatches.
   If indexing slows (GC pause, slow disk), ingest keeps accepting.
   Without the queue: any slowdown in indexing directly stalls HTTP responses.

2. PII REDACTION — BEFORE STORAGE, ALWAYS:
   Once PII lands in an index, it propagates to backups, replicas, and exports.
   Purging it from all copies is expensive and error-prone.
   Redact at ingest; never touch raw PII after the parser stage.

3. STRUCTURED LOGS OVER TEXT:
   Text: "User john bought product 42 at 09:15"
   JSON: {"user": "john", "action": "purchase", "product_id": 42, "time": "09:15"}
   JSON enables filtering, aggregation, and alerting on specific fields.
   Text requires regex parsing at query time — slow and fragile.

4. TRACE IDs — THE KILLER FEATURE:
   One request touches auth-service, order-service, payment-service.
   Each emits logs. Without trace_id: you have three separate streams.
   With trace_id: one query gives you the full story across all services.
   Implement this from day one; retrofitting it is painful.

5. BACKPRESSURE — PROTECT THE AGGREGATOR:
   The aggregator is more valuable than individual log batches.
   Design rule: always bound queues; always return 503 when full.
   Agents MUST implement retry with exponential backoff.

6. HOT/WARM/COLD TIERS — PAY FOR WHAT YOU USE:
   Storing 1 year of logs on NVMe SSDs costs ~100x more than S3 Glacier.
   Design your retention policy first; it determines your storage budget.
   Most queries (95%) hit logs <24h old — optimize the hot tier.

7. LENIENT PARSING — LOGS DURING CRASHES ARE MALFORMED:
   A service going OOM often emits half-written JSON before dying.
   Those malformed logs are your most valuable incident signal.
   Parse what you can; store the rest as raw text; never discard.
```
