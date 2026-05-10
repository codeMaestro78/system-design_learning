# Part 6: Hands-On Projects (Mandatory Build Track)

## Build Order
1. `08a-Mini-Redis.md`
2. `08b-URL-Shortener-with-Analytics.md`
3. `08c-Rate-Limiter.md`
4. `08d-Distributed-Task-Queue.md`
5. `08e-Log-Aggregation-System.md`
6. `08f-Real-Time-Chat-System.md`
7. `08g-Scalable-Notification-System.md`

## Standard Project Template (Apply to every project)
1. Problem statement and scope
2. Requirements and API contract
3. Data model and storage decision
4. Local single-node implementation
5. Testing (unit, integration, load)
6. Metrics and observability
7. Reliability (retries, idempotency, DLQ)
8. Horizontal scaling
9. Security hardening
10. Production runbook

## Definition of Done per project
- Runs locally with clear setup
- Has load test and baseline numbers
- Has failure injection scenarios
- Has documented scaling path

---

## Engineering Standards for Every Build

### API standards
- Explicit error codes
- Idempotency support for unsafe writes
- Request/response validation

### Testing standards
1. Unit tests for core logic
2. Integration tests with real dependencies
3. Load test with baseline report
4. Failure test (dependency timeout/crash)

### Observability standards
- Structured logs
- RED metrics
- Basic distributed tracing

### Delivery standards
- Containerized local run
- One-command startup
- Reproducible config with env templates

### Retrospective template per project
1. What bottleneck appeared first?
2. What metric detected it?
3. What fix worked?
4. What tradeoff did that fix introduce?

## Sophisticated Project Roadmap

Each project should be built in maturity levels.

### Level 1: Functional prototype
- In-memory state.
- Simple API.
- Basic validation.
- Happy-path tests.

### Level 2: Production behavior
- Persistence.
- Idempotency.
- Retries with backoff.
- Metrics and structured logs.
- Error handling and input validation.

### Level 3: Scale behavior
- Cache or queue where appropriate.
- Partitioning/sharding strategy.
- Load testing.
- Backpressure.
- Hot key or burst handling.

### Level 4: Operations
- Health checks.
- Dashboards.
- Runbooks.
- Deployment plan.
- Failure injection.
- Security review.

### Level 5: Design review
For each project, write:
- Architecture diagram.
- API contract.
- Data model.
- Critical flows.
- Failure modes.
- Real-world equivalent system.
- What you would change at 10x and 100x traffic.

## Rigorous Project Acceptance Criteria

Every project must include:

```text
README architecture       required
API examples              required
Input validation          required
Error contract            required
Unit tests                required
Integration tests         required for HTTP projects
Metrics                   required
Structured logs           required
Failure test              required
Load test note            required
Security note             required
```

### Implementation architecture standard
```text
API Layer
  -> Validation
  -> Service Layer
  -> Repository/Store Interface
  -> Async Worker/Queue Interface
  -> Metrics and Logs
```

### Code review checklist
- Business logic is not buried in request parsing.
- Storage access is isolated behind clear functions/classes.
- Idempotency is tested for unsafe writes.
- Retries have maximum attempts.
- Logs include operation identity but not secrets.
- Errors are actionable and consistent.
