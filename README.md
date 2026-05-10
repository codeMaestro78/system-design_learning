# Learning System Design (Comprehensive Curriculum)

This folder now contains a **deep, production-grade learning path** from beginner fundamentals to advanced distributed systems and interview-ready reasoning.

## Course Structure
- `00-Start-Here.md`
- `01-Foundations.md`
- `02-Networking-Basics.md`
- `03-Data-and-Storage.md`
- `04-Core-Components.md`
- `05-Architecture-Patterns.md`
- `06-Scaling-Systems.md`
- `07-Real-World-System-Designs.md` + `07a` to `07i`
- `08-Hands-On-Projects.md` + `08a` to `08g`
- `09-Advanced-Distributed-Topics.md`
- `10-Performance-Engineering.md`
- `11-Production-DevOps.md`
- `12-Interview-and-Senior-Thinking.md`
- `13-Execution-Plan.md`
- `14-Timed-Mock-Interviews-Playbook.md`
- `15-Deliberate-Drills-System-Design.md`
- `16-Build-Scale-Iteration-Lab-Guide.md`
- `17-Communication-Training-System-Design.md`
- `18-Comprehensive-System-Design-Guide.md`

## Strict Learning Method (Use for every topic)
1. Intuition
2. Problem
3. Naive approach and limits
4. Optimized evolution
5. Deep internals
6. Tradeoffs
7. Real-world systems
8. Code/pseudo-code
9. Diagram
10. Interview explanation

## How to Study
1. Read one section deeply.
2. Write your own summary.
3. Answer self-check questions.
4. Do the exercise.
5. Explain tradeoffs aloud like a design review.

## Goal
By the end, you should be able to design, build, and operate distributed systems with senior-level reasoning.

## Deep Study Expectations
- Don’t memorize diagrams. Derive them from requirements each time.
- For every design choice, write what you rejected and why.
- Treat every topic as production engineering, not interview theater.

## Suggested Tooling for Practice
- API load testing: k6/Locust
- Profiling: pprof/flamegraph
- Metrics dashboards: Prometheus + Grafana
- Tracing: OpenTelemetry + Jaeger
- Failure simulation: toxiproxy/chaos tooling

## How to turn this curriculum into mastery
1. Read one section deeply.
2. Implement a minimal version.
3. Break it intentionally.
4. Fix using principled tradeoffs.
5. Explain decisions in writing.

## Sophisticated Roadmap Overview

This roadmap is organized like a real senior engineering growth plan, not a list of interview prompts.

### Level 1: Fundamentals
- Networking: DNS, TCP, TLS, HTTP, gRPC, WebSockets, QUIC.
- Data: SQL, NoSQL, indexing, transactions, replication, sharding.
- Distributed basics: latency, availability, durability, consistency, failure.

### Level 2: Backend Building Blocks
- Caches, queues, load balancers, API gateways, rate limiters.
- Search, object storage, stream processing, background workers.
- Observability, deployments, runbooks, incident response.

### Level 3: Architecture Patterns
- Modular monoliths, microservices, event-driven architecture.
- CQRS, saga, transactional outbox, CDC, materialized views.
- Multi-region architecture, active-active, active-passive, disaster recovery.

### Level 4: Real Systems
- Social feed: Twitter/X, Instagram.
- Messaging: WhatsApp, Slack-style channels.
- Media: YouTube, Netflix.
- Marketplace/location: Uber.
- Infrastructure: URL shortener, distributed cache, search engine, task queue.

### Level 5: Production Mastery
- Capacity planning and cost modeling.
- Tail latency and performance profiling.
- Failure injection and chaos testing.
- Security, abuse control, privacy, compliance.
- Design review communication and executive-level tradeoff explanation.

## Real-World Architecture Lens

For every system, answer these questions:

1. What is the primary user-facing promise?
2. What data must never be lost?
3. What can be eventually consistent?
4. What breaks first at 10x scale?
5. What is the cheapest safe first version?
6. What would a real company change after product-market fit?
7. What metrics prove the design works?

## Capstone Outcomes

By the end of this folder, you should be able to produce:

- A complete design doc with requirements, scale, APIs, schema, architecture, failure plan, and tradeoffs.
- A working Node.js implementation of core system design patterns.
- A production-readiness checklist for every design.
- A 45-minute interview answer that sounds structured, quantified, and senior.

## Rigorous Quality Bar

Every design in this roadmap must now pass this bar before it is considered complete.

### Mandatory artifacts
- Requirements with explicit exclusions.
- Capacity estimate with assumptions.
- API contract with request/response/error examples.
- Data model with indexes, partition keys, and retention policy.
- Architecture diagram for MVP and scaled version.
- Critical read/write flow.
- Consistency contract per feature.
- Failure-mode table.
- Observability plan.
- Security and abuse plan.
- Cost and scaling triggers.

### Architecture review questions
1. What is the hot path, and what work is intentionally kept out of it?
2. What data must be strongly consistent?
3. Which operations are idempotent?
4. What happens when cache, database, queue, or a third-party dependency is down?
5. How do you detect degradation before users complain?
6. What is the first bottleneck at 10x traffic?
7. What would you remove if the system needed to be simpler?

### Standard production diagram
Use this as the baseline shape and specialize it per system:

```text
Clients
  -> CDN/WAF
  -> Load Balancer
  -> API Gateway
  -> Stateless Services
    -> Cache
    -> Primary Database
    -> Queue/Event Stream
    -> Search/Object Store/External APIs
  -> Observability: Logs + Metrics + Traces
  -> Operations: CI/CD + Config + Secrets + Runbooks
```
