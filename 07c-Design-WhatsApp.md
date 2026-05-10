# Design WhatsApp (Comprehensive)

## Intuition
Realtime messaging is mostly a connection-management and delivery-guarantee problem.

## Requirements
- 1:1 and group chat
- Delivery/read receipts
- Presence
- Media attachments
- Offline sync

## NFRs
- Low send latency
- Message durability
- High connection scalability
- Privacy/security

## HLD
```text
Clients <-> Gateway (WebSocket) -> Chat Service -> Message Store
                                -> Presence Service (in-memory + Redis)
                                -> Push Notification Service
```

## LLD
- Persistent socket per online device.
- Sequence number per conversation for ordering.
- Store-and-forward queue for offline recipients.

## Schema
```sql
conversations(id, type, created_at)
conversation_members(conversation_id, user_id, joined_at)
messages(id, conversation_id, sender_id, seq_no, payload_ref, created_at)
receipts(message_id, user_id, state, updated_at)
```

## Protocol events
- `SEND_MESSAGE`
- `DELIVERED_ACK`
- `READ_ACK`
- `TYPING_ON/OFF`
- `PRESENCE_UPDATE`

## Bottlenecks
- Gateway memory and connection churn
- Group chat fanout
- Presence update storms

## Scaling
- Partition by conversation ID
- Sticky routing for socket affinity
- Batched fanout for large groups

## Failure Handling
- Retry with idempotency message IDs.
- On reconnect, sync missing messages by sequence range.
- Graceful degradation: disable presence before core send path.

## Sophisticated Production Expansion

### Product promise
Messages should be delivered reliably and privately, even when recipients are offline or on unstable networks.

### Mature architecture
```text
Clients <-> Realtime Gateway -> Session Registry
                             -> Chat Service -> Message Store
                             -> Fanout Queue
                             -> Push Notification Service
                             -> Receipt Service
```

### Real-life design choices
- Use idempotent client-generated message IDs.
- Persist message before acking send.
- Sync missing sequence ranges after reconnect.
- Presence is best-effort and can degrade before message delivery.

### What breaks first
- Connection storms after deploy or regional outage.
- Large group fanout.
- Presence update floods.

### Metrics
- Send-to-server latency.
- Server-to-recipient latency.
- Offline queue depth.
- Reconnect rate.
- Gateway active connections.

## Rigorous Architecture Addendum

### Scaled architecture
```text
Client <-> Realtime Gateway -> Session Registry
                              -> Chat Service -> Message Store
                              -> Conversation Sequencer
                              -> Delivery Queue
                              -> Push Notification Service
                              -> Receipt Service

Media Upload -> Object Store -> CDN/Signed URLs
```

### Correctness boundaries
- Message is stored durably before sender receives server ack.
- Delivery to recipient is at-least-once with client-side dedupe.
- Ordering is guaranteed within a conversation by sequence number.
- Presence and typing are best-effort.
- Push notification may arrive before or after socket delivery.

### Failure table
```text
Failure              Impact                         Mitigation
Gateway restart      reconnect storm                connection draining and jittered reconnect
Message DB slow      send latency spike             backpressure and regional partitioning
Recipient offline    delayed delivery               durable offline queue
Push provider down   no mobile notification         retry and provider fallback
Large group fanout   queue pressure                 batching and group size controls
```

## Security
- End-to-end encryption architecture (key exchange + session keys).
- Device authentication and replay protection.

## Interview framing
"I separate control plane (presence/session) and data plane (message persistence + fanout), then optimize for reconnect and offline delivery."

## Extended Deep Dive

### Message ordering strategy
- Per-conversation monotonic sequence IDs
- Idempotent dedupe on `(conversation_id, client_msg_id)`
- Server ack includes authoritative sequence

### Group messaging at scale
- Sender-side fanout for small groups
- Server-side batched fanout for large groups
- Partial delivery tracking per recipient device

### Reconnect protocol
Client sends last received sequence; server returns missing range and pending receipts.
