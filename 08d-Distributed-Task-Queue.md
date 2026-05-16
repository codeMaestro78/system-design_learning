# Project 4: Distributed Task Queue

## Goal
Build a task queue where:
- Producers submit jobs (e.g., "send email", "resize image")
- Workers pick up and process jobs asynchronously
- Failed jobs are retried with exponential backoff
- Jobs have priorities and deadlines

This project teaches: producer-consumer pattern, at-least-once delivery, retry logic, worker pools.

---

## Why a Task Queue?
```text
Without async task queue:
  User requests: POST /signup
  Handler: INSERT user + send_welcome_email() + create_profile() -> 800ms
  User waits 800ms for operations unrelated to their login

With task queue:
  User requests: POST /signup
  Handler: INSERT user + enqueue("send_email", ...) + enqueue("create_profile", ...) -> 50ms
  User gets response in 50ms
  Workers process email + profile in background
```

---

## Architecture
```text
Producer (App Server)
    |  task = {"type": "send_email", "to": "...", "subject": "..."}
    v
[Task Queue (Redis LIST)]
    |
    +---> Priority Queue:  ZADD tasks score=priority member=task_json
    |
    +---> Dead Letter Queue: tasks that failed max_retries times
    
Worker Pool (N workers)
    |  BLPOP tasks 30  <- blocking pop, waits up to 30s
    v
[Task Processor]
    |
    +-- Success: ACK (remove from in-flight set)
    |
    +-- Failure: retry with exponential backoff (re-enqueue with delay)
    |
    +-- Max retries exceeded: send to Dead Letter Queue
```

---

## Full Working Implementation

```python
#!/usr/bin/env python3
"""
task_queue.py - A distributed task queue using Redis.

Run workers: uv run task_queue.py worker
Submit jobs: uv run task_queue.py submit
"""
# /// script
# dependencies = ["redis", "uvicorn", "fastapi"]
# ///

import redis
import json
import time
import uuid
import asyncio
import logging
import traceback
from dataclasses import dataclass, asdict
from typing import Callable, Optional, Any
from concurrent.futures import ThreadPoolExecutor

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


# ============================================================================
# Task definition
# ============================================================================

@dataclass
class Task:
    id: str
    type: str               # Handler name to invoke
    payload: dict           # Arguments for the handler
    priority: int = 5       # 1=highest, 10=lowest
    max_retries: int = 3
    retry_count: int = 0
    delay_until: float = 0  # Unix timestamp; 0 = run immediately
    created_at: float = 0
    enqueued_at: float = 0
    
    @classmethod
    def create(cls, task_type: str, payload: dict, priority: int = 5,
               max_retries: int = 3, delay_seconds: float = 0) -> "Task":
        return cls(
            id=str(uuid.uuid4()),
            type=task_type,
            payload=payload,
            priority=priority,
            max_retries=max_retries,
            created_at=time.time(),
            delay_until=time.time() + delay_seconds if delay_seconds > 0 else 0
        )
    
    def to_json(self) -> str:
        return json.dumps(asdict(self))
    
    @classmethod
    def from_json(cls, s: str) -> "Task":
        return cls(**json.loads(s))


# ============================================================================
# Redis-backed task queue
# ============================================================================

class TaskQueue:
    """
    Reliable task queue using Redis.
    
    Keys:
    - tasks:ready      - Sorted set: score=run_after_timestamp, member=task_json
    - tasks:delayed    - Sorted set: score=run_at_timestamp (future tasks)
    - tasks:inflight   - Hash: task_id -> {task_json, worker_id, started_at}
    - tasks:dead       - List of failed task JSONs (dead letter queue)
    - tasks:stats      - Hash: total/success/failed/retried counts
    """
    
    QUEUE_READY = "tasks:ready"
    QUEUE_DELAYED = "tasks:delayed"
    QUEUE_INFLIGHT = "tasks:inflight"
    QUEUE_DEAD = "tasks:dead"
    QUEUE_STATS = "tasks:stats"
    
    VISIBILITY_TIMEOUT_S = 300  # 5 minutes: if worker doesn't ACK, re-queue
    
    def __init__(self, redis_client):
        self.r = redis_client
    
    def enqueue(self, task: Task) -> str:
        """Add task to queue. Returns task ID."""
        task.enqueued_at = time.time()
        task_json = task.to_json()
        
        if task.delay_until and task.delay_until > time.time():
            # Delayed task: goes to delayed queue
            self.r.zadd(self.QUEUE_DELAYED, {task_json: task.delay_until})
        else:
            # Immediate task: score = priority (lower priority = run first in ZPOP)
            # We invert: score = -priority so ZPOPMIN gets highest priority
            score = task.priority * 1000 - time.time() / 1e10  # Tie-break by age
            self.r.zadd(self.QUEUE_READY, {task_json: score})
        
        self.r.hincrby(self.QUEUE_STATS, "total", 1)
        logger.info(f"Enqueued task {task.id} type={task.type}")
        return task.id
    
    def dequeue(self, timeout: int = 30) -> Optional[Task]:
        """
        Blocking dequeue. Returns next ready task or None on timeout.
        Also promotes any delayed tasks that are now due.
        """
        # First: promote any delayed tasks that are now ready
        self._promote_delayed_tasks()
        
        # ZPOPMIN: get lowest-score (= highest priority) task
        result = self.r.zpopmin(self.QUEUE_READY, count=1)
        
        if not result:
            # No tasks: wait briefly then retry (simple polling)
            time.sleep(0.5)
            return None
        
        task_json, _ = result[0]
        task = Task.from_json(task_json)
        
        # Track as in-flight (for visibility timeout)
        self.r.hset(self.QUEUE_INFLIGHT, task.id, json.dumps({
            "task": task_json,
            "worker_id": "worker",
            "started_at": time.time(),
        }))
        
        return task
    
    def ack(self, task_id: str) -> None:
        """Acknowledge successful task completion."""
        self.r.hdel(self.QUEUE_INFLIGHT, task_id)
        self.r.hincrby(self.QUEUE_STATS, "success", 1)
        logger.info(f"Task {task_id} ACK'd")
    
    def nack(self, task: Task, error: str) -> None:
        """
        Negative ACK: task failed.
        Retry with exponential backoff or send to DLQ.
        """
        self.r.hdel(self.QUEUE_INFLIGHT, task.id)
        self.r.hincrby(self.QUEUE_STATS, "failed", 1)
        
        if task.retry_count < task.max_retries:
            # Retry with exponential backoff
            delay = (2 ** task.retry_count) * 5  # 5, 10, 20, 40 seconds
            task.retry_count += 1
            task.delay_until = time.time() + delay
            
            self.r.zadd(self.QUEUE_DELAYED, {task.to_json(): task.delay_until})
            self.r.hincrby(self.QUEUE_STATS, "retried", 1)
            
            logger.warning(f"Task {task.id} failed (attempt {task.retry_count}), "
                          f"retrying in {delay}s: {error}")
        else:
            # Max retries exceeded: dead letter queue
            self.r.rpush(self.QUEUE_DEAD, json.dumps({
                "task": asdict(task),
                "error": error,
                "failed_at": time.time()
            }))
            logger.error(f"Task {task.id} sent to DLQ after {task.retry_count} retries: {error}")
    
    def _promote_delayed_tasks(self) -> int:
        """Move delayed tasks that are now due into the ready queue."""
        now = time.time()
        # Get all delayed tasks with run_time <= now
        due = self.r.zrangebyscore(self.QUEUE_DELAYED, 0, now, withscores=True)
        
        if not due:
            return 0
        
        pipe = self.r.pipeline()
        promoted = 0
        
        for task_json, score in due:
            task = Task.from_json(task_json)
            ready_score = task.priority * 1000 - time.time() / 1e10
            pipe.zadd(self.QUEUE_READY, {task_json: ready_score})
            pipe.zrem(self.QUEUE_DELAYED, task_json)
            promoted += 1
        
        pipe.execute()
        
        if promoted:
            logger.info(f"Promoted {promoted} delayed tasks to ready queue")
        return promoted
    
    def recover_stalled_tasks(self) -> int:
        """
        Visibility timeout: if a worker died while processing,
        re-queue the task after VISIBILITY_TIMEOUT_S.
        """
        now = time.time()
        inflight = self.r.hgetall(self.QUEUE_INFLIGHT)
        recovered = 0
        
        for task_id, info_json in inflight.items():
            info = json.loads(info_json)
            if now - info["started_at"] > self.VISIBILITY_TIMEOUT_S:
                task = Task.from_json(info["task"])
                task.retry_count += 1
                
                if task.retry_count <= task.max_retries:
                    ready_score = task.priority * 1000
                    self.r.zadd(self.QUEUE_READY, {task.to_json(): ready_score})
                else:
                    self.r.rpush(self.QUEUE_DEAD, json.dumps({
                        "task": asdict(task),
                        "error": "visibility_timeout_exceeded",
                        "failed_at": now
                    }))
                
                self.r.hdel(self.QUEUE_INFLIGHT, task_id)
                recovered += 1
                logger.warning(f"Recovered stalled task {task_id}")
        
        return recovered
    
    def stats(self) -> dict:
        raw = self.r.hgetall(self.QUEUE_STATS)
        return {
            "total": int(raw.get("total", 0)),
            "success": int(raw.get("success", 0)),
            "failed": int(raw.get("failed", 0)),
            "retried": int(raw.get("retried", 0)),
            "ready": self.r.zcard(self.QUEUE_READY),
            "delayed": self.r.zcard(self.QUEUE_DELAYED),
            "inflight": self.r.hlen(self.QUEUE_INFLIGHT),
            "dead_letter": self.r.llen(self.QUEUE_DEAD),
        }


# ============================================================================
# Worker
# ============================================================================

class Worker:
    """
    Task worker: continuously polls queue and processes tasks.
    """
    
    def __init__(self, queue: TaskQueue, handlers: dict):
        self.queue = queue
        self.handlers = handlers  # {"task_type": callable}
        self.running = True
        self._processed = 0
    
    def run(self, worker_id: int = 0) -> None:
        logger.info(f"Worker {worker_id} started")
        
        while self.running:
            try:
                task = self.queue.dequeue(timeout=5)
                if task is None:
                    continue
                
                self._process_task(task)
            except KeyboardInterrupt:
                logger.info(f"Worker {worker_id} shutting down")
                break
            except Exception as e:
                logger.error(f"Worker {worker_id} unexpected error: {e}")
    
    def _process_task(self, task: Task) -> None:
        handler = self.handlers.get(task.type)
        
        if not handler:
            self.queue.nack(task, f"No handler for task type '{task.type}'")
            return
        
        logger.info(f"Processing task {task.id} type={task.type}")
        start = time.time()
        
        try:
            handler(**task.payload)
            elapsed = time.time() - start
            logger.info(f"Task {task.id} completed in {elapsed:.2f}s")
            self.queue.ack(task.id)
            self._processed += 1
        except Exception as e:
            elapsed = time.time() - start
            error = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
            logger.warning(f"Task {task.id} failed after {elapsed:.2f}s: {e}")
            self.queue.nack(task, error)


# ============================================================================
# Example Task Handlers
# ============================================================================

def send_email(to: str, subject: str, body: str) -> None:
    """Simulate sending an email."""
    import random
    
    # Simulate occasional failures (10% chance)
    if random.random() < 0.1:
        raise ConnectionError("Email server unavailable")
    
    time.sleep(0.1)  # Simulate network call
    logger.info(f"Email sent to {to}: {subject}")


def resize_image(image_key: str, width: int, height: int) -> None:
    """Simulate image resizing."""
    time.sleep(0.2)  # Simulate CPU work
    logger.info(f"Resized {image_key} to {width}x{height}")


def send_push_notification(user_id: str, message: str) -> None:
    """Simulate push notification."""
    time.sleep(0.05)
    logger.info(f"Push sent to user {user_id}: {message}")


# ============================================================================
# Worker Pool (multiple workers in parallel)
# ============================================================================

def run_worker_pool(queue: TaskQueue, handlers: dict, num_workers: int = 4) -> None:
    """Run multiple workers in parallel using threads."""
    
    workers = [Worker(queue, handlers) for _ in range(num_workers)]
    
    with ThreadPoolExecutor(max_workers=num_workers) as executor:
        futures = [executor.submit(w.run, i) for i, w in enumerate(workers)]
        
        try:
            for f in futures:
                f.result()
        except KeyboardInterrupt:
            for w in workers:
                w.running = False


# ============================================================================
# Demo / Test
# ============================================================================

def demo():
    """Submit sample tasks and watch workers process them."""
    r = redis.Redis(decode_responses=True)
    queue = TaskQueue(r)
    
    handlers = {
        "send_email": send_email,
        "resize_image": resize_image,
        "push_notification": send_push_notification,
    }
    
    # Submit a batch of tasks
    print("Submitting tasks...")
    
    for i in range(20):
        task_type = ["send_email", "resize_image", "push_notification"][i % 3]
        
        if task_type == "send_email":
            task = Task.create("send_email", {
                "to": f"user{i}@example.com",
                "subject": f"Welcome #{i}",
                "body": "Welcome to our service!"
            }, priority=3)
        elif task_type == "resize_image":
            task = Task.create("resize_image", {
                "image_key": f"uploads/img_{i}.jpg",
                "width": 800, "height": 600
            }, priority=5)
        else:
            task = Task.create("push_notification", {
                "user_id": f"user_{i}",
                "message": "Your order is ready!"
            }, priority=1)  # High priority
        
        queue.enqueue(task)
    
    # Also enqueue a delayed task (runs in 5 seconds)
    delayed = Task.create("send_email", {
        "to": "delayed@example.com",
        "subject": "Delayed email",
        "body": "This was scheduled!"
    }, delay_seconds=5)
    queue.enqueue(delayed)
    
    print(f"Stats before processing: {queue.stats()}")
    print("\nStarting workers (Ctrl+C to stop)...")
    
    run_worker_pool(queue, handlers, num_workers=3)
    
    print(f"\nFinal stats: {queue.stats()}")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "demo":
        demo()
    else:
        print("Usage: uv run task_queue.py demo")
```

---

## Testing

```bash
# Start Redis first
redis-server &

# Run demo (submit tasks + process with worker pool)
uv run task_queue.py demo

# Expected output:
# Submitting tasks...
# Stats before processing: {'total': 21, 'success': 0, 'failed': 0, 'ready': 20, 'delayed': 1}
# Starting workers (Ctrl+C to stop)...
# [INFO] Worker 0 started
# [INFO] Worker 1 started  
# [INFO] Worker 2 started
# [INFO] Processing task abc123 type=push_notification  (high priority first!)
# [INFO] Push sent to user user_2: Your order is ready!
# [INFO] Task abc123 completed in 0.05s
# [WARNING] Task def456 failed (attempt 1), retrying in 5s: ConnectionError: Email server unavailable
# ... 
# [INFO] Email sent to user0@example.com: Welcome #0  (retry succeeded)
```

---

## Key Learning Points

```text
1. Reliable delivery requires two-phase dequeue:
   - ZPOPMIN (remove from ready queue) + HSET to inflight (mark as processing)
   - If worker crashes: visibility timeout recovers inflight tasks
   - Without two-phase: task is lost on worker crash (fire-and-forget, unreliable)

2. At-least-once vs exactly-once:
   - At-least-once: task may run multiple times (on retry)
   - Exactly-once: requires idempotency in the handler
   - Example: send_email should check if email already sent (idempotency key)

3. Exponential backoff with jitter:
   - Without jitter: all retries happen at same time -> thundering herd
   - With jitter: delay = 2^retry * base + random(0, base)

4. Priority queues vs FIFO:
   - FIFO (Redis LIST): simple, chronological
   - Priority (Redis ZSET): sort by priority score
   - Most job queues are hybrid: priority within same priority level = FIFO

5. Dead Letter Queue:
   - Don't silently drop failed tasks
   - DLQ allows manual inspection + replay after fixing the bug
   - Alert on DLQ growth

6. Delayed tasks:
   - Store in separate sorted set with score = run_at_timestamp
   - Promote to ready queue when run_at <= now
   - Worker or dedicated scheduler promotes on each cycle
```
