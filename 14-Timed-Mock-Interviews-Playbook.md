# Timed Mock Interviews Playbook (45–60 Minutes Weekly)

## Goal
Turn system design knowledge into interview performance under time pressure.

## Interview Simulation Formats

## 45-minute format (most common)
1. 5 min: clarify requirements + constraints
2. 5 min: estimate scale
3. 15 min: high-level design
4. 10 min: deep dive (data model, critical path)
5. 10 min: bottlenecks, tradeoffs, failure handling

## 60-minute format (senior-heavy)
1. 8 min: requirements and assumptions
2. 7 min: scale and SLOs
3. 20 min: HLD + API + data model
4. 15 min: deep dives (consistency, caching, queues)
5. 10 min: resilience, evolution plan, cost

---

## Weekly Mock Plan

1. Week A: Social (Twitter/Instagram)
2. Week B: Communication (WhatsApp/Slack)
3. Week C: Media (YouTube/Netflix)
4. Week D: Infra (URL shortener/cache/queue/search)

Repeat cycle with increasing depth.

---

## Pre-Mock Checklist (5 minutes before start)
1. Pick one prompt.
2. Set timer.
3. Open blank page only.
4. Define success criteria:
   - clear structure
   - realistic scale
   - explicit tradeoffs
   - failure plan

---

## During Mock: Golden Script
Use this exact structure aloud:

1. "Let me confirm requirements and constraints."
2. "I’ll estimate rough scale before architecture."
3. "I’ll present baseline design, then deep dive critical path."
4. "Then I’ll cover bottlenecks, tradeoffs, and failures."

---

## Scoring Rubric (0–5 each)
1. Requirements clarity
2. Estimation realism
3. Architecture completeness
4. Data model/API quality
5. Consistency reasoning
6. Failure handling
7. Tradeoff communication
8. Senior-level prioritization

**Target:** average >= 4 before top-tier interviews.

---

## Post-Mock Review Template (15 minutes)
1. What was unclear?
2. Where did I hand-wave?
3. Which tradeoff did I not quantify?
4. What would break first in my design?
5. One concrete improvement for next mock.

---

## Difficulty Progression

## Level 1 (beginner)
- URL shortener
- Rate limiter
- Notification service

## Level 2 (intermediate)
- Twitter timeline
- Chat system
- Log aggregation

## Level 3 (advanced)
- Uber matching
- YouTube
- Search engine

---

## Common Failure Patterns and Fixes
1. **Problem:** jumping to architecture too early  
   **Fix:** force 5 minutes requirements first.
2. **Problem:** no scale estimation  
   **Fix:** always compute QPS + storage growth.
3. **Problem:** no failure strategy  
   **Fix:** include timeout/retry/idempotency/degraded mode block.
4. **Problem:** weak communication  
   **Fix:** explicitly compare 2 options before choosing.

---

## Practice Prompt Bank
1. Design Slack channels and message history.
2. Design Google Docs collaborative editing backend.
3. Design ride matching service for Uber.
4. Design recommendation feed service.
5. Design global feature flag service.

## Sophisticated Mock Program

### Weekly rotation
- Week 1: social feed and graph.
- Week 2: realtime messaging and presence.
- Week 3: media upload/playback.
- Week 4: marketplace/location.
- Week 5: infrastructure systems.
- Week 6: multi-region and disaster recovery.

### Output after every mock
- One design diagram.
- One capacity estimate.
- One API and schema section.
- One bottleneck section.
- One failure-mode section.
- One self-critique.

### Advanced interviewer pushbacks
Practice answering:
- "What changes at 10x traffic?"
- "Which data can be stale?"
- "How do you recover from regional failure?"
- "What do you monitor?"
- "How do you reduce cost?"
- "How would you migrate without downtime?"

### Senior scoring dimensions
- Constraint-driven decisions.
- Clear evolution path.
- Production operability.
- Security and abuse awareness.
- Tradeoff honesty.

## Rigorous Mock Evaluation Sheet

```text
Prompt:
Assumptions:
Scale:
Core entities:
Hot path:
Architecture:
Consistency:
Failure handling:
Security:
Metrics:
10x evolution:
Weakest part:
```

### Automatic fail signals
- No scale estimate.
- No data model.
- No failure handling.
- No consistency discussion.
- Architecture has components with no purpose.
- Uses "Kafka/Redis/microservices" without explaining why.
