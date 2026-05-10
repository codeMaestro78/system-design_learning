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
