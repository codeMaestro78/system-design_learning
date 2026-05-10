# Project 4: Distributed Task Queue

## Architecture
```text
Producer API -> Queue/Broker -> Worker Pool -> Result Store
                          \-> Scheduler (delayed jobs)
```

## Tech choices
- Broker: Redis Streams/Kafka/RabbitMQ
- Result DB: Postgres/Redis

## Step-by-step plan
1. Enqueue API with task metadata.
2. Worker consumer with ack/nack protocol.
3. Retry with exponential backoff.
4. Dead letter queue handling.
5. Delayed/scheduled jobs.
6. Idempotency keys for task execution.

## Scaling improvements
- Partition queues by task type/tenant.
- Auto-scale workers by lag.
- Priority queues.

## Production concerns
- Poison messages
- Retry storms
- Exactly-once illusion (use idempotency)
- Visibility timeout tuning

## Exercises
1. Implement max retry + DLQ dashboard.
2. Add workflow chaining with dependent jobs.

## Extended Build Tasks

### Scheduling semantics
- Exact-time scheduling tolerance window
- Retry jitter policy
- Cron-like recurring jobs

### Worker reliability
- Heartbeat and lease renewal
- Visibility timeout extension for long tasks
- Graceful shutdown draining

### Ops features
- Queue lag alarms
- Task trace IDs
- Replay tools from DLQ

## Sophisticated Build Expansion

### Real-world equivalent
Task queues power email delivery, media processing, billing jobs, data pipelines, and async workflow execution.

### Architecture
```text
Producer API -> Durable Queue -> Worker Pool
                         -> Retry Scheduler
                         -> Dead Letter Queue
                         -> Result Store
                         -> Metrics
```

### Advanced topics
- Visibility timeout and lease renewal.
- Idempotent task execution.
- Priority queues.
- Delayed jobs.
- Per-tenant fairness.
- Poison message quarantine.

### Production questions
- What happens when workers crash mid-task?
- How are long-running tasks handled?
- Can tasks be replayed safely?
- How do you prevent retry storms?

## Rigorous Acceptance Criteria

### Minimum architecture
```text
Producer -> Queue Store -> Lease/Visibility Manager -> Worker Pool
                              -> Retry Scheduler
                              -> Dead Letter Queue
                              -> Metrics
```

### Required behaviors
- Task is invisible while leased.
- Expired lease returns task to queue.
- Worker success acknowledges task.
- Worker failure retries with backoff.
- Max attempts moves task to DLQ.
- Replay from DLQ is explicit and audited.

### Failure tests
- Worker crash after task lease.
- Poison task.
- Retry storm under dependency outage.
- Queue store restart.
