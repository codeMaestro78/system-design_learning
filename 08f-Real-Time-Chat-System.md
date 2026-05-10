# Project 6: Real-Time Chat System

## Architecture
```text
Clients <-> WebSocket Gateway -> Chat Service -> Message DB
                              -> Presence Service
                              -> Push Notification Adapter
```

## Tech choices
- WebSocket for bidirectional realtime
- DB: Cassandra/Postgres for message history
- Redis for presence/session metadata

## Step-by-step plan
1. User auth + socket session setup.
2. Send message + ack protocol.
3. Conversation history API.
4. Presence + typing events.
5. Group chat fanout.
6. Offline message replay on reconnect.

## Scaling improvements
- Sticky sessions to reduce cross-node chatter.
- Partition by conversation ID.
- Batched fanout for large rooms.

## Production concerns
- Connection storms on deploy/restart
- Ordering guarantees
- Duplicate delivery handling

## Exercises
1. Add message edit/delete with versioning.
2. Measure and optimize P99 send-to-deliver latency.

## Extended Build Tasks

### Multi-device consistency
- Per-device acknowledgment state
- Read cursor sync across devices
- Conflict handling for edits/deletes

### Reliability
- Exactly-once illusion via idempotent message IDs
- At-least-once transport with dedupe
- Offline retry queue in client

### Security
- Session token rotation
- Message integrity checks
- Abuse throttling for spam bursts

## Sophisticated Build Expansion

### Real-world equivalent
Slack, WhatsApp, Discord, and Teams combine realtime gateways, durable message storage, presence, search, notifications, and moderation.

### Architecture
```text
Client <-> WebSocket Gateway -> Chat Service -> Message Store
                              -> Presence Store
                              -> Fanout Queue
                              -> Push Notification Adapter
                              -> Search Indexer
```

### Advanced topics
- Multi-device sync.
- Per-conversation sequence numbers.
- Offline replay.
- Message edit/delete versioning.
- Typing and presence throttling.
- Large group fanout.

### Production questions
- How do clients recover after reconnect?
- What ordering guarantee is provided?
- Can duplicate messages appear?
- What degrades first under overload?

## Rigorous Acceptance Criteria

### Minimum architecture
```text
Client <-> Gateway -> Chat Service -> Message Store
                              -> Delivery Queue
                              -> Presence Store
                              -> Push Adapter
```

### Required behaviors
- Client-generated message ID deduplicates retries.
- Message is durable before ack.
- Conversation sequence numbers are monotonic.
- Reconnect sync fetches missing range.
- Presence updates are throttled.
- Offline recipient gets queued delivery/push.

### Failure tests
- Client reconnect during send.
- Gateway crash.
- Duplicate message retry.
- Large group fanout.
