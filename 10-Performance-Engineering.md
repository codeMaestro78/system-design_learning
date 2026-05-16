# Part 8: Performance Engineering (Deep)

## 1) Profiling Systems

### Goal
Replace guesswork with measurement.

### What to profile
- CPU hotspots
- Memory pressure and GC
- I/O wait
- Lock contention
- Network wait/retransmissions

### Rule
Never optimize before baseline profiling.

---

## 2) Bottleneck Identification

### Method
1. Define SLO and load profile.
2. Measure end-to-end latency breakdown.
3. Find saturated resource.
4. Improve narrowest stage.

### Queueing insight
High utilization drives nonlinear latency growth.

---

## 3) Latency Breakdown

Typical web call:
```text
DNS + TCP + TLS + LB + App + Cache/DB + Downstream + Serialization
```

Maintain per-hop budgets and track budget regressions.

---

## 4) Tail Latency (P99 Problem)

### Why it matters
Users experience tails, not averages.

### Causes
- GC pauses
- Noisy neighbors
- Retries and queue buildup
- Cross-region calls

### Mitigations
- Bounded queues
- Hedged requests (careful)
- Deadline propagation
- Workload isolation

## Sophisticated Performance Roadmap

### Topics and subtopics
- Latency budgets: client, network, edge, service, cache, DB, downstream.
- Throughput: CPU, memory, I/O, connection pools, event loop saturation.
- Tail latency: p95, p99, p999, coordinated omission.
- Queueing theory: utilization, waiting time, backpressure.
- Profiling: CPU flamegraphs, heap snapshots, lock contention, syscall latency.
- Load testing: baseline, stress, soak, spike, failure-injection tests.
- Optimization: caching, batching, async work, indexes, data locality.

### Example latency budget
```text
Total p95 target: 200 ms
Edge + network: 40 ms
API gateway: 10 ms
Service logic: 30 ms
Cache/DB: 70 ms
Downstream calls: 30 ms
Serialization/logging buffer: 20 ms
```

### Architecture for performance testing
```text
Load Generator -> API -> Service -> Cache/DB/Queue
                         -> Metrics
                         -> Traces
                         -> Profiling Output
```

### Real systems to study
- Google search latency culture: every millisecond affects UX.
- Netflix playback startup optimization.
- Trading systems where tail latency directly impacts money.
- E-commerce checkout where slow payment dependencies reduce conversion.

### Design exercise
Given an endpoint with p99 = 2 seconds:
- Break down latency by dependency.
- Identify saturation.
- Add a timeout and fallback.
- Reduce synchronous work.
- Prove improvement with before/after metrics.

## Rigorous Performance Review

### Latency budget template
```text
Endpoint: ...
SLO: p95 <= ... ms, p99 <= ... ms

Client/network: ...
Gateway: ...
Service CPU: ...
Cache: ...
Database: ...
Downstream: ...
Serialization/logging: ...
Safety margin: ...
```

### Load test types
- Smoke: low traffic, correctness.
- Baseline: expected traffic.
- Stress: find breaking point.
- Spike: sudden traffic burst.
- Soak: long-running stability.
- Failure injection: dependency timeouts and partial outages.

### Performance anti-patterns
- Measuring averages only.
- Running load tests without realistic data volume.
- Retrying requests after the caller deadline expired.
- Optimizing code before fixing slow queries.
- Ignoring queue age while request latency looks healthy.
- Adding cache without invalidation rules.

---

## 5) Caching at Scale

### Layers
- Browser/app cache
- CDN edge cache
- Service cache
- DB cache

### Anti-stampede
- Request coalescing
- Soft TTL + background refresh
- Jittered expiry

## Exercises
1. Create latency budget for feed API with P50/P95/P99 targets.
2. Identify top 3 tail-latency causes in chat delivery pipeline and mitigation.

---

## Performance Tuning Playbook

### Profiling loop
1. Baseline measurement
2. Isolate hotspot
3. Optimize one variable at a time
4. Re-measure and compare
5. Keep/rollback based on data

### Common high-impact wins
- Reduce network round trips
- Avoid N+1 DB query patterns
- Improve cache hit ratio
- Bound queue sizes
- Optimize serialization overhead

### Tail-latency controls
- End-to-end deadlines
- Retry budget limits
- Hedged requests only for idempotent reads
- Thread-pool isolation for critical endpoints

### Benchmark hygiene
- Warm-up period
- Representative payloads
- Stable environment
- Include error rates, not only latency

---

## 6) Latency Numbers Every Engineer Should Know

These are the foundational numbers from Jeff Dean (Google). Every system designer must internalize them — they turn vague intuition into hard constraints.

### Reference Table

```text
Operation                          Latency        Notes
─────────────────────────────────────────────────────────────────
L1 cache reference                 0.5 ns         CPU on-die cache
Branch misprediction               5   ns         CPU pipeline flush
L2 cache reference                 7   ns         14x slower than L1
Mutex lock/unlock                  25  ns
Main memory (RAM) reference        100 ns          200x slower than L1
Compress 1 KB with Snappy          3   μs
Send 1 KB over 1 Gbps network      10  μs
Read 4 KB from SSD                 150 μs         ~1M IOPS SSDs
Read 1 MB sequentially from RAM    250 μs
Round trip inside same datacenter  0.5 ms
Read 1 MB sequentially from SSD    1   ms
Disk seek (HDD)                    10  ms         20x slower than SSD
Read 1 MB sequentially from HDD    20  ms
Send packet CA → Netherlands → CA  150 ms         Cross-continental RTT
─────────────────────────────────────────────────────────────────
```

### What These Numbers Mean for System Design

**Rule 1: RAM is cheap, network is not**
A RAM access is 100 ns. A same-DC network roundtrip is 0.5 ms = 500,000 ns.
That means one network hop costs as much as **5,000 RAM accesses**.
→ Cache aggressively. Avoid chatty microservice calls inside a hot path.

**Rule 2: N database calls per request is a budget killer**
If each DB round-trip inside the same DC costs ~1 ms:
- 10 DB calls/request  →  10 ms  (acceptable)
- 100 DB calls/request → 100 ms  (approaching SLO limit)
- 500 DB calls/request → 500 ms  (SLO blown)

This is why the **N+1 query problem** is catastrophic at scale (see Section 11).

**Rule 3: SSD ≠ RAM**
SSD reads are 150 μs — 1,500x slower than RAM.
Reading uncached DB rows from SSD inside a 50 ms latency budget means
you can afford at most ~300 random SSD reads per request. In practice,
far fewer because of queueing, OS overhead, and other work.

**Rule 4: Cross-region is human-perceptible**
150 ms cross-region RTT is at the edge of human perception for UI.
Never put synchronous cross-region calls in the critical rendering path.
Use async replication, CQRS, or read replicas in each region instead.

**Rule 5: Multipliers compound fast**
```
Serialization:        1 ms
DB query (cached):    2 ms   x 3 queries  =  6 ms
External API call:   50 ms   x 1 call     = 50 ms
─────────────────────────────────────────────────
Total sequential:              57 ms
```
If the external API is behind a slow cross-region link, your P99 explodes.
→ Run external calls in parallel where possible. Always set timeouts.

---

## 7) The USE Method (Brendan Gregg)

The USE Method gives you a checklist to diagnose **any** resource bottleneck:

- **U**tilization  — What fraction of time is the resource busy?
- **S**aturation  — How much work is queued / waiting for the resource?
- **E**rrors       — Are there failures or error events?

Apply it to: CPU, memory, disk I/O, network interfaces, connection pools.

### Why This Matters
Most engineers jump to "CPU is high!" but ignore queue depth (saturation).
A CPU at 60% utilization with a run-queue depth of 40 is far worse than
one at 80% with a run-queue depth of 0 — the saturated one introduces
latency through queueing even though utilization looks moderate.

### Python Simulation of USE Metrics

```python
import time
import random
import threading
from dataclasses import dataclass, field
from typing import List

@dataclass
class USESnapshot:
    resource: str
    utilization: float   # 0.0 → 1.0
    saturation: float    # queue depth or wait queue length
    errors: int          # error count in window


class ResourceMonitor:
    """
    Simulates USE-method monitoring for CPU, memory, disk, and network.
    In production you'd read from /proc/stat, psutil, or Prometheus exporters.
    """

    def __init__(self):
        self._error_counts = {"cpu": 0, "memory": 0, "disk": 0, "network": 0}
        self._lock = threading.Lock()

    # ── CPU ─────────────────────────────────────────────────────────────────
    def cpu_use(self) -> USESnapshot:
        """
        Utilization : fraction of time CPUs are not idle (from /proc/stat in prod).
        Saturation  : run-queue length (nr_running from /proc/schedstat).
        Errors      : machine check exceptions, throttle events.
        """
        # Simulate by doing real work and measuring elapsed vs wall-clock
        start = time.perf_counter()
        busy_time = 0.0
        for _ in range(200_000):
            busy_time += 0.000001          # simulate burn
        elapsed = time.perf_counter() - start

        utilization = min(busy_time / max(elapsed, 1e-9), 1.0)
        saturation  = random.uniform(0, 4)     # simulated run-queue depth
        errors      = self._error_counts["cpu"]
        return USESnapshot("CPU", utilization, saturation, errors)

    # ── Memory ───────────────────────────────────────────────────────────────
    def memory_use(self) -> USESnapshot:
        """
        Utilization : bytes used / total bytes.
        Saturation  : swap usage or memory reclaim pressure (pgscan rate).
        Errors      : OOM events (dmesg | grep oom-killer in prod).
        """
        try:
            import psutil
            vm   = psutil.virtual_memory()
            swap = psutil.swap_memory()
            utilization = vm.percent / 100.0
            saturation  = swap.percent / 100.0      # swap as saturation proxy
        except ImportError:
            # Fallback if psutil not installed
            utilization = random.uniform(0.4, 0.85)
            saturation  = random.uniform(0.0, 0.1)

        errors = self._error_counts["memory"]
        return USESnapshot("Memory", utilization, saturation, errors)

    # ── Disk I/O ─────────────────────────────────────────────────────────────
    def disk_use(self) -> USESnapshot:
        """
        Utilization : % of time disk was busy (%util from iostat).
        Saturation  : average queue length (avgqu-sz from iostat).
        Errors      : I/O errors from /proc/diskstats or dmesg.
        """
        try:
            import psutil
            counters = psutil.disk_io_counters()
            # Approximate: read+write time as fraction of 1-second window
            time.sleep(0.05)
            counters2 = psutil.disk_io_counters()
            busy_ms = (
                (counters2.read_time  - counters.read_time) +
                (counters2.write_time - counters.write_time)
            )
            utilization = min(busy_ms / 50.0, 1.0)   # fraction of 50 ms window
            saturation  = random.uniform(0, 2)        # simulated queue depth
        except (ImportError, AttributeError):
            utilization = random.uniform(0.1, 0.5)
            saturation  = random.uniform(0.0, 1.0)

        errors = self._error_counts["disk"]
        return USESnapshot("Disk I/O", utilization, saturation, errors)

    # ── Network ──────────────────────────────────────────────────────────────
    def network_use(self, interface_speed_mbps: float = 1000) -> USESnapshot:
        """
        Utilization : throughput / link capacity.
        Saturation  : tx/rx queue drops or retransmit rate.
        Errors      : packet errors, CRC errors from ethtool -S.
        """
        try:
            import psutil
            t0 = psutil.net_io_counters()
            time.sleep(0.05)
            t1 = psutil.net_io_counters()
            bytes_per_sec = ((t1.bytes_sent + t1.bytes_recv) -
                             (t0.bytes_sent + t0.bytes_recv)) / 0.05
            capacity_bps  = interface_speed_mbps * 1e6 / 8
            utilization   = min(bytes_per_sec / capacity_bps, 1.0)
            errors         = t1.errin + t1.errout
        except (ImportError, AttributeError):
            utilization = random.uniform(0.05, 0.3)
            errors       = random.randint(0, 5)

        saturation = random.uniform(0, 0.5)   # drop queue depth
        return USESnapshot("Network", utilization, saturation, errors)

    def report(self) -> None:
        """Run all USE checks and print a human-readable report."""
        snapshots = [
            self.cpu_use(),
            self.memory_use(),
            self.disk_use(),
            self.network_use(),
        ]
        print(f"\n{'Resource':<12} {'Utilization':>12} {'Saturation':>12} {'Errors':>8}")
        print("─" * 48)
        for s in snapshots:
            u_bar = "█" * int(s.utilization * 10) + "░" * (10 - int(s.utilization * 10))
            flag  = " ⚠️  SATURATED" if s.saturation > 2 else ""
            print(
                f"{s.resource:<12} {s.utilization*100:>10.1f}%  "
                f"{s.saturation:>10.2f}  {s.errors:>8}{flag}"
            )

    def inject_error(self, resource: str) -> None:
        with self._lock:
            self._error_counts[resource] = self._error_counts.get(resource, 0) + 1


# ── Usage ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    monitor = ResourceMonitor()
    monitor.inject_error("disk")   # simulate a disk I/O error
    monitor.report()

# Example output:
# Resource     Utilization   Saturation   Errors
# ────────────────────────────────────────────────
# CPU              72.3%         1.84          0
# Memory           61.0%         0.02          0
# Disk I/O         34.5%         0.71          1
# Network          12.1%         0.22          5
#
# KEY INSIGHT: CPU at 72% looks fine, but if saturation > 2 you have a
# run-queue problem that will spike your P99 latency even before CPU hits 100%.
```

---

## 8) Amdahl's Law in Practice

**The core insight:** You cannot get unlimited speedup by throwing more cores
at a problem. Every program has a sequential fraction that fundamentally
limits parallelism gains.

### The Formula

```
Speedup(n) = 1 / (1 - p + p/n)

Where:
  p = fraction of work that can be parallelized  (0.0 → 1.0)
  n = number of processors / parallel workers
  (1-p) = sequential fraction that cannot be parallelized
```

### Intuition
If 10% of your code is sequential (p = 0.90), the maximum theoretical
speedup with infinite processors is just **10x** — not infinite. With 16
cores you only get ~6.4x. The sequential 10% becomes the new bottleneck.

```python
import math

def amdahl_speedup(p: float, n: int) -> float:
    """
    p : parallelizable fraction (e.g. 0.9 = 90% parallelizable)
    n : number of processors
    Returns theoretical maximum speedup over single-threaded baseline.
    """
    if not 0.0 <= p <= 1.0:
        raise ValueError("p must be between 0 and 1")
    if n < 1:
        raise ValueError("n must be >= 1")
    return 1.0 / ((1.0 - p) + p / n)


def print_amdahl_table() -> None:
    """Show how diminishing returns hit as we add more cores."""
    parallelizable_fractions = [0.50, 0.75, 0.90, 0.95, 0.99]
    core_counts = [1, 2, 4, 8, 16, 32, 64, 128, 256, 1024]

    header = f"{'Cores':>6} | " + " | ".join(f"p={p:.0%}" for p in parallelizable_fractions)
    print(header)
    print("─" * len(header))

    for n in core_counts:
        row = f"{n:>6} | "
        row += " | ".join(
            f"{amdahl_speedup(p, n):>7.2f}x" for p in parallelizable_fractions
        )
        print(row)

    print("\nTheoretical maximum (n → ∞):")
    for p in parallelizable_fractions:
        max_speedup = 1.0 / (1.0 - p) if p < 1.0 else float("inf")
        print(f"  p={p:.0%}  →  max speedup = {max_speedup:.1f}x")


def plot_amdahl_ascii() -> None:
    """ASCII graph of speedup vs cores for p=0.90 (the common case)."""
    p = 0.90
    cores = [1, 2, 4, 8, 16, 32, 64, 128]
    print(f"\nAmdahl's Law — p={p:.0%} parallelizable")
    print("Speedup")
    max_speedup = 10.0

    for n in cores:
        s = amdahl_speedup(p, n)
        bar_len = int((s / max_speedup) * 50)
        bar = "█" * bar_len
        print(f"  {n:>4} cores | {bar:<50} {s:.2f}x")

    print(f"\n  Max theoretical: {1/(1-p):.1f}x  (16 cores only achieves "
          f"{amdahl_speedup(p, 16):.1f}x — not 16x!)")


def find_cores_for_target(p: float, target_speedup: float) -> int:
    """
    How many cores do you need to hit a target speedup?
    Returns -1 if theoretically impossible.
    """
    max_possible = 1.0 / (1.0 - p) if p < 1.0 else float("inf")
    if target_speedup >= max_possible:
        return -1
    # Solve: target = 1 / ((1-p) + p/n)  →  n = p / (1/target - (1-p))
    n = p / (1.0 / target_speedup - (1.0 - p))
    return math.ceil(n)


# ── Usage ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print_amdahl_table()
    plot_amdahl_ascii()

    # Practical question: to get 5x speedup with 90% parallelizable code,
    # how many cores do we need?
    cores_needed = find_cores_for_target(p=0.90, target_speedup=5.0)
    print(f"\nTo get 5x speedup with p=90%: need {cores_needed} cores")

    cores_needed = find_cores_for_target(p=0.90, target_speedup=9.9)
    print(f"To get 9.9x speedup with p=90%: need {cores_needed} cores")

    impossible = find_cores_for_target(p=0.90, target_speedup=11.0)
    print(f"To get 11x speedup with p=90%: {'IMPOSSIBLE (max is 10x)' if impossible == -1 else impossible}")

# Sample output:
# Cores | p=50%  | p=75%  | p=90%  | p=95%  | p=99%
# ──────────────────────────────────────────────────────────────
#     1 |   1.00x |   1.00x |   1.00x |   1.00x |   1.00x
#     2 |   1.33x |   1.60x |   1.82x |   1.90x |   1.98x
#     4 |   1.60x |   2.29x |   3.08x |   3.48x |   3.88x
#     8 |   1.78x |   2.91x |   4.71x |   5.93x |   7.48x
#    16 |   1.88x |   3.37x |   6.40x |   9.03x |  13.9x
#    32 |   1.94x |   3.66x |   7.80x |  12.3x  |  24.2x
#   128 |   1.98x |   3.91x |   9.28x |  17.4x  |  56.3x
#
# KEY TAKEAWAY: p=90%, 16 cores → 6.4x speedup (not 16x).
# The 10% sequential code is the hard ceiling.
```

---

## 9) Little's Law

**One of the most powerful laws in queueing theory.** It connects three
fundamental quantities of any system — throughput, latency, and concurrency.

### The Formula

```
L = λ × W

L = average number of requests in the system (concurrency / in-flight)
λ = average arrival rate (requests per second)
W = average time a request spends in the system (seconds)
```

### Intuition
Think of a restaurant. If 60 customers arrive per hour (λ=1/min) and
each stays 30 minutes (W=30), there are always 30 customers inside (L=30).
If you want to handle 100/hour, you need 50 seats — no exceptions.

```python
from dataclasses import dataclass


@dataclass
class SystemCapacity:
    """Little's Law calculator for capacity planning."""
    arrival_rate_rps: float   # λ — requests per second arriving
    avg_latency_s: float      # W — average time per request in seconds

    @property
    def concurrency(self) -> float:
        """L = λ × W — requests in-flight at steady state."""
        return self.arrival_rate_rps * self.avg_latency_s

    @property
    def required_threads(self) -> int:
        """
        Minimum thread/coroutine pool size to sustain this load.
        Add headroom for bursts (typically 20–30% more).
        """
        return math.ceil(self.concurrency * 1.25)  # 25% headroom

    def max_rps_given_concurrency(self, max_concurrent: int) -> float:
        """
        Given a fixed concurrency limit (e.g. connection pool size),
        what is the maximum sustainable RPS before queueing?
        """
        return max_concurrent / self.avg_latency_s

    def latency_at_utilization(self, utilization: float) -> float:
        """
        M/M/1 queueing model: latency grows as 1/(1-ρ) where ρ = utilization.
        At 50% util: 2x base latency. At 90%: 10x. At 95%: 20x.
        """
        if not 0.0 <= utilization < 1.0:
            raise ValueError("utilization must be in [0, 1)")
        return self.avg_latency_s / (1.0 - utilization)


import math

def littles_law_examples() -> None:
    print("=" * 65)
    print("Little's Law: L = λ × W")
    print("=" * 65)

    scenarios = [
        ("Low traffic API",          100,   0.050),   # 100 rps, 50ms
        ("Medium traffic API",        500,   0.050),   # 500 rps, 50ms
        ("High traffic with slow DB", 1000,  0.200),   # 1000 rps, 200ms
        ("Real-time chat service",    5000,  0.005),   # 5000 rps, 5ms
        ("Video transcoding queue",     10, 30.000),   # 10 rps, 30s each
    ]

    for name, rps, latency_s in scenarios:
        cap = SystemCapacity(rps, latency_s)
        L = cap.concurrency
        print(f"\n{name}")
        print(f"  Arrival rate λ  = {rps} req/s")
        print(f"  Avg latency  W  = {latency_s*1000:.0f} ms")
        print(f"  Concurrency  L  = {L:.1f} requests in-flight")
        print(f"  Recommended threads/pool = {cap.required_threads}")
        print(f"  Max RPS at L={int(L)} concurrency = "
              f"{cap.max_rps_given_concurrency(int(L)):.0f} req/s")

    print("\n" + "=" * 65)
    print("Latency under load (M/M/1 queueing — watch it explode near 100%):")
    print("=" * 65)
    api = SystemCapacity(arrival_rate_rps=100, avg_latency_s=0.05)
    print(f"Base latency = {api.avg_latency_s*1000:.0f} ms")
    for util in [0.10, 0.25, 0.50, 0.70, 0.80, 0.90, 0.95, 0.99]:
        observed = api.latency_at_utilization(util)
        bar = "█" * int(observed / api.avg_latency_s)
        print(f"  ρ={util:.0%}  → {observed*1000:>8.1f} ms  {bar}")


def capacity_planning(
    target_rps: float,
    p99_latency_s: float,
    safety_factor: float = 1.3
) -> dict:
    """
    Given a throughput target and P99 latency SLO, compute:
    - minimum in-flight concurrency (Little's Law)
    - thread/connection pool size (with safety margin)
    - utilization budget (stay below 70% for headroom)
    """
    # Use P99 as the worst-case W in Little's Law
    L = target_rps * p99_latency_s
    pool_size = math.ceil(L * safety_factor)

    # At 70% utilization, queueing latency = 1/(1-0.7) = 3.3x base
    # so we want actual load < 70% of pool capacity
    safe_max_rps = (pool_size * 0.70) / p99_latency_s

    return {
        "target_rps":       target_rps,
        "p99_latency_ms":   p99_latency_s * 1000,
        "min_concurrency":  L,
        "pool_size":        pool_size,
        "safe_max_rps":     safe_max_rps,
        "over_provisioned": safe_max_rps >= target_rps,
    }


# ── Usage ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    littles_law_examples()

    plan = capacity_planning(target_rps=500, p99_latency_s=0.200)
    print(f"\nCapacity plan: {plan}")

# KEY INSIGHT: If 100 req/s arrive and each takes 50ms, then:
#   L = 100 × 0.050 = 5 requests in-flight simultaneously
# Your thread pool needs at least 5 slots (add 25% → 7 threads minimum).
# If your pool is only 3, you'll queue and latency will spike.
```

---

## 10) Async Load Testing Script

Measures true latency distribution at a target QPS using `asyncio`.
Reports P50, P75, P95, P99, P999 and detects coordinated omission.

```python
"""
async_load_test.py — Proper load testing with asyncio.

Usage:
    python async_load_test.py

Requires: aiohttp (pip install aiohttp)
"""
import asyncio
import time
import math
import statistics
import random
from collections import defaultdict
from typing import List, Optional


# ── HdrHistogram-lite: tracks latency buckets for accurate percentiles ────────
class LatencyHistogram:
    """
    Lightweight latency tracker.
    Stores individual samples (up to max_samples) for accurate percentile math.
    For production use, replace with hdrh library (pip install hdrh).
    """
    def __init__(self, max_samples: int = 1_000_000):
        self.samples: List[float] = []
        self.max_samples = max_samples
        self.overflow_count = 0

    def record(self, latency_ms: float) -> None:
        if len(self.samples) < self.max_samples:
            self.samples.append(latency_ms)
        else:
            self.overflow_count += 1

    def percentile(self, p: float) -> float:
        if not self.samples:
            return 0.0
        sorted_samples = sorted(self.samples)
        idx = int(math.ceil(p / 100.0 * len(sorted_samples))) - 1
        return sorted_samples[max(0, idx)]

    def mean(self) -> float:
        return statistics.mean(self.samples) if self.samples else 0.0

    def summary(self) -> dict:
        return {
            "count":   len(self.samples),
            "mean_ms": round(self.mean(), 2),
            "p50_ms":  round(self.percentile(50),  2),
            "p75_ms":  round(self.percentile(75),  2),
            "p95_ms":  round(self.percentile(95),  2),
            "p99_ms":  round(self.percentile(99),  2),
            "p999_ms": round(self.percentile(99.9),2),
            "max_ms":  round(max(self.samples), 2) if self.samples else 0,
        }


# ── Simulated HTTP call (replace with real aiohttp in production) ─────────────
async def fake_http_get(url: str) -> tuple[int, float]:
    """
    Simulates an HTTP GET with realistic latency distribution:
    - 80% fast responses: 10–50ms
    - 15% medium: 50–200ms  (DB cache miss)
    - 4% slow: 200–500ms    (slow query)
    - 1% very slow: 500ms+  (tail events)
    Returns (status_code, latency_ms).
    """
    roll = random.random()
    if roll < 0.80:
        delay = random.uniform(0.010, 0.050)
    elif roll < 0.95:
        delay = random.uniform(0.050, 0.200)
    elif roll < 0.99:
        delay = random.uniform(0.200, 0.500)
    else:
        delay = random.uniform(0.500, 2.000)   # tail spike

    # Simulate 1% error rate
    status = 500 if random.random() < 0.01 else 200
    await asyncio.sleep(delay)
    return status, delay * 1000   # return latency in ms


# ── Core load test engine ─────────────────────────────────────────────────────
async def async_load_test(
    url: str,
    qps: float,
    duration_s: float,
    timeout_ms: float = 2000,
) -> dict:
    """
    Sends requests at a fixed QPS for duration_s seconds.
    Uses coordinated-omission-aware scheduling: requests are dispatched
    on a fixed schedule regardless of previous response times.

    Args:
        url        : target URL (unused in simulation; plug in aiohttp)
        qps        : target requests per second
        duration_s : test duration in seconds
        timeout_ms : per-request timeout in milliseconds

    Returns dict with full latency percentiles, error rate, achieved QPS.
    """
    histogram      = LatencyHistogram()
    error_counts   = defaultdict(int)
    total_sent     = 0
    total_errors   = 0
    interval_s     = 1.0 / qps            # ideal gap between request starts
    start_wall     = time.perf_counter()
    deadline       = start_wall + duration_s

    print(f"Starting load test: {qps} QPS for {duration_s}s → "
          f"target {int(qps * duration_s)} requests")
    print(f"Interval between requests: {interval_s*1000:.2f} ms")
    print("-" * 60)

    async def send_one(scheduled_start: float) -> None:
        """
        Coordinated-omission fix: we measure latency from the SCHEDULED
        start time, not the actual send time. If the event loop was busy
        and delayed us by 20ms, that 20ms counts as latency too.
        """
        nonlocal total_sent, total_errors
        total_sent += 1
        actual_start = time.perf_counter()

        try:
            status, latency_ms = await asyncio.wait_for(
                fake_http_get(url),
                timeout=timeout_ms / 1000
            )
            # CO-corrected latency: includes scheduling delay
            co_corrected_latency = (time.perf_counter() - scheduled_start) * 1000
            histogram.record(co_corrected_latency)

            if status != 200:
                total_errors += 1
                error_counts[status] += 1

        except asyncio.TimeoutError:
            total_errors += 1
            error_counts["timeout"] += 1
            histogram.record(timeout_ms)   # record as full timeout

    # ── Dispatch loop: fire requests on fixed schedule ────────────────────────
    tasks = []
    tick  = 0
    while True:
        scheduled = start_wall + tick * interval_s
        now = time.perf_counter()

        if scheduled > deadline:
            break

        wait = scheduled - now
        if wait > 0:
            await asyncio.sleep(wait)

        task = asyncio.create_task(send_one(scheduled))
        tasks.append(task)
        tick += 1

    # Wait for all in-flight requests to complete
    await asyncio.gather(*tasks, return_exceptions=True)

    elapsed        = time.perf_counter() - start_wall
    achieved_qps   = total_sent / elapsed
    error_rate_pct = (total_errors / total_sent * 100) if total_sent else 0

    stats = histogram.summary()
    stats["achieved_qps"]   = round(achieved_qps, 1)
    stats["target_qps"]     = qps
    stats["duration_s"]     = round(elapsed, 1)
    stats["total_requests"] = total_sent
    stats["total_errors"]   = total_errors
    stats["error_rate_pct"] = round(error_rate_pct, 3)
    stats["error_breakdown"] = dict(error_counts)
    return stats


def print_histogram(histogram: LatencyHistogram, buckets: int = 20) -> None:
    """ASCII histogram of response times."""
    if not histogram.samples:
        return
    min_v, max_v = min(histogram.samples), max(histogram.samples)
    bucket_size  = (max_v - min_v) / buckets or 1
    counts       = defaultdict(int)
    for s in histogram.samples:
        b = int((s - min_v) / bucket_size)
        counts[min(b, buckets - 1)] += 1
    max_count = max(counts.values()) if counts else 1

    print("\nResponse Time Histogram (ms):")
    print("-" * 60)
    for i in range(buckets):
        lo  = min_v + i * bucket_size
        hi  = lo + bucket_size
        cnt = counts[i]
        bar = "█" * int(cnt / max_count * 40)
        print(f"  {lo:>7.1f}–{hi:<7.1f} | {bar:<40} {cnt}")


def print_results(results: dict) -> None:
    print("\n" + "=" * 60)
    print("LOAD TEST RESULTS")
    print("=" * 60)
    print(f"  Achieved QPS   : {results['achieved_qps']} / {results['target_qps']} target")
    print(f"  Total requests : {results['total_requests']}")
    print(f"  Errors         : {results['total_errors']} ({results['error_rate_pct']}%)")
    print(f"  Error breakdown: {results['error_breakdown']}")
    print()
    print("  Latency Percentiles (coordinated-omission corrected):")
    print(f"    P50   : {results['p50_ms']:>8.2f} ms")
    print(f"    P75   : {results['p75_ms']:>8.2f} ms")
    print(f"    P95   : {results['p95_ms']:>8.2f} ms")
    print(f"    P99   : {results['p99_ms']:>8.2f} ms")
    print(f"    P99.9 : {results['p999_ms']:>8.2f} ms")
    print(f"    Max   : {results['max_ms']:>8.2f} ms")
    print()
    if results['error_rate_pct'] > 1.0:
        print("  ⚠️  ERROR RATE > 1% — SLO likely violated")
    if results['p99_ms'] > 500:
        print("  ⚠️  P99 > 500ms — investigate tail latency sources")


# ── Run ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    results = asyncio.run(
        async_load_test(url="http://localhost:8080/api", qps=50, duration_s=5)
    )
    print_results(results)
```

---

## 11) The N+1 Query Problem

One of the most common and devastating performance bugs in backend systems.
Named because: you make **1** query to get N items, then **N** more queries
to fetch related data — totalling N+1 queries.

### The Bug and the Fix

```python
"""
n_plus_one_demo.py
Demonstrates N+1 queries vs. batch fetch, with timing comparison.
Uses sqlite3 (no external deps required).
"""
import sqlite3
import time
import random

# ── Setup: create an in-memory SQLite database ────────────────────────────────
def setup_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row

    conn.executescript("""
        CREATE TABLE users (
            id   INTEGER PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE orders (
            id         INTEGER PRIMARY KEY,
            user_id    INTEGER NOT NULL,
            amount     REAL    NOT NULL,
            created_at TEXT    NOT NULL
        );
        CREATE INDEX idx_orders_user_id ON orders(user_id);
    """)

    # Insert 200 users, each with 5 orders
    users  = [(i, f"User_{i}") for i in range(1, 201)]
    orders = [
        (i * 5 + j, i, round(random.uniform(10, 500), 2), "2024-01-01")
        for i in range(1, 201) for j in range(5)
    ]
    conn.executemany("INSERT INTO users VALUES (?, ?)", users)
    conn.executemany("INSERT INTO orders VALUES (?, ?, ?, ?)", orders)
    conn.commit()
    return conn


# ── BAD: N+1 pattern ─────────────────────────────────────────────────────────
def get_users_with_orders_bad(conn: sqlite3.Connection) -> list:
    """
    N+1 pattern:
    1 query  → fetch all users
    N queries → for each user, fetch their orders separately
    Total: 1 + N queries (201 queries for 200 users)
    """
    users = conn.execute("SELECT * FROM users").fetchall()

    result = []
    for user in users:
        # This fires a NEW query for EVERY user — N queries in a loop
        orders = conn.execute(
            "SELECT * FROM orders WHERE user_id = ?", (user["id"],)
        ).fetchall()
        result.append({"user": dict(user), "orders": [dict(o) for o in orders]})

    return result


# ── GOOD: Single JOIN query ───────────────────────────────────────────────────
def get_users_with_orders_join(conn: sqlite3.Connection) -> list:
    """
    JOIN pattern: 1 query fetches everything.
    DB does the heavy lifting; we just reassemble in Python.
    """
    rows = conn.execute("""
        SELECT
            u.id   AS user_id,
            u.name AS user_name,
            o.id   AS order_id,
            o.amount,
            o.created_at
        FROM users u
        LEFT JOIN orders o ON o.user_id = u.id
        ORDER BY u.id
    """).fetchall()

    # Reassemble into user → [orders] structure
    result: dict = {}
    for row in rows:
        uid = row["user_id"]
        if uid not in result:
            result[uid] = {"user": {"id": uid, "name": row["user_name"]}, "orders": []}
        if row["order_id"] is not None:
            result[uid]["orders"].append({
                "id": row["order_id"],
                "amount": row["amount"],
                "created_at": row["created_at"],
            })
    return list(result.values())


# ── GOOD: Batch fetch (alternative when JOIN is complex) ──────────────────────
def get_users_with_orders_batch(conn: sqlite3.Connection) -> list:
    """
    Batch pattern: 2 queries total regardless of N.
    Query 1: fetch all users.
    Query 2: fetch ALL orders for those users with WHERE user_id IN (...).
    Reassemble in application memory.
    """
    users = conn.execute("SELECT * FROM users").fetchall()
    user_ids = [u["id"] for u in users]

    # Single query with IN clause — 1 network roundtrip
    placeholders = ",".join("?" * len(user_ids))
    orders = conn.execute(
        f"SELECT * FROM orders WHERE user_id IN ({placeholders})", user_ids
    ).fetchall()

    # Group orders by user_id in Python (O(n) pass)
    from collections import defaultdict
    orders_by_user: dict = defaultdict(list)
    for order in orders:
        orders_by_user[order["user_id"]].append(dict(order))

    return [
        {"user": dict(u), "orders": orders_by_user[u["id"]]}
        for u in users
    ]


# ── Benchmark ─────────────────────────────────────────────────────────────────
def benchmark(conn: sqlite3.Connection, runs: int = 5) -> None:
    functions = [
        ("N+1 (BAD)  ", get_users_with_orders_bad),
        ("JOIN (GOOD) ", get_users_with_orders_join),
        ("BATCH (GOOD)", get_users_with_orders_batch),
    ]

    print(f"{'Strategy':<20} {'Avg ms':>10} {'Min ms':>10} {'Max ms':>10}  Result rows")
    print("─" * 70)

    for name, fn in functions:
        times = []
        result_count = 0
        for _ in range(runs):
            t0 = time.perf_counter()
            data = fn(conn)
            t1 = time.perf_counter()
            times.append((t1 - t0) * 1000)
            result_count = len(data)

        avg = sum(times) / len(times)
        print(f"  {name:<18} {avg:>9.2f}  {min(times):>9.2f}  {max(times):>9.2f}  {result_count}")

    print("\nKey insight: N+1 sends 201 round-trips to the DB.")
    print("JOIN/BATCH send 1–2. At 1ms per round-trip that's")
    print("  N+1:  ~201ms of I/O overhead")
    print("  JOIN:   ~1ms of I/O overhead")
    print("The difference explodes as N grows (10k users → 10,001 queries).")


if __name__ == "__main__":
    conn = setup_db()
    benchmark(conn)
    conn.close()
```

---

## 12) Connection Pooling

Every new database connection costs: TCP handshake + TLS + DB auth + memory
allocation. At 10ms per connect and 1,000 RPS, connection overhead alone
is **10 seconds of latency** per second of traffic — completely unsustainable.

Connection pooling amortizes this by keeping connections alive and reusing them.

```python
"""
connection_pool_demo.py
Demonstrates the cost of per-request connections vs. a pool.
Uses sqlite3 wrapped in a manual pool (works without asyncpg/PostgreSQL).

In production: use asyncpg.create_pool() or SQLAlchemy's connection pool.
"""
import sqlite3
import threading
import time
import queue
import random
import statistics
from typing import Optional


# ── Simulated "expensive" connect (adds artificial delay like real TCP+auth) ──
CONNECT_OVERHEAD_MS = 10   # realistic for a local PostgreSQL connection

def make_connection() -> sqlite3.Connection:
    """Simulate the cost of establishing a new DB connection."""
    time.sleep(CONNECT_OVERHEAD_MS / 1000)   # pay the connection tax
    conn = sqlite3.connect(":memory:", check_same_thread=False)
    conn.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT, v INT)")
    conn.execute("INSERT INTO kv VALUES ('x', 42)")
    conn.commit()
    return conn

def run_query(conn: sqlite3.Connection) -> int:
    """Simulate a simple DB query (< 1ms on in-memory SQLite)."""
    time.sleep(random.uniform(0.001, 0.003))  # 1–3ms query time
    return conn.execute("SELECT v FROM kv WHERE k='x'").fetchone()[0]


# ── Strategy 1: New connection per request (BAD) ──────────────────────────────
def no_pool_request(request_id: int, results: list) -> None:
    t0 = time.perf_counter()
    conn = make_connection()            # 10ms overhead every time!
    _ = run_query(conn)
    conn.close()
    latency_ms = (time.perf_counter() - t0) * 1000
    results[request_id] = latency_ms


# ── Strategy 2: Connection pool (GOOD) ───────────────────────────────────────
class SimpleConnectionPool:
    """
    Thread-safe connection pool.
    In production, use asyncpg.create_pool() or psycopg2.pool.ThreadedConnectionPool.
    """
    def __init__(self, min_size: int = 5, max_size: int = 20):
        self.min_size  = min_size
        self.max_size  = max_size
        self._pool: queue.Queue = queue.Queue(maxsize=max_size)
        self._active   = 0
        self._lock     = threading.Lock()

        # Pre-warm minimum connections
        print(f"  Pre-warming pool with {min_size} connections...")
        for _ in range(min_size):
            self._pool.put(make_connection())
            self._active += 1
        print(f"  Pool ready ({min_size} connections pre-warmed)")

    def acquire(self, timeout: float = 5.0) -> sqlite3.Connection:
        try:
            # Try to get an existing idle connection first
            return self._pool.get(timeout=0.001)
        except queue.Empty:
            with self._lock:
                if self._active < self.max_size:
                    # Pool not full — create a new connection
                    self._active += 1
                    conn = make_connection()
                    return conn
            # Pool exhausted — wait for a connection to be returned
            return self._pool.get(timeout=timeout)

    def release(self, conn: sqlite3.Connection) -> None:
        self._pool.put(conn)

    def close_all(self) -> None:
        while not self._pool.empty():
            self._pool.get().close()


def pooled_request(pool: SimpleConnectionPool, request_id: int, results: list) -> None:
    t0   = time.perf_counter()
    conn = pool.acquire()              # fast: reuse existing connection
    try:
        _ = run_query(conn)
    finally:
        pool.release(conn)             # return to pool for next request
    latency_ms = (time.perf_counter() - t0) * 1000
    results[request_id] = latency_ms


# ── Benchmark ──────────────────────────────────────────────────────────────────
def benchmark_pooling(num_requests: int = 40) -> None:
    print("=" * 65)
    print(f"Connection Pool Benchmark — {num_requests} concurrent requests")
    print("=" * 65)

    # ── Without pool ──────────────────────────────────────────────────────────
    print(f"\n[1] No Pool (new connection per request, overhead={CONNECT_OVERHEAD_MS}ms each)")
    results_no_pool = [0.0] * num_requests
    threads = [
        threading.Thread(target=no_pool_request, args=(i, results_no_pool))
        for i in range(num_requests)
    ]
    t0 = time.perf_counter()
    for t in threads: t.start()
    for t in threads: t.join()
    wall_no_pool = (time.perf_counter() - t0) * 1000

    # ── With pool ─────────────────────────────────────────────────────────────
    print(f"\n[2] With Pool (min_size=5, max_size=20)")
    pool = SimpleConnectionPool(min_size=5, max_size=20)
    results_pool = [0.0] * num_requests
    threads = [
        threading.Thread(target=pooled_request, args=(pool, i, results_pool))
        for i in range(num_requests)
    ]
    t0 = time.perf_counter()
    for t in threads: t.start()
    for t in threads: t.join()
    wall_pool = (time.perf_counter() - t0) * 1000
    pool.close_all()

    # ── Report ────────────────────────────────────────────────────────────────
    def report(label: str, data: list, wall_ms: float) -> None:
        print(f"\n  {label}")
        print(f"    P50 latency : {statistics.median(data):.1f} ms")
        print(f"    P95 latency : {sorted(data)[int(len(data)*0.95)]:.1f} ms")
        print(f"    P99 latency : {sorted(data)[int(len(data)*0.99)]:.1f} ms")
        print(f"    Max latency : {max(data):.1f} ms")
        print(f"    Wall-clock  : {wall_ms:.1f} ms")
        print(f"    Throughput  : {len(data) / (wall_ms/1000):.0f} req/s")

    report("No Pool", results_no_pool, wall_no_pool)
    report("With Pool", results_pool, wall_pool)

    speedup = statistics.median(results_no_pool) / statistics.median(results_pool)
    print(f"\n  Speedup (median latency): {speedup:.1f}x faster with pool")
    print(f"\n  Rule of thumb:")
    print(f"    min_size = expected_avg_concurrency (Little's Law L)")
    print(f"    max_size = peak_concurrency * 1.2   (burst headroom)")
    print(f"    Don't set max_size too high — DB has connection limits too!")


if __name__ == "__main__":
    benchmark_pooling(num_requests=40)
```

---

## 13) Coordinated Omission

The most important flaw in naive load testing — and almost nobody knows about it.

### The Problem

A naive load tester works like this:
```
send request → wait for response → record latency → send next request
```
If the server gets slow (e.g., GC pause causes 2s response), the load tester
**pauses too** — effectively sending fewer requests during the slowdown.
It misses the queued-up latency that real users experience.

**Real world:** The server is slow for 2 seconds. Real users who arrived during
those 2 seconds wait 2+ seconds. The naive tester only measures the _recovery_
latency and reports a healthy P99. This is **coordinated omission**.

### The Fix: Schedule-Based Measurement

```python
"""
coordinated_omission_demo.py
Shows why naive testers underreport P99 and how to fix it.
"""
import asyncio
import random
import time
import math
import statistics


# ── Simulated server: 95% fast, 5% "GC pause" at 1–2 seconds ────────────────
async def server_with_pauses() -> float:
    roll = random.random()
    if roll < 0.95:
        delay = random.uniform(0.005, 0.020)   # fast: 5–20ms
    else:
        delay = random.uniform(1.0, 2.0)       # GC pause: 1–2s
    await asyncio.sleep(delay)
    return delay * 1000   # return latency in ms


# ── Naive tester: measures response time sequentially (WRONG) ─────────────────
async def naive_load_test(num_requests: int) -> list:
    """
    Sends request → waits for response → records → sends next.
    During a pause, it sends fewer requests. It MISSES the waiting.
    """
    latencies = []
    for _ in range(num_requests):
        t0 = time.perf_counter()
        await server_with_pauses()
        latencies.append((time.perf_counter() - t0) * 1000)
    return latencies


# ── Correct tester: schedule-based (measures from INTENDED send time) ─────────
async def correct_load_test(num_requests: int, interval_s: float) -> list:
    """
    Dispatches requests on a fixed schedule.
    If the server is slow, subsequent requests queue up and measure their
    TOTAL wait time — just like real users experience.
    """
    start    = time.perf_counter()
    latencies = []
    tasks    = []

    async def timed_request(scheduled_time: float) -> None:
        # Wait until scheduled dispatch time
        wait = scheduled_time - time.perf_counter()
        if wait > 0:
            await asyncio.sleep(wait)
        # Latency = time from SCHEDULED dispatch, not actual dispatch
        await server_with_pauses()
        co_latency = (time.perf_counter() - scheduled_time) * 1000
        latencies.append(co_latency)

    for i in range(num_requests):
        scheduled = start + i * interval_s
        task = asyncio.create_task(timed_request(scheduled))
        tasks.append(task)

    await asyncio.gather(*tasks)
    return latencies


def percentile(data: list, p: float) -> float:
    if not data: return 0.0
    s = sorted(data)
    idx = int(math.ceil(p / 100.0 * len(s))) - 1
    return s[max(0, idx)]


async def compare_methods() -> None:
    N        = 500
    qps      = 50.0
    interval = 1.0 / qps

    print("Coordinated Omission Demo")
    print(f"Server profile: 95% at 5–20ms, 5% at 1000–2000ms (GC pauses)")
    print(f"Load: {N} requests at {qps} QPS")
    print("=" * 60)

    print("\n[1] Running NAIVE tester (sequential)...")
    naive = await naive_load_test(N)

    print("[2] Running CORRECT tester (schedule-based)...")
    correct = await correct_load_test(N, interval)

    def report(label: str, data: list) -> None:
        print(f"\n  {label} ({len(data)} samples)")
        print(f"    Mean  : {statistics.mean(data):>8.1f} ms")
        print(f"    P50   : {percentile(data, 50):>8.1f} ms")
        print(f"    P95   : {percentile(data, 95):>8.1f} ms")
        print(f"    P99   : {percentile(data, 99):>8.1f} ms")
        print(f"    P99.9 : {percentile(data, 99.9):>8.1f} ms")
        print(f"    Max   : {max(data):>8.1f} ms")

    report("Naive (WRONG)", naive)
    report("CO-Corrected (RIGHT)", correct)

    print(f"""
KEY INSIGHT:
  Naive P99 likely shows ~20ms (only measures fast responses).
  CO-corrected P99 shows ~1500ms (captures the GC pause impact).

  The naive result says "your system is fine." 
  The corrected result says "5% of your users wait 1–2 seconds."

  Real-world tools that fix this: HdrHistogram + wrk2, Gatling.
  The load_test() in Section 10 above uses schedule-based dispatch
  to avoid this problem.
""")


if __name__ == "__main__":
    asyncio.run(compare_methods())
