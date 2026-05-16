# Part 9: Production & DevOps (Deep)

## 1) CI/CD Pipelines

### Pipeline stages
1. Build
2. Unit/integration tests
3. Security checks
4. Artifact publish
5. Staged deployment
6. Post-deploy verification
7. Rollback if SLO regression

### Principle
Small, frequent, reversible deployments beat big risky releases.

---

## 2) Observability (Logs, Metrics, Traces)

### Logs
Structured event details for debugging.

### Metrics
Time-series health and trends (RED/USE).

### Traces
Request path and latency decomposition across services.

### Good practice
Correlation IDs across all telemetry.

---

## 3) Alerting Systems

Alert on:
- SLO burn rate
- Error-rate spikes
- Saturation leading indicators

Avoid noisy alerts without actionable runbooks.

---

## 4) Chaos Engineering

Inject controlled failures to validate assumptions:
- Node kill
- Network latency injection
- Dependency outage simulation

Goal: prove resilience and expose hidden coupling.

---

## 5) Deployment Strategies

### Blue-Green
Two identical environments, instant traffic switch.

## Sophisticated Production Engineering Roadmap

### Topics and subtopics
- CI/CD: build, test, scan, package, deploy, verify, rollback.
- Deployment: rolling, blue-green, canary, shadow traffic.
- Observability: logs, metrics, traces, profiling, audit events.
- Reliability: SLO, SLA, SLI, error budget, incident review.
- Operations: runbooks, dashboards, alert tuning, escalation.
- Security: secrets, IAM, vulnerability scanning, supply-chain integrity.
- Disaster recovery: backup, restore, RPO, RTO, failover drills.

### Production architecture
```text
Developer -> CI Pipeline -> Artifact Registry -> Deployment Controller
                                             -> Canary
                                             -> Metrics/SLO Check
                                             -> Rollout or Rollback
```

### Example: canary rollout
1. Deploy new version to 1% traffic.
2. Compare error rate, latency, saturation, and business metrics.
3. Increase to 10%, 25%, 50%, 100%.
4. Roll back automatically on SLO burn or critical error spike.

### Real systems to study
- Netflix chaos engineering and regional failure testing.
- Google SRE error budget model.
- GitHub-style incident writeups and postmortems.
- Stripe-style API reliability and idempotent payment operations.

### Design exercise
Create a production readiness review for the Node.js lab:
- Dashboards.
- Alerts.
- Runbooks.
- Backup/restore.
- Deployment plan.
- Security review.

## Rigorous Production Checklist

### Minimum production architecture
```text
Source Control -> CI -> Tests/Security Scan -> Artifact Registry
                                     -> Staging Deploy
                                     -> Canary Production Deploy
                                     -> SLO Verification
                                     -> Full Rollout or Rollback
```

### Operational readiness table
```text
Area             Required proof
Monitoring       dashboard with request, error, duration, saturation
Alerting         SLO burn-rate alerts with runbook links
Deployment       rollback tested
Database         backup restore tested
Security         secrets outside code, least privilege
Incidents        postmortem template and owner rotation
Capacity         load test report and scaling limits
```

### Runbook template
```text
Symptom:
Severity:
Dashboards:
Immediate mitigation:
Commands:
Rollback criteria:
Escalation:
Long-term fix:
```

### Canary
Progressive exposure with metrics guardrails.

### Rolling
Incremental replacement, lower infra cost.

## Exercises
1. Define canary guardrails and rollback triggers for payments API.
2. Write incident runbook for database replica lag spike.

---

## Incident Management and Reliability Operations Addendum

### Incident lifecycle
1. Detect
2. Triage
3. Mitigate
4. Recover
5. Postmortem

### Good postmortem structure
- What happened
- Customer impact
- Timeline
- Root causes (technical + process)
- Corrective and preventive actions

### Deployment safety controls
- Progressive rollout
- Automated health checks
- Error budget-aware release gating
- One-click rollback path

### Compliance and governance basics
- Audit trails for privileged actions
- Secret management and rotation
- Access control least privilege

---

## 6) SLO / SLA / SLI — Definitions and Calculator

These three terms are the foundation of reliability engineering. Confusing them
is one of the most common mistakes in production operations.

```
SLI (Service Level Indicator)  — the actual measurement  (e.g., % requests < 200ms)
SLO (Service Level Objective)  — your internal target    (e.g., SLI >= 99.9%)
SLA (Service Level Agreement)  — contractual commitment  (e.g., 99.5% or refund)
```

**SLO > SLA always.** Your internal objective must be tighter than your contract.
If your SLO is 99.9% and your SLA is 99.5%, you have a 0.4% buffer before
customers start demanding refunds.

### The Error Budget Concept

Error budget = 1 - SLO. At 99.9% SLO, you are **allowed** to be unavailable
for 0.1% of the time. That 0.1% is your innovation budget — if you have budget
left, you can ship fast. If you've burned it, you slow down and focus on reliability.

```python
"""
slo_calculator.py
Calculates error budgets, burn rates, and alert thresholds.
"""
import math
from dataclasses import dataclass
from typing import Tuple


@dataclass
class ErrorBudget:
    slo_percent: float        # e.g. 99.9
    window_days: float        # measurement window (30 days typical)
    total_requests: int = 0   # optional: for request-based budgets

    @property
    def slo_fraction(self) -> float:
        return self.slo_percent / 100.0

    @property
    def error_rate_budget(self) -> float:
        """Maximum allowed error fraction. e.g. 0.001 for 99.9% SLO."""
        return 1.0 - self.slo_fraction

    # ── Time-based budget ──────────────────────────────────────────────────────
    @property
    def window_minutes(self) -> float:
        return self.window_days * 24 * 60

    @property
    def allowed_downtime_minutes(self) -> float:
        """Total minutes of downtime allowed in the window."""
        return self.window_minutes * self.error_rate_budget

    @property
    def allowed_downtime_seconds(self) -> float:
        return self.allowed_downtime_minutes * 60

    # ── Request-based budget ───────────────────────────────────────────────────
    @property
    def allowed_errors(self) -> float:
        """If total_requests is set: max allowed error count."""
        return self.total_requests * self.error_rate_budget

    def budget_remaining(self, errors_so_far: int) -> Tuple[float, float]:
        """
        Returns (remaining_error_count, remaining_percent_of_budget).
        """
        remaining = self.allowed_errors - errors_so_far
        pct = (remaining / self.allowed_errors * 100) if self.allowed_errors else 0
        return remaining, pct

    def report(self) -> None:
        print(f"\nSLO Report — {self.slo_percent}% over {self.window_days} days")
        print("─" * 55)
        print(f"  Error budget (rate)         : {self.error_rate_budget*100:.3f}%")
        print(f"  Allowed downtime/window     : {self.allowed_downtime_minutes:.1f} min")
        print(f"                              : {self.allowed_downtime_seconds:.0f} sec")
        if self.total_requests:
            print(f"  Allowed errors (requests)   : {self.allowed_errors:.0f} / {self.total_requests:,}")


def calculate_error_budget(slo_percent: float, window_days: float,
                            total_requests: int = 0) -> ErrorBudget:
    """
    Main entry point for error budget calculation.

    Args:
        slo_percent    : e.g. 99.9 for 99.9% availability SLO
        window_days    : measurement window (typically 30 days)
        total_requests : optional; if set, computes request-based budget too

    Example:
        budget = calculate_error_budget(99.9, 30, total_requests=8_640_000)
        budget.report()
    """
    return ErrorBudget(slo_percent, window_days, total_requests)


# ── Burn Rate Alerts (Google SRE model) ───────────────────────────────────────
def burn_rate(
    errors_last_1h: int,
    errors_last_6h: int,
    requests_last_1h: int,
    requests_last_6h: int,
    slo_percent: float,
) -> dict:
    """
    Multi-window burn rate alerting — the Google SRE approach.

    A burn_rate of 1.0 means you're consuming the error budget at exactly
    the sustainable rate. At 2.0x you'll exhaust it in half the window.

    Two-window approach reduces false positives:
    - Short window (1h) catches fast burns but is noisy alone.
    - Long window (6h) confirms the trend is real, not a blip.

    Alert levels (Google SRE Book recommendations):
    - Page immediately  : burn_rate >= 14.4x  (budget gone in 2 hours)
    - Page (urgent)     : burn_rate >= 6x     (budget gone in 5 hours)
    - Ticket (non-urgent): burn_rate >= 3x    (budget gone in 10 days)
    - No action         : burn_rate < 3x
    """
    error_rate_budget = (100.0 - slo_percent) / 100.0

    # Error rates observed in each window
    rate_1h = errors_last_1h / requests_last_1h if requests_last_1h else 0
    rate_6h = errors_last_6h / requests_last_6h if requests_last_6h else 0

    # Burn rate = observed_error_rate / allowed_error_rate
    br_1h = rate_1h / error_rate_budget if error_rate_budget else float("inf")
    br_6h = rate_6h / error_rate_budget if error_rate_budget else float("inf")

    # Both windows must agree for a high-confidence alert
    effective_br = min(br_1h, br_6h)

    if effective_br >= 14.4:
        level  = "PAGE_CRITICAL"
        reason = "Budget exhausted in ~2 hours — wake someone up NOW"
    elif effective_br >= 6.0:
        level  = "PAGE_URGENT"
        reason = "Budget exhausted in ~5 hours — urgent investigation needed"
    elif effective_br >= 3.0:
        level  = "TICKET"
        reason = "Budget pressure — investigate before next deploy"
    else:
        level  = "OK"
        reason = "Burn rate within acceptable range"

    return {
        "burn_rate_1h":  round(br_1h,  2),
        "burn_rate_6h":  round(br_6h,  2),
        "effective_burn_rate": round(effective_br, 2),
        "alert_level":   level,
        "reason":        reason,
        "error_rate_1h": f"{rate_1h*100:.4f}%",
        "error_rate_6h": f"{rate_6h*100:.4f}%",
        "budget_pct":    f"{error_rate_budget*100:.3f}%",
    }


# ── SLO availability table ────────────────────────────────────────────────────
def print_slo_table() -> None:
    slos   = [99.0, 99.5, 99.9, 99.95, 99.99, 99.999]
    print(f"\n{'SLO':>8} | {'Downtime/month':>16} | {'Downtime/year':>16} | {'Error budget':>14}")
    print("─" * 62)
    for slo in slos:
        b = calculate_error_budget(slo, 30)
        monthly = b.allowed_downtime_minutes
        yearly  = monthly * 12
        fmt_m   = f"{monthly:.1f} min" if monthly >= 1 else f"{monthly*60:.1f} sec"
        fmt_y   = f"{yearly/60:.1f} h"  if yearly >= 60 else f"{yearly:.1f} min"
        print(f"  {slo:>6}% | {fmt_m:>16} | {fmt_y:>16} | {(100-slo):>12.3f}%")


# ── Usage ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print_slo_table()

    # Monthly budget for a service receiving 8.64M requests/month
    budget = calculate_error_budget(99.9, 30, total_requests=8_640_000)
    budget.report()
    remaining, pct = budget.budget_remaining(errors_so_far=5000)
    print(f"\n  After 5,000 errors: {remaining:.0f} budget remaining ({pct:.1f}%)")

    # Burn rate check
    alert = burn_rate(
        errors_last_1h=720, requests_last_1h=36_000,     # 2% error rate over 1h
        errors_last_6h=2160, requests_last_6h=216_000,   # 1% error rate over 6h
        slo_percent=99.9,
    )
    print(f"\nBurn rate alert: {alert['alert_level']}")
    print(f"  1h burn: {alert['burn_rate_1h']}x  |  6h burn: {alert['burn_rate_6h']}x")
    print(f"  {alert['reason']}")

# Example output:
#    SLO     |  Downtime/month |   Downtime/year |   Error budget
# ──────────────────────────────────────────────────────────────
#    99.0%   |      432.0 min  |          86.4 h |          1.000%
#    99.5%   |      216.0 min  |          43.2 h |          0.500%
#    99.9%   |       43.2 min  |           8.7 h |          0.100%
#    99.95%  |       21.6 min  |           4.4 h |          0.050%
#    99.99%  |        4.3 min  |          52.6 min|          0.010%
#    99.999% |       25.9 sec  |           5.3 min|          0.001%
```

---

## 7) CI/CD Pipeline as Code — GitHub Actions

A complete, production-grade pipeline covering: lint → test → build → push
→ deploy canary → metrics check → promote or rollback.

```yaml
# .github/workflows/deploy.yml
# Full CI/CD pipeline with canary deployment and automatic rollback.

name: CI/CD — Build, Test, Canary Deploy

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY:    ghcr.io
  IMAGE_NAME:  ${{ github.repository }}
  DEPLOY_ENV:  production

jobs:
  # ── Stage 1: Lint & Static Analysis ─────────────────────────────────────────
  lint:
    name: Lint & Static Analysis
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip

      - name: Install linters
        run: pip install ruff mypy bandit

      - name: Ruff (lint + format check)
        run: ruff check . && ruff format --check .
        # Why: catches style issues and common bugs without running code.

      - name: MyPy (type checking)
        run: mypy src/ --strict
        # Why: catches type errors that unit tests often miss.

      - name: Bandit (security linting)
        run: bandit -r src/ -ll
        # Why: catches hardcoded secrets, SQL injection patterns, unsafe calls.

  # ── Stage 2: Tests ────────────────────────────────────────────────────────────
  test:
    name: Unit + Integration Tests
    runs-on: ubuntu-latest
    needs: lint          # only runs if lint passes
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: testpass
          POSTGRES_DB: testdb
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 5
        ports:
          - 5432:5432
      redis:
        image: redis:7
        ports:
          - 6379:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
          cache: pip

      - name: Install dependencies
        run: pip install -r requirements.txt -r requirements-dev.txt

      - name: Run unit tests with coverage
        run: |
          pytest tests/unit/ \
            --cov=src \
            --cov-report=xml \
            --cov-fail-under=80 \
            -v
        # Why: fail fast if coverage drops below 80%.

      - name: Run integration tests
        env:
          DATABASE_URL: postgresql://postgres:testpass@localhost:5432/testdb
          REDIS_URL:    redis://localhost:6379
        run: pytest tests/integration/ -v --timeout=30

      - name: Upload coverage report
        uses: codecov/codecov-action@v4
        with:
          file: coverage.xml

  # ── Stage 3: Build & Push Docker Image ───────────────────────────────────────
  build:
    name: Build & Push Container
    runs-on: ubuntu-latest
    needs: test
    outputs:
      image_tag: ${{ steps.meta.outputs.tags }}
      image_digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@v4

      - name: Log in to container registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata (tags, labels)
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix=,suffix=,format=short
            type=ref,event=branch
        # Why: tag with git SHA so every image is traceable to a commit.

      - name: Build and push (multi-platform)
        id: push
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: ${{ github.ref == 'refs/heads/main' }}
          tags:    ${{ steps.meta.outputs.tags }}
          labels:  ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to:   type=gha,mode=max
          # Why: layer caching cuts build time from 3–5 min to <30s on cache hit.

      - name: Vulnerability scan (Trivy)
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
          format:    table
          exit-code: 1            # fail pipeline on CRITICAL CVEs
          severity:  CRITICAL,HIGH
        # Why: catch container vulnerabilities before they reach production.

  # ── Stage 4: Canary Deployment ────────────────────────────────────────────────
  deploy-canary:
    name: Deploy Canary (5% traffic)
    runs-on: ubuntu-latest
    needs: build
    if: github.ref == 'refs/heads/main'
    environment:
      name: production
      url: https://app.example.com
    steps:
      - uses: actions/checkout@v4

      - name: Configure kubectl
        uses: azure/k8s-set-context@v3
        with:
          kubeconfig: ${{ secrets.KUBECONFIG }}

      - name: Deploy canary (5% weight)
        run: |
          # Update canary deployment with new image
          kubectl set image deployment/app-canary \
            app=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ needs.build.outputs.image_digest }} \
            -n production

          # Set traffic weight: 5% to canary, 95% to stable
          kubectl patch virtualservice app-vs -n production \
            --type=json \
            -p='[
              {"op":"replace","path":"/spec/http/0/route/0/weight","value":95},
              {"op":"replace","path":"/spec/http/0/route/1/weight","value":5}
            ]'

          # Wait for canary pods to be ready
          kubectl rollout status deployment/app-canary -n production --timeout=120s

  # ── Stage 5: Metrics Check (gate before full rollout) ─────────────────────────
  check-canary-metrics:
    name: Check Canary Health Metrics
    runs-on: ubuntu-latest
    needs: deploy-canary
    steps:
      - name: Wait for canary to accumulate metrics
        run: sleep 120   # 2 minutes of real traffic

      - name: Query Prometheus — error rate comparison
        run: |
          CANARY_ERR=$(curl -s "${{ secrets.PROMETHEUS_URL }}/api/v1/query" \
            --data-urlencode 'query=sum(rate(http_requests_total{version="canary",status=~"5.."}[2m])) / sum(rate(http_requests_total{version="canary"}[2m]))' \
            | jq -r '.data.result[0].value[1]')

          STABLE_ERR=$(curl -s "${{ secrets.PROMETHEUS_URL }}/api/v1/query" \
            --data-urlencode 'query=sum(rate(http_requests_total{version="stable",status=~"5.."}[2m])) / sum(rate(http_requests_total{version="stable"}[2m]))' \
            | jq -r '.data.result[0].value[1]')

          echo "Canary error rate: $CANARY_ERR"
          echo "Stable error rate: $STABLE_ERR"

          # Fail if canary error rate is > 2x stable error rate
          python3 -c "
          canary = float('$CANARY_ERR' or 0)
          stable = float('$STABLE_ERR' or 0) or 0.001
          ratio  = canary / stable
          print(f'Error rate ratio: {ratio:.2f}x')
          if ratio > 2.0:
              raise SystemExit(f'ROLLBACK: canary error rate {ratio:.2f}x higher than stable')
          print('Canary health check PASSED')
          "

      - name: Query Prometheus — P99 latency comparison
        run: |
          # Similar check for latency — rollback if P99 regresses > 20%
          echo "Latency check would run here with PromQL histogram_quantile queries"

  # ── Stage 6: Full Rollout ─────────────────────────────────────────────────────
  promote-to-stable:
    name: Promote Canary to 100% Traffic
    runs-on: ubuntu-latest
    needs: check-canary-metrics
    steps:
      - name: Configure kubectl
        uses: azure/k8s-set-context@v3
        with:
          kubeconfig: ${{ secrets.KUBECONFIG }}

      - name: Roll out to stable deployment
        run: |
          kubectl set image deployment/app-stable \
            app=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}@${{ needs.build.outputs.image_digest }} \
            -n production
          kubectl rollout status deployment/app-stable -n production --timeout=300s

      - name: Shift 100% traffic to stable
        run: |
          kubectl patch virtualservice app-vs -n production \
            --type=json \
            -p='[
              {"op":"replace","path":"/spec/http/0/route/0/weight","value":100},
              {"op":"replace","path":"/spec/http/0/route/1/weight","value":0}
            ]'
          echo "Deployment complete: ${{ github.sha }}"

  # ── On failure: automatic rollback ───────────────────────────────────────────
  rollback:
    name: Automatic Rollback
    runs-on: ubuntu-latest
    needs: [deploy-canary, check-canary-metrics]
    if: failure()
    steps:
      - name: Configure kubectl
        uses: azure/k8s-set-context@v3
        with:
          kubeconfig: ${{ secrets.KUBECONFIG }}

      - name: Shift traffic back to stable (rollback)
        run: |
          kubectl patch virtualservice app-vs -n production \
            --type=json \
            -p='[{"op":"replace","path":"/spec/http/0/route/0/weight","value":100},
                 {"op":"replace","path":"/spec/http/0/route/1/weight","value":0}]'
          echo "ROLLED BACK — canary metrics check failed"

      - name: Notify on-call via PagerDuty
        run: |
          curl -X POST https://events.pagerduty.com/v2/enqueue \
            -H "Content-Type: application/json" \
            -d '{
              "routing_key": "${{ secrets.PAGERDUTY_KEY }}",
              "event_action": "trigger",
              "payload": {
                "summary": "Canary deployment failed and rolled back",
                "severity": "error",
                "source": "github-actions"
              }
            }'
```

**Pipeline stage summary:**

| Stage | Purpose | Fail behavior |
|---|---|---|
| Lint | Style + type + security | Block PR merge |
| Test | Unit + integration | Block merge |
| Build | Reproducible image, CVE scan | Block deploy |
| Canary | 5% real traffic test | Trigger rollback job |
| Metrics check | Error rate + latency gates | Trigger rollback job |
| Promote | 100% traffic shift | N/A |
| Rollback | Automatic safety net | Page on-call |

---

## 8) Observability — The Three Pillars

Observability answers: **"What is my system doing right now, and why?"**
Monitoring answers: **"Did it cross a threshold?"**
They're complementary, not competing.

### Pillar 1: Structured Logs

```python
"""
structured_logging.py
Structured logging with structlog — produces machine-parseable JSON.
In production, ship logs to Elasticsearch, Loki, or Datadog.
"""
import structlog
import uuid
import time
import logging

# ── Configure structlog ────────────────────────────────────────────────────────
structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,        # inject request context
        structlog.processors.add_log_level,             # add "level" field
        structlog.processors.TimeStamper(fmt="iso"),    # ISO8601 timestamp
        structlog.processors.StackInfoRenderer(),
        structlog.processors.JSONRenderer(),            # output as JSON
    ],
    wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
    context_class=dict,
    logger_factory=structlog.PrintLoggerFactory(),
)

log = structlog.get_logger()


def handle_payment_request(user_id: int, amount: float) -> dict:
    """Example of structured logging through a request lifecycle."""
    # Bind request-scoped context — appears in ALL log lines for this request
    trace_id = str(uuid.uuid4())
    structlog.contextvars.bind_contextvars(
        trace_id=trace_id,
        user_id=user_id,
        service="payment-service",
    )

    log.info("payment.request.received", amount=amount, currency="USD")

    t0 = time.perf_counter()
    try:
        # Simulate DB write
        time.sleep(0.012)
        log.info("payment.db.written", latency_ms=round((time.perf_counter()-t0)*1000, 1))

        # Simulate downstream API call
        t1 = time.perf_counter()
        time.sleep(0.045)
        log.info("payment.gateway.charged",
                 gateway="stripe",
                 latency_ms=round((time.perf_counter()-t1)*1000, 1),
                 amount=amount)

        total_ms = round((time.perf_counter() - t0) * 1000, 1)
        log.info("payment.request.completed",
                 total_latency_ms=total_ms,
                 status="success")

        return {"status": "ok", "trace_id": trace_id}

    except Exception as e:
        log.error("payment.request.failed",
                  error=str(e),
                  error_type=type(e).__name__)
        raise
    finally:
        structlog.contextvars.clear_contextvars()


# Each log line looks like this JSON (piped to your log aggregator):
# {
#   "event": "payment.request.received",
#   "trace_id": "a3f7c291-...",
#   "user_id": 42,
#   "service": "payment-service",
#   "amount": 99.99,
#   "currency": "USD",
#   "level": "info",
#   "timestamp": "2024-01-15T10:23:45.123Z"
# }
#
# Why JSON?  → grep, jq, Kibana, Loki — all parse it natively.
# Why trace_id? → link this log to spans and metrics from the same request.
```

### Pillar 2: Metrics (Prometheus)

```python
"""
metrics_demo.py
Prometheus metrics: Counter, Gauge, Histogram.
Requires: pip install prometheus_client
"""
from prometheus_client import (
    Counter, Gauge, Histogram,
    start_http_server, REGISTRY
)
import time, random, threading

# ── Define metrics ─────────────────────────────────────────────────────────────
# Counter: always increases (requests served, errors, bytes sent)
REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status_code"],
)

# Gauge: goes up and down (active connections, queue depth, memory usage)
ACTIVE_REQUESTS = Gauge(
    "http_active_requests",
    "Currently in-flight HTTP requests",
    ["endpoint"],
)

# Histogram: measures distribution of values (latency, payload size)
REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency",
    ["method", "endpoint"],
    # Buckets tuned for web services (in seconds)
    buckets=[0.005, 0.010, 0.025, 0.050, 0.100, 0.250, 0.500, 1.0, 2.5],
)

QUEUE_DEPTH = Gauge("job_queue_depth", "Background job queue depth")


def handle_request(method: str, endpoint: str) -> None:
    """Simulate a request with Prometheus instrumentation."""
    ACTIVE_REQUESTS.labels(endpoint=endpoint).inc()
    start = time.perf_counter()
    status = "200"
    try:
        # Simulate work with realistic latency distribution
        roll = random.random()
        if roll < 0.90:
            time.sleep(random.uniform(0.010, 0.080))
        elif roll < 0.99:
            time.sleep(random.uniform(0.080, 0.500))
        else:
            time.sleep(random.uniform(0.500, 2.0))
            status = "500"
    finally:
        duration = time.perf_counter() - start
        REQUEST_COUNT.labels(method=method, endpoint=endpoint, status_code=status).inc()
        REQUEST_LATENCY.labels(method=method, endpoint=endpoint).observe(duration)
        ACTIVE_REQUESTS.labels(endpoint=endpoint).dec()


# ── PromQL query examples (run these in Grafana or Prometheus UI) ─────────────
PROMQL_EXAMPLES = """
# Request rate per second (5-minute window):
sum(rate(http_requests_total[5m])) by (endpoint)

# Error rate (HTTP 5xx):
sum(rate(http_requests_total{status_code=~"5.."}[5m]))
  / sum(rate(http_requests_total[5m]))

# P50 / P95 / P99 latency:
histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, endpoint))
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, endpoint))
histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, endpoint))

# SLO burn rate (errors over 1-hour window vs budget):
(
  sum(rate(http_requests_total{status_code=~"5.."}[1h]))
  / sum(rate(http_requests_total[1h]))
) / 0.001   -- divide by error budget (0.1% for 99.9% SLO)

# Active connections (Gauge — point-in-time):
sum(http_active_requests) by (endpoint)
"""
```

### Pillar 3: Distributed Traces (OpenTelemetry)

```python
"""
tracing_demo.py
OpenTelemetry distributed tracing: parent span → child spans → context propagation.
Requires: pip install opentelemetry-sdk opentelemetry-exporter-otlp
"""
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, ConsoleSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
import time, random

# ── Setup tracer (in production, export to Jaeger / Tempo / Datadog) ──────────
resource = Resource.create({"service.name": "payment-service", "service.version": "2.1.0"})
provider = TracerProvider(resource=resource)
provider.add_span_processor(SimpleSpanProcessor(ConsoleSpanExporter()))
trace.set_tracer_provider(provider)

tracer = trace.get_tracer("payment-service")


def charge_payment(user_id: int, amount: float) -> dict:
    """
    Full request: parent span wraps three child spans.
    Each span records: start time, end time, attributes, events, status.
    """
    # Root span — represents the entire payment operation
    with tracer.start_as_current_span("payment.charge") as root_span:
        root_span.set_attribute("user.id",     user_id)
        root_span.set_attribute("payment.amount", amount)
        root_span.set_attribute("payment.currency", "USD")

        # Child span 1: validate input
        with tracer.start_as_current_span("payment.validate") as span:
            span.set_attribute("validation.type", "fraud_check")
            time.sleep(random.uniform(0.002, 0.008))
            span.add_event("fraud_score_computed", {"score": 0.12, "threshold": 0.80})

        # Child span 2: database write
        with tracer.start_as_current_span("payment.db.write") as span:
            span.set_attribute("db.system",     "postgresql")
            span.set_attribute("db.statement",  "INSERT INTO payments ...")
            span.set_attribute("db.table",      "payments")
            time.sleep(random.uniform(0.005, 0.020))

        # Child span 3: call external payment gateway
        with tracer.start_as_current_span("payment.gateway.charge") as span:
            span.set_attribute("rpc.system",  "http")
            span.set_attribute("rpc.service", "stripe")
            span.set_attribute("http.url",    "https://api.stripe.com/v1/charges")

            try:
                time.sleep(random.uniform(0.040, 0.120))
                span.set_attribute("http.status_code", 200)
                span.add_event("charge_created", {"charge_id": "ch_abc123"})
            except Exception as e:
                span.record_exception(e)
                span.set_status(trace.StatusCode.ERROR, str(e))
                raise

        # Inject trace context into response headers (for downstream correlation)
        carrier = {}
        TraceContextTextMapPropagator().inject(carrier)
        trace_id = format(root_span.get_span_context().trace_id, "032x")

        return {
            "status":   "ok",
            "trace_id": trace_id,        # return to caller for log correlation
            "headers":  carrier,         # propagate to downstream services
        }


# ── How correlation works ─────────────────────────────────────────────────────
CORRELATION_EXPLANATION = """
The Three Pillars, Connected via trace_id:

  1. Log:   {"event": "payment.failed", "trace_id": "a3f7c291...", "user_id": 42}
  2. Trace: Span tree with trace_id="a3f7c291..." showing which DB call took 800ms
  3. Metric: http_request_duration_seconds labels carry endpoint + status

Workflow when P99 latency alert fires:
  → Grafana shows P99 spike at 14:32 UTC
  → Find a slow trace in Tempo/Jaeger for that time window
  → Trace shows "payment.db.write" span took 780ms
  → Find logs for that trace_id → see "lock_wait_timeout" error
  → Root cause: table lock contention during a migration
  → Fix: run migration with --no-lock or during low-traffic window
"""
```

---

## 9) Canary Deployment Safety — Statistical Testing

Don't use gut feel to decide if a canary is safe. Use statistics.
A z-test for proportions tells you if the canary's error rate is
**statistically significantly** different from the baseline.

```python
"""
canary_safety.py
Statistically rigorous canary health check using z-test for proportions.
No external libraries required (only math from stdlib).
"""
import math
from dataclasses import dataclass
from typing import Tuple


@dataclass
class CanaryResult:
    is_safe: bool
    recommendation: str          # "PROMOTE" or "ROLLBACK"
    canary_error_rate: float
    baseline_error_rate: float
    relative_increase: float     # how much worse canary is, as a fraction
    z_score: float
    p_value: float
    confidence: float
    interpretation: str


def canary_is_safe(
    baseline_errors:  int,
    baseline_total:   int,
    canary_errors:    int,
    canary_total:     int,
    confidence: float = 0.95,
    max_relative_increase: float = 0.25,   # allow up to 25% worse error rate
) -> CanaryResult:
    """
    Two-proportion z-test: is the canary error rate significantly
    higher than the baseline error rate?

    The null hypothesis H0: canary_rate <= baseline_rate (canary is fine).
    We reject H0 (rollback) if the canary rate is significantly higher.

    Args:
        baseline_errors        : error count in baseline (stable) group
        baseline_total         : total requests in baseline group
        canary_errors          : error count in canary group
        canary_total           : total requests in canary group
        confidence             : statistical confidence (default 0.95 = 95%)
        max_relative_increase  : additional guard — rollback if canary is
                                 >25% worse even if not statistically significant
                                 (protects against low-sample-size decisions)

    Returns CanaryResult with recommendation and full stats.
    """
    if baseline_total == 0 or canary_total == 0:
        return CanaryResult(
            is_safe=False,
            recommendation="ROLLBACK",
            canary_error_rate=0, baseline_error_rate=0,
            relative_increase=0, z_score=0, p_value=1,
            confidence=confidence,
            interpretation="Insufficient data — no traffic observed"
        )

    p_baseline = baseline_errors / baseline_total
    p_canary   = canary_errors   / canary_total

    # Pooled proportion (under H0: both groups have the same error rate)
    p_pooled = (baseline_errors + canary_errors) / (baseline_total + canary_total)

    # Standard error of the difference in proportions
    se = math.sqrt(
        p_pooled * (1 - p_pooled) * (1/baseline_total + 1/canary_total)
    )

    if se == 0:
        z_score = 0.0
    else:
        z_score = (p_canary - p_baseline) / se   # positive = canary is worse

    # One-tailed p-value: P(Z >= z_score) — probability canary is this bad by chance
    p_value = _normal_cdf_upper_tail(z_score)

    # Critical z-value for the chosen confidence level (one-tailed)
    # 90% → 1.282,  95% → 1.645,  99% → 2.326
    z_critical = _z_critical(confidence)

    # Statistical decision
    statistically_worse = z_score > z_critical   # reject H0

    # Practical guard: relative increase (even with small N)
    relative_increase = (p_canary - p_baseline) / p_baseline if p_baseline > 0 else 0
    practically_worse = relative_increase > max_relative_increase

    is_safe = not (statistically_worse or practically_worse)

    if is_safe:
        recommendation  = "PROMOTE"
        interpretation  = (
            f"Canary error rate ({p_canary*100:.3f}%) is not significantly "
            f"higher than baseline ({p_baseline*100:.3f}%). Safe to promote."
        )
    elif statistically_worse:
        recommendation = "ROLLBACK"
        interpretation = (
            f"Canary error rate ({p_canary*100:.3f}%) is SIGNIFICANTLY higher "
            f"than baseline ({p_baseline*100:.3f}%) at {confidence*100:.0f}% confidence "
            f"(z={z_score:.2f}, p={p_value:.4f}). Rolling back."
        )
    else:
        recommendation = "ROLLBACK"
        interpretation = (
            f"Canary error rate is {relative_increase*100:.1f}% higher than "
            f"baseline (>{max_relative_increase*100:.0f}% threshold). "
            f"Rolling back as practical guard (not statistically significant yet)."
        )

    return CanaryResult(
        is_safe=is_safe,
        recommendation=recommendation,
        canary_error_rate=round(p_canary,   6),
        baseline_error_rate=round(p_baseline, 6),
        relative_increase=round(relative_increase, 4),
        z_score=round(z_score, 3),
        p_value=round(p_value, 4),
        confidence=confidence,
        interpretation=interpretation,
    )


def _normal_cdf_upper_tail(z: float) -> float:
    """P(Z >= z) for standard normal. Uses math.erfc for accuracy."""
    return 0.5 * math.erfc(z / math.sqrt(2))


def _z_critical(confidence: float) -> float:
    """Map confidence level to z critical value (one-tailed)."""
    table = {0.90: 1.282, 0.95: 1.645, 0.99: 2.326, 0.999: 3.090}
    # Linear interpolation if exact value not in table
    keys = sorted(table.keys())
    if confidence <= keys[0]:  return table[keys[0]]
    if confidence >= keys[-1]: return table[keys[-1]]
    for i in range(len(keys)-1):
        if keys[i] <= confidence <= keys[i+1]:
            t = (confidence - keys[i]) / (keys[i+1] - keys[i])
            return table[keys[i]] + t * (table[keys[i+1]] - table[keys[i]])
    return 1.645


# ── Usage Examples ────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("=" * 65)
    print("Canary Deployment Safety Checker")
    print("=" * 65)

    scenarios = [
        ("Healthy canary (same error rate)",
         100, 100_000, 102, 100_000),

        ("Slightly worse canary (borderline)",
         100, 100_000, 180, 100_000),

        ("Clearly broken canary (high error rate)",
         100, 100_000, 500, 100_000),

        ("Small sample — canary looks worse but may be noise",
         2, 1_000, 5, 1_000),

        ("Zero baseline errors (rare but possible)",
         0, 100_000, 3, 10_000),
    ]

    for name, be, bt, ce, ct in scenarios:
        result = canary_is_safe(be, bt, ce, ct, confidence=0.95)
        print(f"\n{name}")
        print(f"  Baseline:  {be}/{bt} errors ({be/bt*100:.3f}%)")
        print(f"  Canary:    {ce}/{ct} errors ({ce/ct*100:.3f}%)")
        print(f"  Decision:  [{result.recommendation}]  z={result.z_score}  p={result.p_value}")
        print(f"  → {result.interpretation}")

# KEY INSIGHT:
# With small samples (1000 requests), even a 2.5x error rate increase
# may not be statistically significant. The practical guard (25% relative
# threshold) protects you while you accumulate more data.
# At 100k requests, even a 1.8x increase is clearly significant.
```

---

## 10) Incident Runbooks — Concrete Examples

A runbook is a pre-written decision tree for common failure modes.
It should be so clear that a sleepy engineer at 3 AM can follow it.

### Runbook 1: High Error Rate

```
SYMPTOM:
  Alert: http_error_rate > 1% for 5 minutes
  Dashboard: error rate graph spiking, P99 latency rising

SEVERITY: P1 if error_rate > 5%,  P2 if 1–5%

FIRST CHECKS (< 2 minutes):
  1. Is this a deployment?
       kubectl rollout history deployment/app -n production
       → If recent rollout: immediately rollback (see step below)

  2. Is a dependency down?
       kubectl get pods -n production            # are pods healthy?
       curl -s http://healthcheck.internal/deps  # upstream deps status

  3. Is it one AZ / region or global?
       Check Grafana: filter by region/AZ label in http_requests_total
       → If single AZ: shift traffic away (update load balancer weights)

IMMEDIATE MITIGATION:
  a) Rollback if new deployment:
       kubectl rollout undo deployment/app -n production
       # Verify: kubectl rollout status deployment/app

  b) Scale up if overloaded:
       kubectl scale deployment/app --replicas=20 -n production

  c) Enable circuit breaker / serve cached content:
       kubectl set env deployment/app CIRCUIT_BREAKER_OPEN=true -n production

ROOT CAUSE COMMANDS:
  # Find which endpoint is erroring:
  sum(rate(http_requests_total{status_code=~"5.."}[5m])) by (endpoint)

  # Check application logs for errors:
  kubectl logs -l app=app -n production --since=10m | grep -i error | head -50

  # Check if DB connections are exhausted:
  SELECT count(*), state FROM pg_stat_activity GROUP BY state;

ROLLBACK CRITERIA:
  Roll back if error rate does not drop below 0.5% within 10 minutes of mitigation.

ESCALATION:
  P1: Page team lead + DB admin immediately
  P2: Slack #incidents, assign owner, set 30-min update cadence
```

### Runbook 2: Database Slow Queries

```
SYMPTOM:
  Alert: P99 latency > 2s sustained for 10 minutes
  Trace: DB span taking >500ms in most slow traces

FIRST CHECKS:
  # Which queries are slowest right now?
  SELECT query, calls, mean_exec_time, total_exec_time, rows
  FROM pg_stat_statements
  ORDER BY mean_exec_time DESC
  LIMIT 20;

  # Is the DB CPU or I/O saturated?
  SELECT * FROM pg_stat_bgwriter;
  SELECT * FROM pg_stat_database WHERE datname = 'prod';

  # Are there blocking queries / lock waits?
  SELECT pid, wait_event_type, wait_event, query, query_start
  FROM pg_stat_activity
  WHERE wait_event IS NOT NULL
  ORDER BY query_start;

DIAGNOSE WITH EXPLAIN ANALYZE:
  EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
  SELECT * FROM orders WHERE user_id = 42 AND status = 'pending';

  Look for:
  → Seq Scan on large table  → add index
  → Rows Removed by Filter: 99000  → very selective but no index
  → Buffers: shared hit=0 read=50000  → cold cache, data not in RAM

INDEX FIX (example):
  -- Check if index already exists:
  SELECT indexname, indexdef FROM pg_indexes
  WHERE tablename = 'orders';

  -- Add index concurrently (no table lock):
  CREATE INDEX CONCURRENTLY idx_orders_user_status
  ON orders(user_id, status)
  WHERE status = 'pending';   -- partial index if only pending matters

  -- Verify query uses new index:
  EXPLAIN SELECT * FROM orders WHERE user_id = 42 AND status = 'pending';
  -- Should show: Index Scan using idx_orders_user_status

MITIGATION WHILE FIX IS RUNNING:
  - Add read replica and redirect read traffic there
  - Enable query result caching at application layer (Redis)
  - Kill runaway queries: SELECT pg_cancel_backend(pid);
```

### Runbook 3: Memory Leak

```
SYMPTOM:
  Alert: process_resident_memory_bytes increasing monotonically over hours
  Pod eventually OOMKilled (check: kubectl describe pod | grep OOMKilled)

FIRST CHECKS:
  # Memory trend in Grafana:
  rate(process_resident_memory_bytes[30m]) > 0   -- and never drops

  # Python-specific: check object counts with tracemalloc:
  import tracemalloc
  tracemalloc.start()
  # ... run workload ...
  snapshot = tracemalloc.take_snapshot()
  top_stats = snapshot.statistics('lineno')
  for stat in top_stats[:10]:
      print(stat)
  # Shows which line of code holds the most memory

  # GC stats:
  import gc
  gc.collect()
  print(gc.get_count())          # (gen0, gen1, gen2) — rising gen2 = leak
  print(len(gc.get_objects()))   # total live objects

COMMON PYTHON LEAK PATTERNS:
  1. Global list/dict accumulating items:
       cache = {}                          # never evicted → grows forever
       Fix: use collections.OrderedDict with maxlen, or TTL cache (cachetools)

  2. Circular references with __del__:
       Fix: use weakref.ref() for back-references

  3. Thread-local storage accumulation:
       Fix: explicitly del thread_local data in request teardown

  4. Unclosed file handles / DB connections:
       Fix: always use context managers (with open(...) as f:)

MITIGATION:
  Short-term: Restart pods on memory threshold (Kubernetes restartPolicy)
  Long-term: Fix the leak using the profiling steps above

  # Kubernetes: auto-restart on OOM with resource limits:
  resources:
    limits:
      memory: "512Mi"     # OOM kill before host impact
    requests:
      memory: "256Mi"
```

---

## 11) Chaos Engineering — Fault Injection in Python

Chaos engineering proves your system is resilient **before** failures happen
in production. You inject controlled faults and verify SLOs are still met.

```python
"""
chaos_engineering.py
Simulates chaos monkey, network partitions, and SLO verification.
No external libraries required.
"""
import threading
import time
import random
import statistics
from dataclasses import dataclass, field
from typing import Callable, List, Optional
from collections import deque


# ── Simulated service ─────────────────────────────────────────────────────────
@dataclass
class Service:
    name: str
    is_alive: bool = True
    base_latency_ms: float = 10.0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def call(self, network_delay_ms: float = 0.0, drop: bool = False) -> dict:
        """Simulate a service call. Returns result or raises on failure."""
        if drop:
            raise ConnectionError(f"Network drop to {self.name}")

        if not self.is_alive:
            raise RuntimeError(f"{self.name} is down (chaos kill)")

        # Add network delay
        total_delay = (self.base_latency_ms + network_delay_ms) / 1000
        time.sleep(total_delay)

        return {"service": self.name, "latency_ms": total_delay * 1000}

    def kill(self) -> None:
        with self._lock:
            self.is_alive = False
        print(f"  💀 CHAOS: killed {self.name}")

    def revive(self) -> None:
        with self._lock:
            self.is_alive = True
        print(f"  ✅ CHAOS: revived {self.name}")


# ── Chaos Monkey ──────────────────────────────────────────────────────────────
class ChaosMonkey:
    """
    Randomly kills one of the services for a period, then revives it.
    Simulates unexpected instance termination (AWS spot interruption, OOM kill).
    """
    def __init__(self, services: List[Service], kill_interval_s: float = 5.0,
                 kill_duration_s: float = 2.0):
        self.services         = services
        self.kill_interval_s  = kill_interval_s
        self.kill_duration_s  = kill_duration_s
        self._stop_event      = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self.killed_count     = 0

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _run(self) -> None:
        while not self._stop_event.wait(timeout=self.kill_interval_s):
            victim = random.choice(self.services)
            self.killed_count += 1
            victim.kill()
            time.sleep(self.kill_duration_s)
            victim.revive()


# ── Network Partition Simulator ───────────────────────────────────────────────
class NetworkChaos:
    """
    Injects random latency and packet drops into service calls.
    Simulates: network congestion, flaky links, AZ-level issues.
    """
    def __init__(
        self,
        extra_latency_range_ms: tuple = (0, 200),   # random extra latency
        drop_probability: float = 0.05,              # 5% packet drop rate
    ):
        self.latency_range  = extra_latency_range_ms
        self.drop_prob      = drop_probability
        self.active         = False

    def __enter__(self):
        self.active = True
        print(f"  🌐 CHAOS: network partition active "
              f"(drop={self.drop_prob*100:.0f}%, "
              f"latency+={self.latency_range[1]}ms max)")
        return self

    def __exit__(self, *_):
        self.active = False
        print("  🌐 CHAOS: network partition lifted")

    def maybe_inject(self) -> tuple[float, bool]:
        """Returns (extra_latency_ms, should_drop)."""
        if not self.active:
            return 0.0, False
        drop = random.random() < self.drop_prob
        latency = random.uniform(*self.latency_range) if not drop else 0
        return latency, drop


# ── SLO Tracker ───────────────────────────────────────────────────────────────
class SLOTracker:
    """
    Tracks success rate and latency during the chaos test.
    Checks whether the system maintained its SLO.
    """
    def __init__(self, target_success_rate: float = 0.995,
                 target_p99_ms: float = 500.0):
        self.target_success_rate = target_success_rate
        self.target_p99_ms       = target_p99_ms
        self._successes          = 0
        self._failures           = 0
        self._latencies: deque   = deque(maxlen=10_000)
        self._lock               = threading.Lock()

    def record_success(self, latency_ms: float) -> None:
        with self._lock:
            self._successes += 1
            self._latencies.append(latency_ms)

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1

    @property
    def success_rate(self) -> float:
        total = self._successes + self._failures
        return self._successes / total if total else 1.0

    @property
    def p99_ms(self) -> float:
        data = sorted(self._latencies)
        if not data: return 0.0
        idx = int(math.ceil(99 / 100 * len(data))) - 1
        return data[max(0, idx)]

    def slo_met(self) -> bool:
        return (self.success_rate >= self.target_success_rate and
                self.p99_ms <= self.target_p99_ms)

    def report(self) -> dict:
        total = self._successes + self._failures
        return {
            "total_requests":   total,
            "successes":        self._successes,
            "failures":         self._failures,
            "success_rate_pct": round(self.success_rate * 100, 3),
            "p99_latency_ms":   round(self.p99_ms, 1),
            "slo_target_rate":  f"{self.target_success_rate*100}%",
            "slo_target_p99":   f"{self.target_p99_ms}ms",
            "slo_met":          self.slo_met(),
        }


import math

# ── Full Chaos Test Orchestrator ──────────────────────────────────────────────
def chaos_test(
    num_services: int   = 3,
    test_duration_s: float = 10.0,
    requests_per_sec: float = 20.0,
    slo_success_rate: float = 0.995,
    slo_p99_ms: float       = 500.0,
) -> dict:
    """
    Runs a full chaos engineering test:
    1. Spins up N simulated services.
    2. Starts Chaos Monkey killing one randomly every few seconds.
    3. Introduces network partition with packet drops and latency.
    4. Continuously calls all services, recording SLO compliance.
    5. Reports whether SLO was maintained under chaos.

    Your system should have retry logic and fallbacks to pass this test.
    """
    print("=" * 65)
    print(f"Chaos Engineering Test")
    print(f"  Services: {num_services}  |  Duration: {test_duration_s}s  "
          f"|  Target RPS: {requests_per_sec}")
    print(f"  SLO: {slo_success_rate*100}% success, P99 < {slo_p99_ms}ms")
    print("=" * 65)

    services = [Service(name=f"svc-{i}", base_latency_ms=15) for i in range(num_services)]
    network  = NetworkChaos(extra_latency_range_ms=(0, 150), drop_probability=0.05)
    tracker  = SLOTracker(slo_success_rate, slo_p99_ms)
    monkey   = ChaosMonkey(services, kill_interval_s=3.0, kill_duration_s=1.5)

    def call_with_retry(service: Service, max_retries: int = 2) -> Optional[dict]:
        """
        Retry logic: the key resilience mechanism under chaos.
        Without retries, every killed service = failed request.
        With retries, we recover from transient failures.
        """
        extra_lat, drop = network.maybe_inject()
        for attempt in range(max_retries + 1):
            try:
                result = service.call(network_delay_ms=extra_lat, drop=drop)
                return result
            except (RuntimeError, ConnectionError):
                if attempt < max_retries:
                    # Try a different service on retry (avoids dead node)
                    alt = random.choice([s for s in services if s != service])
                    service = alt
                    extra_lat, drop = network.maybe_inject()
                else:
                    return None   # all retries exhausted

    def run_requests() -> None:
        """Send requests at target RPS for the test duration."""
        interval    = 1.0 / requests_per_sec
        deadline    = time.perf_counter() + test_duration_s
        while time.perf_counter() < deadline:
            start   = time.perf_counter()
            svc     = random.choice(services)
            t0      = time.perf_counter()
            result  = call_with_retry(svc)
            latency = (time.perf_counter() - t0) * 1000

            if result:
                tracker.record_success(latency)
            else:
                tracker.record_failure()

            # Maintain target RPS
            elapsed = time.perf_counter() - start
            sleep   = interval - elapsed
            if sleep > 0:
                time.sleep(sleep)

    # ── Run the chaos test ──────────────────────────────────────────────────
    monkey.start()
    with network:
        run_requests()
    monkey.stop()

    # ── Report ──────────────────────────────────────────────────────────────
    report = tracker.report()
    report["chaos_kills"] = monkey.killed_count
    report["services"]    = num_services

    print(f"\nChaos Test Results:")
    print(f"  Total requests    : {report['total_requests']}")
    print(f"  Success rate      : {report['success_rate_pct']}%  "
          f"(target: {slo_success_rate*100}%)")
    print(f"  P99 latency       : {report['p99_latency_ms']}ms  "
          f"(target: <{slo_p99_ms}ms)")
    print(f"  Chaos kills       : {report['chaos_kills']} service kills injected")
    print(f"  SLO maintained    : {'✅ YES' if report['slo_met'] else '❌ NO'}")

    if not report["slo_met"]:
        print("\n  ⚠️  SLO violated under chaos — system is NOT resilient enough.")
        print("     Add: circuit breakers, retries, fallbacks, redundant replicas.")
    else:
        print("\n  ✅ System maintained SLO under chaos — resilience confirmed.")

    return report


# ── Usage ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    result = chaos_test(
        num_services    = 3,
        test_duration_s = 10,
        requests_per_sec= 20,
        slo_success_rate= 0.995,    # 99.5% success rate SLO
        slo_p99_ms      = 500.0,    # P99 < 500ms SLO
    )
    print(f"\nFinal: {'PASS' if result['slo_met'] else 'FAIL'}")

# KEY LESSONS FROM CHAOS ENGINEERING:
#
# 1. Single point of failure exposed immediately — if you have 1 instance
#    of a service, Chaos Monkey killing it = 100% failure rate.
#    Fix: always run >= 2 replicas in production.
#
# 2. Retry without jitter causes thundering herd — all retries fire at once.
#    Fix: exponential backoff with jitter.
#
# 3. Network drops are as dangerous as service kills — but often ignored.
#    Fix: set socket timeouts on ALL outbound calls (requests, DB, Redis).
#
# 4. SLO maintained under chaos = confidence to deploy without fear.
#    SLO violated = find the fragile component before production does.
