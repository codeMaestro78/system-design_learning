# Communication Training for System Design Interviews

## Goal
Speak like a senior engineer: structured, explicit, and tradeoff-driven.

---

## Core Communication Framework
Use this sequence in every design discussion:
1. Requirements
2. Scale
3. Baseline design
4. Critical deep dive
5. Tradeoffs
6. Failure handling
7. Evolution plan

---

## High-Signal Sentence Patterns
1. "Given **X constraint**, I’m optimizing for **Y**."
2. "I considered **A** and **B**; I choose **B** because..."
3. "The first bottleneck will likely be..."
4. "Under dependency failure, the system will..."
5. "If traffic doubles, I would first..."

---

## What strong candidates do differently
1. Clarify assumptions before drawing architecture.
2. Quantify scale early.
3. Name tradeoffs explicitly.
4. Address failure and operability.
5. Communicate incrementally (MVP -> scale evolution).

---

## Common Communication Mistakes
1. Talking in buzzwords with no constraints.
2. Jumping between topics without structure.
3. Avoiding hard tradeoffs.
4. Ignoring interviewer prompts.
5. Not summarizing.

---

## 5-Minute Speaking Drill
Pick one topic (e.g., caching strategy) and speak:
1. 1 min intuition/problem
2. 1 min options
3. 1 min chosen design
4. 1 min failures/tradeoffs
5. 1 min recap

Record yourself and improve clarity/pace.

---

## Pushback Handling Framework
When interviewer challenges design:
1. Acknowledge point
2. Restate assumption
3. Offer alternative
4. Compare tradeoffs
5. Decide with reason

Example:
"Great point. If consistency is stricter than we assumed, we should switch from async replication to quorum writes, accepting higher write latency."

---

## Whiteboard/Pad Structure Template
Use fixed headings:
1. Requirements
2. NFR + SLO
3. Estimation
4. APIs
5. Data model
6. HLD
7. Deep dive
8. Failures + scaling
9. Tradeoff summary

---

## Final 2-minute close template
1. "Here’s the architecture in one line..."
2. "Key decisions and why..."
3. "Main failure protections..."
4. "Next scaling step..."

---

## Weekly Communication Practice Plan
1. One 10-min design explanation recording
2. One mock with peer feedback
3. One rewrite of weak explanations
4. One timed 2-minute summary drill

## Sophisticated Communication Roadmap

### Communication levels
- Executive: explain user impact, risk, cost, and rollout.
- Engineering manager: explain ownership, milestones, and operational load.
- Senior engineer: explain contracts, failure modes, and tradeoffs.
- Interviewer: explain requirements, scale, architecture, bottlenecks, and evolution.

### High-signal design review language
- "The hot path is intentionally small: auth, lookup, decision, response."
- "This async path can lag without breaking the user-facing promise."
- "The write is idempotent because clients and gateways can retry."
- "This component is a future split point, not a required service on day one."
- "The first production risk is not throughput; it is operational visibility."

### Real-world storytelling framework
For any architecture, tell the story as:
```text
Product promise -> Baseline design -> First bottleneck -> Failure plan -> Evolution
```

### Practice exercise
Take one design and produce:
- 30-second summary.
- 2-minute architecture walkthrough.
- 5-minute deep dive.
- 45-minute full interview answer.

## Rigorous Communication Rubric

### Good architecture sentence
```text
Given [scale/constraint], I choose [design] because [reason], while accepting [tradeoff].
```

### Bad architecture sentence
```text
We use Kafka, Redis, and microservices because it is scalable.
```

### Required verbal checkpoints
- "Here is what is in and out of scope."
- "Here is the rough scale."
- "This is the hot path."
- "This is the durable write boundary."
- "This can be eventually consistent."
- "This is the first bottleneck."
- "This is how we detect and recover from failure."
