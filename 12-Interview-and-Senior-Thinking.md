# Part 10: Interview + Senior Engineering Thinking

## 1) How to approach system design interviews

### Framework
1. Clarify requirements (functional + non-functional)
2. Estimate scale
3. Define APIs and data model
4. Present HLD
5. Deep dive one critical path
6. Discuss bottlenecks + scaling
7. Failure handling and tradeoffs

### Interview signal
Interviewers evaluate reasoning quality, not architecture buzzwords.

---

## 2) How to communicate tradeoffs

Always compare options:
- Option A: faster now, lower complexity
- Option B: stronger guarantees, higher cost
- Decision tied to constraints and SLOs

Use language:
"Given X traffic and Y correctness requirement, I choose Z because..."

---

## 3) Common mistakes
- Jumping to solution before requirements
- Ignoring estimation
- No failure story
- No consistency reasoning
- Over-designing early

---

## 4) How senior engineers think
- Design for change, not static perfection.
- Keep blast radius small.
- Prefer operable systems over theoretically elegant but fragile ones.
- Bias toward clear ownership and reliable interfaces.

---

## 5) Communication template for whiteboard/live interview
```text
Assumptions -> Requirements -> Scale -> HLD -> Deep Dive -> Tradeoffs -> Failure Plan
```

## Practice prompts
1. Design Slack channels with message history.
2. Design payment webhook retry system.
3. Design feature flag service with low-latency reads.

## Sophisticated Senior-Thinking Roadmap

### What senior interviewers look for
- You clarify scope before architecture.
- You quantify scale before choosing storage.
- You separate hot paths from async paths.
- You identify the first bottleneck.
- You state consistency contracts.
- You explain failure handling without hand-waving.
- You make cost-aware and team-aware choices.

### Senior communication structure
```text
Product promise
  -> Requirements
  -> Scale
  -> Data model
  -> Baseline architecture
  -> Critical path
  -> Bottlenecks
  -> Failure handling
  -> Security
  -> Evolution
```

### Example strong framing
"For the first version, I would keep this as a modular monolith with a relational database because the team is small and the transaction boundary is still simple. I would introduce a queue for notifications immediately because email delivery should not block checkout. Once order volume grows, I would split the payment adapter and inventory reservation paths behind idempotent APIs."

### Real-world examples to practice
- Payment webhook delivery.
- Feature flag service.
- Multi-tenant metrics platform.
- Global file upload service.
- Realtime collaboration document.

### Design exercise
Explain the same system at three levels:
- 2-minute executive summary.
- 10-minute engineering design review.
- 45-minute interview deep dive.

## Rigorous Interview Rubric

### Scoring dimensions
```text
Dimension              Weak answer                         Strong answer
Requirements           jumps to boxes                      clarifies scope and exclusions
Scale                  vague "large scale"                 calculates QPS/storage/fanout
Data model             generic DB choice                   schema/indexes/access patterns
Architecture           buzzword diagram                    justified components and flows
Consistency            ignored                             per-feature consistency contract
Failure handling       "we retry"                          timeout, retry budget, idempotency, DLQ
Operations             absent                              metrics, alerts, deploy, rollback
Tradeoffs              no alternatives                     compares options and chooses
```

### Senior-level close
End every design with:
- The simplest version I would ship first.
- The first bottleneck I expect.
- The first failure I would rehearse.
- The metric I would watch daily.
- The next architecture change at 10x traffic.

---

## Senior-Level Communication Patterns

### High-signal phrasing
- "Given X constraint, I prioritize Y because..."
- "The failure mode here is..., so I add..."
- "If scale doubles, first bottleneck is likely..., and mitigation is..."

### When interviewer pushes back
Respond with:
1. acknowledge concern
2. restate assumptions
3. present alternative and cost
4. choose based on stated priority

### Whiteboard anti-fragility
If you forgot a detail:
- explicitly mark assumption,
- continue flow,
- revisit and refine with tradeoff.

### Final 2-minute close template
1. recap architecture
2. recap key tradeoffs
3. recap failure handling
4. mention next scaling evolution
