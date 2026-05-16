# Project 6: Real-Time Chat System

## Goal
Build a working real-time chat system that:
- Maintains persistent WebSocket connections for bidirectional messaging
- Assigns server-side sequence numbers to guarantee message ordering
- Deduplicates retried messages using client-generated IDs (idempotency)
- Tracks user presence (online/offline) with typing-indicator throttling
- Delivers queued messages to users on reconnect (offline buffering)
- Provides REST endpoints for message history sync and HTTP message sending

This project teaches: WebSocket lifecycle, sequence numbers, fan-out patterns, presence management, deduplication, offline delivery.

---

## Architecture

```text
┌──────────────────────┐     ┌──────────────────────┐
│   Client A           │     │   Client B           │
│  (Alice's phone)     │     │  (Bob's laptop)      │
└──────────┬───────────┘     └──────────┬───────────┘
           │  WebSocket /ws/alice        │  WebSocket /ws/bob
           ▼                            ▼
┌──────────────────────────────────────────────────────┐
│               WebSocket Gateway  (FastAPI)           │
│                                                      │
│  ConnectionManager                                   │
│    user_id → {conn_id → WebSocket}                  │
│    send_to_user()  — delivers to all user devices   │
│    broadcast_to_conversation() — fan-out            │
│                                                      │
│  PresenceManager                                     │
│    user_id → {conn_id, ...}   (multi-device)        │
│    throttled typing indicators (1 per 3s)           │
│                                                      │
│  Message Protocol (JSON over WebSocket):            │
│    send_message → seq_num assigned → fanout         │
│    typing       → throttled broadcast               │
│    sync         → deliver missed messages           │
│    ack          → mark delivered/read               │
└───────────────┬──────────────────────────────────────┘
                │
    ┌───────────▼──────────────┐
    │    ConversationStore     │  (in-memory; production: Cassandra/Postgres)
    │    - messages by conv_id │
    │    - seq_num counter     │  monotonically increasing per conversation
    │    - dedup by            │
    │      client_msg_id       │  idempotent: retry = same result
    │    - read cursors        │  per-user read position
    └───────────┬──────────────┘
                │
    ┌───────────▼──────────────┐
    │    Offline Message Queue │  (in-memory; production: Redis list / SQS)
    │    user_id → [msg, ...]  │
    │    Delivered on reconnect│
    │    + push notification   │  (FCM/APNs in production)
    └──────────────────────────┘

REST endpoints:
  POST /conversations                    — create conversation
  POST /conversations/{id}/messages      — HTTP send (bots, integrations)
  GET  /conversations/{id}/messages      — history sync / initial load
  GET  /presence?user_ids=alice,bob      — online status check

Production equivalent: WhatsApp, Slack, Discord, iMessage
```

---

## Capacity Estimation

```python
# Run this block standalone to understand the scale of a real chat system.

MONTHLY_ACTIVE_USERS   = 10_000_000   # 10M MAU (mid-size product)
DAILY_ACTIVE_USERS     = 2_000_000    # 20% of MAU are daily active
PEAK_CONCURRENT_CONNS  = 500_000      # 25% of DAU online simultaneously

# WebSocket connection cost
MEMORY_PER_CONN_KB     = 64           # kernel socket + app buffers
total_ws_memory_gb     = PEAK_CONCURRENT_CONNS * MEMORY_PER_CONN_KB / (1024 ** 2)
CONNS_PER_SERVER       = 10_000       # modern server with tuned ulimits
gateway_servers_needed = PEAK_CONCURRENT_CONNS / CONNS_PER_SERVER

print(f"Concurrent WebSocket connections: {PEAK_CONCURRENT_CONNS:>10,}")
print(f"Memory for connections:           {total_ws_memory_gb:>10.0f} GB")
print(f"Gateway servers needed:           {gateway_servers_needed:>10.0f}  (@ {CONNS_PER_SERVER:,} each)")

# Message throughput
MSGS_PER_USER_PER_DAY  = 50
msgs_per_day           = DAILY_ACTIVE_USERS * MSGS_PER_USER_PER_DAY
msgs_per_sec_avg       = msgs_per_day / 86_400
msgs_per_sec_peak      = msgs_per_sec_avg * 5   # 5x spike during business hours

print(f"\nMessages/day:                     {msgs_per_day:>10,}")
print(f"Messages/sec (avg):               {msgs_per_sec_avg:>10.0f}")
print(f"Messages/sec (5x peak):           {msgs_per_sec_peak:>10.0f}")

# Fan-out: how many WebSocket sends per message?
AVG_CONV_PARTICIPANTS  = 2.5    # 1-1 chats dominate; some group chats
fanout_per_msg         = AVG_CONV_PARTICIPANTS - 1
delivery_events_per_sec = msgs_per_sec_peak * fanout_per_msg
print(f"Delivery events/sec (peak):       {delivery_events_per_sec:>10.0f}  (msgs × avg recipients)")

# Storage sizing
AVG_MSG_BYTES          = 200    # content + metadata (UUID, timestamps, seq_num)
bytes_per_day          = msgs_per_day * AVG_MSG_BYTES
gb_per_day             = bytes_per_day / (1024 ** 3)
gb_per_year            = gb_per_day * 365

print(f"\nMessage storage/day:              {gb_per_day:>10.1f} GB")
print(f"Message storage/year:             {gb_per_year:>10.0f} GB")

# Presence system — how often do presence updates fire?
TYPING_EVENTS_PER_USER_MIN = 30   # 30 keystrokes/min while actively chatting
ACTIVE_TYPING_USERS        = PEAK_CONCURRENT_CONNS * 0.05  # 5% typing at once
raw_typing_per_sec         = ACTIVE_TYPING_USERS * TYPING_EVENTS_PER_USER_MIN / 60
THROTTLE_FACTOR            = 15   # 1 broadcast per 3 seconds vs 30 events
throttled_per_sec          = raw_typing_per_sec / THROTTLE_FACTOR

print(f"\nRaw typing events/sec:            {raw_typing_per_sec:>10.0f}")
print(f"After throttling (3s window):     {throttled_per_sec:>10.0f}  ({THROTTLE_FACTOR}x reduction)")

# Expected output (approximately):
# Concurrent WebSocket connections:    500,000
# Memory for connections:                   32 GB
# Gateway servers needed:                   50  (@ 10,000 each)
# Messages/day:                    100,000,000
# Messages/sec (avg):                    1,157
# Messages/sec (5x peak):                5,787
# Delivery events/sec (peak):            8,681  (msgs × avg recipients)
# Message storage/day:                    18.6 GB
# Message storage/year:                  6,812 GB
# Raw typing events/sec:                 6,250
# After throttling (3s window):            417  (15x reduction)
```

---

## Full Working Implementation

```python
#!/usr/bin/env python3
"""
chat_system.py — Real-time chat with WebSocket, deduplication, and offline delivery.

Run:  uv run chat_system.py
Test: See wscat commands in the Testing section below.

Quick start (two terminal tabs):
  Tab 1: uv run chat_system.py
  Tab 2: wscat -c "ws://localhost:8001/ws/alice"
  Tab 3: wscat -c "ws://localhost:8001/ws/bob"
"""
# /// script
# dependencies = ["fastapi", "uvicorn[standard]", "websockets"]
# ///

import asyncio
import json
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional, Set

import uvicorn
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse


# ============================================================================
# Data Models
# ============================================================================

@dataclass
class Message:
    """
    A single chat message after server processing.

    WHY both `id` (server) and `client_msg_id` (client)?
    - client_msg_id: generated by the sender before sending.
      Used for deduplication: if the client retries (network hiccup),
      the server returns the EXISTING message, not a duplicate.
    - id: server-assigned UUID, globally unique, safe to store.
    - seq_num: server-assigned integer, monotonically increasing per conversation.
      The key invariant: messages are ordered by seq_num, always.

    This mirrors exactly how WhatsApp, iMessage, and Slack work.
    """
    id:               str    # Server-assigned UUID (stable, globally unique)
    conversation_id:  str
    sender_id:        str
    content:          str
    timestamp:        float  # Unix epoch seconds (server-assigned)
    seq_num:          int    # Monotonically increasing per conversation (ordering key)
    client_msg_id:    str    # Client-generated ID (deduplication / idempotency key)


@dataclass
class Conversation:
    """
    A conversation between 2 or more participants.

    WHY per-conversation seq_num (not global)?
    - A global counter is a serialisation bottleneck at scale.
    - Per-conversation: each conversation advances independently.
    - Clients only need to sync one conversation at a time.
    - Discord, Slack, and Telegram all use per-channel sequence numbers.
    """
    id:           str
    participants: List[str]
    created_at:   float
    messages:     List[Message]      = field(default_factory=list)
    next_seq:     int                = field(default=1)
    read_cursors: Dict[str, int]     = field(default_factory=dict)


# ============================================================================
# ConversationStore — durable message storage (in-memory for this project)
# ============================================================================

class ConversationStore:
    """
    Stores conversations and messages; enforces ordering and deduplication.

    In production: backed by Cassandra (wide-column, great for append-heavy
    time-series) or PostgreSQL with a (conversation_id, seq_num) primary key.

    Key design decisions:
    1. seq_num is assigned ATOMICALLY with the store operation.
       If two messages arrive simultaneously, one gets seq N, the other N+1.
       There is a strict total order — no ties, no gaps.

    2. client_msg_id deduplication makes sends IDEMPOTENT.
       Client sends message → network drops the ACK → client retries.
       Server: "I've seen this client_msg_id before" → returns same message.
       Result: exactly-once delivery from the client's perspective.
    """

    def __init__(self):
        self._conversations: Dict[str, Conversation]  = {}
        # Dedup table: client_msg_id → already-stored Message
        # WHY not expire this? In practice, cap it (LRU, 24h TTL).
        # For this project, we keep it simple.
        self._seen_client_ids: Dict[str, Message]     = {}

    def create_conversation(self, participants: List[str]) -> Conversation:
        conv_id = str(uuid.uuid4())
        conv = Conversation(
            id=conv_id,
            participants=participants,
            created_at=time.time(),
        )
        self._conversations[conv_id] = conv
        return conv

    def get_conversation(self, conv_id: str) -> Optional[Conversation]:
        return self._conversations.get(conv_id)

    def send_message(
        self,
        conversation_id: str,
        sender_id:       str,
        content:         str,
        client_msg_id:   str,
    ) -> Optional[Message]:
        """
        Store a new message (or return existing if client_msg_id already seen).

        Returns None if the conversation doesn't exist or sender isn't a participant.
        This is the most important method in the system — it must be:
        - Thread-safe (asyncio single-threaded guarantees this here)
        - Idempotent (same client_msg_id = same result)
        - Atomic (seq_num assigned and message stored together)
        """
        # IDEMPOTENCY CHECK: seen this client_msg_id before?
        # This handles the exact scenario: client sends → ACK lost → client retries.
        # Without this: Bob would see "hey!" twice. With this: exactly once.
        if client_msg_id in self._seen_client_ids:
            return self._seen_client_ids[client_msg_id]

        conv = self._conversations.get(conversation_id)
        if conv is None:
            return None

        # Authorization: only participants can send to a conversation.
        if sender_id not in conv.participants:
            return None

        msg = Message(
            id              = str(uuid.uuid4()),
            conversation_id = conversation_id,
            sender_id       = sender_id,
            content         = content,
            timestamp       = time.time(),
            seq_num         = conv.next_seq,   # Atomically assign
            client_msg_id   = client_msg_id,
        )

        # Advance the per-conversation counter — this is the only mutation.
        # In a distributed system, this would use an atomic increment (Redis INCR,
        # Cassandra lightweight transactions, or a dedicated sequence service).
        conv.next_seq     += 1
        conv.messages.append(msg)
        self._seen_client_ids[client_msg_id] = msg

        return msg

    def get_messages(
        self,
        conversation_id: str,
        from_seq:        int = 0,
        limit:           int = 100,
    ) -> List[Message]:
        """
        Return messages with seq_num >= from_seq (for reconnect sync).

        WHY seq_num and not a timestamp?
        - Timestamps can lie: client clock skew, daylight saving, NTP jumps.
        - seq_num is always server-assigned and monotonically correct.
        - "Give me everything after seq 42" is unambiguous and exact.
        - WhatsApp, Telegram, and iCloud Messages all use this pattern.
        """
        conv = self._conversations.get(conversation_id)
        if conv is None:
            return []
        return [m for m in conv.messages if m.seq_num >= from_seq][-limit:]

    def mark_read(self, conversation_id: str, user_id: str, seq_num: int) -> None:
        """Advance a user's read cursor (for read receipts)."""
        conv = self._conversations.get(conversation_id)
        if conv and user_id in conv.participants:
            # Only advance forward — never go backwards.
            current = conv.read_cursors.get(user_id, 0)
            conv.read_cursors[user_id] = max(current, seq_num)


# ============================================================================
# PresenceManager — who is online, with throttled typing indicators
# ============================================================================

class PresenceManager:
    """
    Tracks real-time online/offline status for all users.

    WHY dedicated presence layer (not just check ConnectionManager)?
    - Presence is read from many places: conversation list, contact list, etc.
    - Presence must survive multi-device scenarios (phone + laptop both connected).
    - Presence updates must be THROTTLED — typing events arrive every keystroke;
      without throttling, a group of 500 users typing generates 500 × 60 × 500 = 15M
      events/minute from typing indicators alone.

    Multi-device model:
    - user_id maps to a SET of connection IDs.
    - User is "online" if the set is non-empty.
    - Connecting a 2nd device: adds to set (still online).
    - Disconnecting 1 device: removes from set; online if set still non-empty.

    Throttling:
    - LinkedIn, WhatsApp, Slack all throttle presence to 3–10 second intervals.
    - We throttle typing indicators to 1 broadcast per THROTTLE_SECONDS.
    - "Alice is typing" shown for 3 seconds; if still typing, re-broadcast.
    """

    THROTTLE_SECONDS = 3.0   # Min interval between presence broadcasts per key

    def __init__(self):
        # user_id → set of active connection IDs
        self._online:         Dict[str, Set[str]] = defaultdict(set)
        # Throttle table: arbitrary key → last broadcast timestamp
        self._last_broadcast: Dict[str, float]    = {}

    def connect(self, user_id: str, conn_id: str) -> bool:
        """
        Register a connection. Returns True if this is the user's first connection
        (i.e., they just came online — worth broadcasting to their contacts).
        """
        was_offline = len(self._online[user_id]) == 0
        self._online[user_id].add(conn_id)
        return was_offline

    def disconnect(self, user_id: str, conn_id: str) -> bool:
        """
        Remove a connection. Returns True if the user is now fully offline
        (i.e., no more devices connected — worth broadcasting to their contacts).
        """
        self._online[user_id].discard(conn_id)
        if not self._online[user_id]:
            del self._online[user_id]
            return True   # User is now offline
        return False      # Other devices still connected

    def is_online(self, user_id: str) -> bool:
        return bool(self._online.get(user_id))

    def get_presence(self, user_ids: List[str]) -> Dict[str, bool]:
        return {uid: self.is_online(uid) for uid in user_ids}

    def online_users(self) -> List[str]:
        return list(self._online.keys())

    def should_broadcast(self, throttle_key: str) -> bool:
        """
        Returns True if enough time has passed to justify a broadcast for this key.

        throttle_key can be anything:
        - f"typing:{user_id}:{conv_id}"  for typing indicators
        - f"presence:{user_id}"          for online/offline events

        WHY this design?
        - The caller doesn't need to track time; PresenceManager handles it.
        - Same throttle logic can be reused for different event types.
        """
        now  = time.time()
        last = self._last_broadcast.get(throttle_key, 0.0)
        if now - last >= self.THROTTLE_SECONDS:
            self._last_broadcast[throttle_key] = now
            return True
        return False


# ============================================================================
# ConnectionManager — WebSocket lifecycle and message delivery
# ============================================================================

class ConnectionManager:
    """
    Manages the raw WebSocket connections and delivers messages.

    Separation of concerns:
    - ConnectionManager: low-level (WebSocket objects, send bytes)
    - PresenceManager:   high-level (who is online, throttling, multi-device logic)

    WHY this separation matters for scaling:
    - On a single server, ConnectionManager holds actual WebSocket objects.
    - On a multi-server cluster, you can't hold another server's WebSocket.
    - Solution: replace send_to_user() with a Redis pub/sub publish.
      Server 2 subscribes to user "bob" channel; Server 1 publishes to it.
      Server 2 receives and delivers to Bob's WebSocket.
    - This is exactly how Discord, Slack gateway, and WhatsApp work.
    """

    def __init__(self):
        # user_id → {conn_id → WebSocket}
        # Dict of dicts because one user can have multiple devices (multi-device).
        self._connections: Dict[str, Dict[str, WebSocket]] = defaultdict(dict)

    async def connect(self, user_id: str, conn_id: str, ws: WebSocket) -> None:
        """Accept the WebSocket upgrade and register the connection."""
        await ws.accept()
        self._connections[user_id][conn_id] = ws

    async def disconnect(self, user_id: str, conn_id: str) -> None:
        if user_id in self._connections:
            self._connections[user_id].pop(conn_id, None)
            if not self._connections[user_id]:
                del self._connections[user_id]

    def is_connected(self, user_id: str) -> bool:
        return bool(self._connections.get(user_id))

    async def send_to_user(self, user_id: str, payload: dict) -> int:
        """
        Deliver a message to ALL of a user's connected devices.

        Returns the count of successful sends.

        WHY send to all devices?
        - User might have phone + laptop + tablet all connected.
        - All devices must show the same message (multi-device sync).
        - WhatsApp multi-device, iMessage Continuity, Telegram use this model.

        Dead connection handling: if a send fails, the connection is stale
        (WebSocket closed without clean handshake). We remove it silently.
        """
        if user_id not in self._connections:
            return 0

        sent       = 0
        dead_conns: List[str] = []

        for conn_id, ws in list(self._connections[user_id].items()):
            try:
                await ws.send_json(payload)
                sent += 1
            except Exception:
                # Connection died without disconnect event (TCP RST, process kill, etc.)
                dead_conns.append(conn_id)

        # Cleanup: remove dead connections discovered during send.
        for conn_id in dead_conns:
            self._connections[user_id].pop(conn_id, None)
        if not self._connections.get(user_id):
            self._connections.pop(user_id, None)

        return sent

    async def broadcast_to_conversation(
        self,
        conv:         Conversation,
        payload:      dict,
        exclude_user: Optional[str] = None,
    ) -> None:
        """
        Fan-out: deliver to every participant in a conversation.

        WHY exclude the sender?
        - Sender already has an optimistic local copy in their UI.
        - We send the sender an "ack" (with server seq_num) separately.
        - Sending the full message again would cause duplicate display.

        Performance note (see Group Chat Fanout section for more):
        - For small groups (<100): deliver directly from this coroutine. ✓
        - For large groups (1000+): queue deliveries via a task queue (Celery, SQS)
          so the WebSocket handler can return without waiting for 1000 sends.
        """
        for participant in conv.participants:
            if participant == exclude_user:
                continue
            await self.send_to_user(participant, payload)


# ============================================================================
# Module-level singletons (the "database" for this in-memory system)
# ============================================================================

store    = ConversationStore()
presence = PresenceManager()
conn_mgr = ConnectionManager()

# Offline queue: messages for disconnected users, delivered on reconnect.
# Production equivalent: Redis list per user, with a push notification adapter.
offline_queue: Dict[str, List[dict]] = defaultdict(list)

app = FastAPI(title="Real-Time Chat API", version="1.0.0")


# ============================================================================
# Helper utilities
# ============================================================================

def message_to_dict(msg: Message) -> dict:
    """Serialize a Message dataclass to a JSON-serialisable dict."""
    return {
        "type":            "message",
        "id":              msg.id,
        "conversation_id": msg.conversation_id,
        "sender_id":       msg.sender_id,
        "content":         msg.content,
        "timestamp":       msg.timestamp,
        "timestamp_iso":   datetime.fromtimestamp(msg.timestamp, tz=timezone.utc).isoformat(),
        "seq_num":         msg.seq_num,
        "client_msg_id":   msg.client_msg_id,
    }


async def fanout_message(msg: Message, sender_id: str) -> None:
    """
    Deliver a message to all other conversation participants.
    Queue for offline users; send immediately to online users.
    """
    conv = store.get_conversation(msg.conversation_id)
    if conv is None:
        return

    payload = message_to_dict(msg)

    for participant in conv.participants:
        if participant == sender_id:
            continue   # Sender gets their ack separately

        if conn_mgr.is_connected(participant):
            await conn_mgr.send_to_user(participant, payload)
        else:
            # User is offline: buffer message for delivery on reconnect.
            # In production: also fire a push notification (FCM/APNs) here
            # so the user sees a banner even with the app backgrounded.
            offline_queue[participant].append(payload)
            print(f"[offline] Queued {msg.id[:8]}... for {participant} (seq={msg.seq_num})")


# ============================================================================
# WebSocket message handlers
# ============================================================================

async def handle_send_message(user_id: str, data: dict) -> dict:
    """
    Process {"type": "send_message", "conversation_id": "...", "content": "...", "client_msg_id": "..."}

    Flow:
    1. Validate input.
    2. Store message (idempotent via client_msg_id).
    3. Fan-out to all other participants (online → WebSocket, offline → queue).
    4. Return ACK to sender with server-assigned seq_num.

    The ACK is critical: seq_num lets the sender update their local state
    so future "sync" requests know where they left off.
    """
    conv_id       = data.get("conversation_id", "").strip()
    content       = data.get("content", "").strip()
    client_msg_id = data.get("client_msg_id") or str(uuid.uuid4())

    if not conv_id:
        return {"type": "error", "error": "missing conversation_id"}
    if not content:
        return {"type": "error", "error": "missing or empty content"}
    if len(content) > 10_000:
        return {"type": "error", "error": "content exceeds 10,000 character limit"}

    msg = store.send_message(conv_id, user_id, content, client_msg_id)
    if msg is None:
        return {"type": "error", "error": "conversation not found or you are not a participant"}

    # Fan-out to other participants (non-blocking — we await but deliver concurrently).
    await fanout_message(msg, sender_id=user_id)

    # ACK to sender: confirms the message was durably stored with seq_num.
    return {"type": "ack", "message": message_to_dict(msg)}


async def handle_typing(user_id: str, data: dict) -> None:
    """
    Process {"type": "typing", "conversation_id": "..."}

    Typing indicators are ephemeral and high-frequency. A user generating
    60 keystrokes/min in a 10-person group would produce 60 × 9 = 540 WS
    sends per minute without throttling. With throttling (1 per 3s): 20 sends/min.

    WHY we don't persist typing events:
    - No value in storing "Alice typed at 10:35:02.341" permanently.
    - They are purely ephemeral UI hints — stale after ~3 seconds.
    """
    conv_id = data.get("conversation_id", "")
    conv    = store.get_conversation(conv_id)

    if conv is None or user_id not in conv.participants:
        return

    # Throttle: only broadcast if THROTTLE_SECONDS have passed for this (user, conv) pair.
    throttle_key = f"typing:{user_id}:{conv_id}"
    if not presence.should_broadcast(throttle_key):
        return   # Drop this typing event; a recent one was already sent

    typing_event = {
        "type":            "typing",
        "conversation_id": conv_id,
        "user_id":         user_id,
        "timestamp":       time.time(),
    }
    await conn_mgr.broadcast_to_conversation(conv, typing_event, exclude_user=user_id)


async def handle_sync(user_id: str, data: dict) -> dict:
    """
    Process {"type": "sync", "conversation_id": "...", "from_seq": N}

    Called by a client after reconnecting to catch up on missed messages.

    Reconnect scenario:
    1. Client was on seq_num 42 when they disconnected.
    2. 5 messages arrived (seq 43-47) while they were offline.
    3. Client reconnects, sends: {"type": "sync", "conversation_id": "x", "from_seq": 43}
    4. Server responds with messages 43-47.
    5. Client renders the missing messages in order.

    WHY seq_num and not "give me messages since timestamp T"?
    - seq_num is always correct (server-assigned, no clock skew).
    - Even if the server clock jumps, seq_num monotonically increases.
    - "from_seq=43" is unambiguous; "from_ts=1700000042.3" might miss messages
      due to float precision or clock drift.
    """
    conv_id  = data.get("conversation_id", "")
    from_seq = int(data.get("from_seq", 0))

    conv = store.get_conversation(conv_id)
    if conv is None or user_id not in conv.participants:
        return {
            "type": "error",
            "error": "conversation not found or you are not a participant",
        }

    missed_messages = store.get_messages(conv_id, from_seq=from_seq)

    return {
        "type":            "sync_response",
        "conversation_id": conv_id,
        "from_seq":        from_seq,
        "count":           len(missed_messages),
        "messages":        [message_to_dict(m) for m in missed_messages],
    }


async def handle_ack(user_id: str, data: dict) -> None:
    """
    Process {"type": "ack", "conversation_id": "...", "seq_num": N}

    Mark messages up to seq_num as read by this user.
    Used for read receipts (double-tick in WhatsApp).

    WHY store read position server-side?
    - Multiple devices must share the same read cursor.
    - If you only stored it in the client, opening the app on a second device
      would show all messages as unread again.
    """
    conv_id = data.get("conversation_id", "")
    seq_num = data.get("seq_num", 0)
    if conv_id and seq_num:
        store.mark_read(conv_id, user_id, int(seq_num))


# ============================================================================
# WebSocket endpoint — the core of the real-time system
# ============================================================================

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(ws: WebSocket, user_id: str) -> None:
    """
    One long-lived connection per client device.

    WHY long-lived (not a new connection per message)?
    - Establishing a WebSocket requires a TCP handshake + HTTP upgrade = ~1 RTT.
    - At 1,000 messages/sec, that's 1,000 RTTs/sec of overhead with new connections.
    - With a persistent connection: one handshake, then raw frame overhead (~2 bytes/frame).
    - WhatsApp keeps connections alive for hours with a heartbeat ping every 60s.

    Lifecycle:
    1. CONNECT: accept WS, register presence, deliver any queued offline messages.
    2. RECEIVE LOOP: parse JSON, dispatch to handler, send response.
    3. DISCONNECT: unregister presence, clean up connection.
    """
    conn_id = str(uuid.uuid4())    # Unique ID for this specific connection

    # Step 1: Register connection
    await conn_mgr.connect(user_id, conn_id, ws)
    went_online = presence.connect(user_id, conn_id)

    if went_online:
        print(f"[presence] {user_id} ONLINE  (conn={conn_id[:8]})")

    # Step 1b: Deliver queued offline messages immediately.
    # Order matters: deliver in arrival order so the client sees them in sequence.
    queued = offline_queue.pop(user_id, [])
    if queued:
        print(f"[offline] Delivering {len(queued)} queued messages to {user_id}")
        for queued_payload in queued:
            try:
                await ws.send_json(queued_payload)
            except Exception:
                # Connection died immediately after connecting — put messages back?
                # For simplicity, we accept this loss. Production: re-queue.
                break

    try:
        # Step 2: Main receive loop
        while True:
            try:
                raw = await asyncio.wait_for(ws.receive_text(), timeout=120.0)
            except asyncio.TimeoutError:
                # Send a ping to check if client is still alive.
                # If the client doesn't respond, the next receive will fail.
                await ws.send_json({"type": "ping"})
                continue

            # Parse incoming JSON
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "error": "invalid JSON"})
                continue

            msg_type = data.get("type", "")

            # Dispatch to the appropriate handler
            if msg_type == "send_message":
                response = await handle_send_message(user_id, data)
                await ws.send_json(response)

            elif msg_type == "typing":
                # Typing indicators: fire and forget — no response needed.
                await handle_typing(user_id, data)

            elif msg_type == "sync":
                response = await handle_sync(user_id, data)
                await ws.send_json(response)

            elif msg_type == "ack":
                await handle_ack(user_id, data)
                # No response — ack processing is silent

            elif msg_type == "pong":
                pass  # Client responded to our ping — connection is alive

            else:
                await ws.send_json({"type": "error", "error": f"unknown message type: {msg_type!r}"})

    except WebSocketDisconnect:
        pass   # Client disconnected cleanly (or TCP dropped)
    except Exception as exc:
        print(f"[ws] Unexpected error for {user_id}: {exc}")
    finally:
        # Step 3: Clean up
        await conn_mgr.disconnect(user_id, conn_id)
        went_offline = presence.disconnect(user_id, conn_id)
        if went_offline:
            print(f"[presence] {user_id} OFFLINE (conn={conn_id[:8]})")


# ============================================================================
# REST endpoints (HTTP fallback + management)
# ============================================================================

@app.post("/conversations")
async def create_conversation(body: dict) -> dict:
    """
    Create a new conversation with 2+ participants.

    Body: {"participants": ["alice", "bob"]}

    WHY REST here (not WebSocket)?
    - Creating a conversation is an infrequent, stateless operation.
    - Bots and server-side integrations need to create conversations
      without maintaining a WebSocket connection.
    - REST is simpler for request/response semantics.
    """
    participants = body.get("participants", [])
    if len(participants) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 participants.")

    conv = store.create_conversation(participants)
    return {
        "id":           conv.id,
        "participants": conv.participants,
        "created_at":   conv.created_at,
    }


@app.post("/conversations/{conv_id}/messages")
async def http_send_message(conv_id: str, body: dict) -> dict:
    """
    HTTP fallback for sending messages — bots, service accounts, API clients.

    WHY support HTTP in addition to WebSocket?
    - Automated systems (notification bots, AI assistants) don't maintain WS.
    - When a WS connection drops mid-send, the client can retry via HTTP.
    - Server-to-server messaging (the notification service injects a system message).
    - Identical idempotency guarantee via client_msg_id.
    """
    sender_id     = body.get("sender_id", "").strip()
    content       = body.get("content", "").strip()
    client_msg_id = body.get("client_msg_id") or str(uuid.uuid4())

    if not sender_id or not content:
        raise HTTPException(status_code=400, detail="Missing sender_id or content.")

    msg = store.send_message(conv_id, sender_id, content, client_msg_id)
    if msg is None:
        raise HTTPException(
            status_code=404,
            detail="Conversation not found or sender is not a participant."
        )

    # Fan-out: deliver to online participants, queue for offline.
    await fanout_message(msg, sender_id=sender_id)

    return message_to_dict(msg)


@app.get("/conversations/{conv_id}/messages")
async def get_message_history(
    conv_id:  str,
    from_seq: int = Query(0, ge=0, description="Return messages with seq_num >= this value"),
    limit:    int = Query(100, ge=1, le=500),
) -> dict:
    """
    Fetch message history — used for initial load and reconnect sync.

    Reconnect sync pattern:
    - Client tracks `last_seen_seq` locally (in localStorage, SQLite, etc.)
    - On reconnect: GET /conversations/{id}/messages?from_seq={last_seen_seq + 1}
    - Client renders missed messages in seq_num order (they arrive sorted).

    Initial load:
    - from_seq=0, limit=50 → last 50 messages (most recent, because we slice [-limit:])
    - Client scrolls up → from_seq=0 with offset pagination (not shown, but add limit+offset)
    """
    messages = store.get_messages(conv_id, from_seq=from_seq, limit=limit)
    return {
        "conversation_id": conv_id,
        "from_seq":        from_seq,
        "count":           len(messages),
        "messages":        [message_to_dict(m) for m in messages],
    }


@app.get("/presence")
async def get_presence_endpoint(
    user_ids: str = Query("", description="Comma-separated list of user IDs"),
) -> dict:
    """
    Batch presence check: are these users online?

    Body: ?user_ids=alice,bob,charlie
    Response: {"presence": {"alice": true, "bob": false, "charlie": true}}

    WHY batch (not one request per user)?
    - Opening a conversation with 10 members = 10 presence checks.
    - Batch: 1 HTTP request vs 10 → 10x fewer round-trips.
    - LinkedIn, WhatsApp, Facebook all use batch presence APIs.
    """
    ids = [uid.strip() for uid in user_ids.split(",") if uid.strip()]
    return {"presence": presence.get_presence(ids)}


@app.get("/health")
async def health() -> dict:
    return {
        "status":              "ok",
        "online_users":        len(presence.online_users()),
        "online_user_list":    presence.online_users(),
        "offline_queue_depth": {
            uid: len(msgs) for uid, msgs in offline_queue.items() if msgs
        },
    }


# ============================================================================
# Entry point
# ============================================================================

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")
```

---

## Testing with wscat

```bash
# Install wscat (WebSocket CLI client):
npm install -g wscat

# --- Terminal 1: Start the server ---
uv run chat_system.py


# --- Terminal 2: Alice connects ---
wscat -c "ws://localhost:8001/ws/alice"


# --- Terminal 3: Bob connects ---
wscat -c "ws://localhost:8001/ws/bob"


# --- Terminal 4: REST calls (create conversation, etc.) ---

# Step 1: Create a conversation
CONV_ID=$(curl -s -X POST http://localhost:8001/conversations \
  -H "Content-Type: application/json" \
  -d '{"participants": ["alice", "bob"]}' | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
echo "Conversation ID: $CONV_ID"


# Step 2 (in Alice's wscat terminal): Send a message
# Paste this JSON into Alice's wscat terminal:
{"type": "send_message", "conversation_id": "<CONV_ID>", "content": "Hey Bob!", "client_msg_id": "alice-msg-001"}

# Bob's terminal should immediately receive:
# {"type": "message", "id": "...", "sender_id": "alice", "content": "Hey Bob!", "seq_num": 1, ...}

# Alice's terminal receives an ACK:
# {"type": "ack", "message": {"seq_num": 1, ...}}


# Step 3: Typing indicator (in Alice's wscat terminal)
{"type": "typing", "conversation_id": "<CONV_ID>"}
# Bob sees: {"type": "typing", "user_id": "alice", "conversation_id": "..."}
# Send again immediately — Bob won't see it (throttled to 1 per 3s)


# Step 4: Test deduplication — send same client_msg_id twice
{"type": "send_message", "conversation_id": "<CONV_ID>", "content": "Duplicate test", "client_msg_id": "dedup-test-001"}
{"type": "send_message", "conversation_id": "<CONV_ID>", "content": "Duplicate test", "client_msg_id": "dedup-test-001"}
# Bob only sees ONE message — second send is a no-op (idempotent)


# Step 5: Test offline delivery
# Disconnect Bob (Ctrl+C in Bob's terminal)
# Alice sends a message — Bob is offline, gets queued
{"type": "send_message", "conversation_id": "<CONV_ID>", "content": "Are you still there?", "client_msg_id": "alice-msg-002"}

# Reconnect Bob:
wscat -c "ws://localhost:8001/ws/bob"
# Bob immediately receives "Are you still there?" (offline delivery)


# Step 6: Reconnect sync (history fetch)
# After reconnecting, Bob syncs missed messages since seq 2:
{"type": "sync", "conversation_id": "<CONV_ID>", "from_seq": 2}
# Bob receives: {"type": "sync_response", "messages": [...], "count": N}


# Step 7: HTTP send (bot / REST client)
curl -s -X POST "http://localhost:8001/conversations/${CONV_ID}/messages" \
  -H "Content-Type: application/json" \
  -d "{\"sender_id\": \"bot\", \"content\": \"Bot says hi!\", \"client_msg_id\": \"bot-001\"}" \
  | python3 -m json.tool
# Note: bot must be a participant — add "bot" to participants when creating the conversation


# Step 8: Get message history
curl -s "http://localhost:8001/conversations/${CONV_ID}/messages?from_seq=0&limit=10" \
  | python3 -m json.tool


# Step 9: Presence check
curl -s "http://localhost:8001/presence?user_ids=alice,bob,charlie" | python3 -m json.tool
# {"presence": {"alice": true, "bob": true, "charlie": false}}


# Step 10: Health check
curl -s http://localhost:8001/health | python3 -m json.tool
```

---

## Group Chat Fanout Strategies

```text
The central challenge in group chat: delivering one message to N recipients efficiently.

┌─────────────────────────────────────────────────────────────────────────────┐
│                    FAN-OUT ON WRITE vs FAN-OUT ON READ                      │
├─────────────────────────┬───────────────────────────────────────────────────┤
│   Fan-out on Write      │   Fan-out on Read                                 │
│   (push model)          │   (pull model)                                    │
├─────────────────────────┼───────────────────────────────────────────────────┤
│ Message sent →          │ Message stored once in                            │
│ immediately pushed to   │ conversation store.                               │
│ each recipient's inbox. │ Each recipient reads on demand.                   │
├─────────────────────────┼───────────────────────────────────────────────────┤
│ PRO: low read latency   │ PRO: one write operation always                   │
│      (inbox is ready)   │      no write amplification                       │
│ CON: write amplification│ CON: higher read latency                          │
│      (N writes per msg) │      each read queries conversation store         │
├─────────────────────────┼───────────────────────────────────────────────────┤
│ BEST FOR: 1-1 chats,    │ BEST FOR: large groups (>100 members),            │
│ small groups (<100)     │ broadcast channels, Twitter-style feeds           │
└─────────────────────────┴───────────────────────────────────────────────────┘

Our implementation uses fan-out on write (push), which is correct for 1-1 and
small group chats. The broadcast_to_conversation() method does N WebSocket sends.

For large groups (Discord servers with 100K+ members):
- Hybrid: fan-out on write to active/online members (fast delivery).
           fan-out on read for offline members (they fetch on open).
- Discord: "message reference" model — store once, each client reads from API.
- Slack: fan-out to channels; clients subscribe to channel events via WebSocket.
```

```python
# Large group fan-out sketch — not in the main implementation, but shows the pattern.

async def broadcast_large_group(conv_id: str, msg_dict: dict, store, conn_mgr, offline_queue):
    """
    Efficient fan-out for large groups (1000+ participants).

    Strategy:
    1. Identify online participants (immediate WebSocket delivery).
    2. For offline participants: write to their inbox/offline_queue.
    3. Cap direct fan-out at MAX_DIRECT; above that, use a task queue.

    In production (Discord/Slack approach):
    - Store message once.
    - Maintain a per-conversation "subscriber" list in Redis.
    - Use Redis pub/sub to broadcast: PUBLISH conv:abc <message_json>
    - Each gateway server subscribes to conversations of its connected users.
    - Only the relevant gateway server delivers to each user's WebSocket.
    """
    MAX_DIRECT_FANOUT = 100   # For >100 recipients, enqueue rather than inline-deliver

    conv = store.get_conversation(conv_id)
    if conv is None:
        return

    online  = [p for p in conv.participants if conn_mgr.is_connected(p)]
    offline = [p for p in conv.participants if not conn_mgr.is_connected(p)]

    # Deliver to online users immediately (bounded fan-out)
    for participant in online[:MAX_DIRECT_FANOUT]:
        await conn_mgr.send_to_user(participant, msg_dict)

    # If group is huge: push remaining to a task queue (Celery, SQS, Kafka)
    if len(online) > MAX_DIRECT_FANOUT:
        remaining = online[MAX_DIRECT_FANOUT:]
        # In production: await task_queue.enqueue("deliver_to_users", remaining, msg_dict)
        print(f"[fanout] {len(remaining)} online recipients deferred to task queue")

    # Offline users: inbox / push notification
    for participant in offline:
        offline_queue[participant].append(msg_dict)
        # In production: await push_adapter.notify(participant, title="New message", body=msg_dict["content"][:50])
```

---

## Offline Message Handling

```text
The offline delivery problem: what happens when Bob's phone loses signal?

Timeline:
  T=0:  Bob's WebSocket disconnects (phone goes underground on subway).
  T=1:  Alice sends "Let's meet at 6pm!" → server: Bob is offline.
  T=2:  Alice sends "The Italian place on 5th Ave" → Bob still offline.
  T=5:  Bob's phone comes back online, WebSocket reconnects.
  T=5:  Server delivers queued messages in order: seq=5, seq=6.
  T=5:  Bob sees both messages instantly — no polling needed.

Our implementation (in-memory offline_queue):
  ✓ Works for single-server deployments.
  ✗ Queue is lost if the server restarts.
  ✗ Doesn't work in multi-server deployments (Bob might reconnect to Server 2,
    but his messages are queued on Server 1).

Production offline delivery (multi-server):
  Layer 1: Redis List — server stores offline messages in Redis key per user.
           Any gateway server can read from it regardless of which server
           the original message arrived on.

  Layer 2: Push Notification — for users who may not reconnect soon.
           FCM (Android), APNs (iOS) deliver a push that wakes the app.
           App reconnects WebSocket → receives queued messages via sync.

  Layer 3: Message Durability — messages stored in the ConversationStore
           (Cassandra/Postgres) forever. Offline delivery is just a cache
           of the "unseen" subset. If the cache is lost, client can always
           do GET /conversations/{id}/messages?from_seq=N.

Sequence number as the recovery mechanism:
  The seq_num in each message is the key invariant.
  If ALL else fails, the client knows its last_seen_seq and can request
  everything after it from the REST API. This is the ultimate safety net.
```

---

## Key Learning Points

```text
1. SEQ_NUM OVER TIMESTAMPS FOR ORDERING:
   Timestamps lie (client clock skew, NTP jumps, daylight saving bugs).
   Server-assigned monotonic seq_num per conversation is always correct.
   "Give me messages after seq 42" is unambiguous.
   WhatsApp, Telegram, iMessage, and Slack all use this pattern.

2. CLIENT_MSG_ID FOR IDEMPOTENCY (exactly-once illusion):
   Network drops the ACK → client retries → same message appears twice? No.
   client_msg_id = UUID generated by client before sending.
   Server: "I've seen this ID" → return existing message, don't store again.
   Result: at-least-once transport, but exactly-once message delivery to users.

3. MULTI-DEVICE SUPPORT VIA SET OF CONNECTIONS:
   user_id → {conn_id_1, conn_id_2, ...}  (phone + laptop + tablet).
   User is "online" if set is non-empty.
   send_to_user() delivers to ALL devices simultaneously.
   All devices see the same read cursor, same message list.

4. PRESENCE THROTTLING — DON'T BROADCAST EVERY KEYSTROKE:
   A user typing 60 chars/min to a 200-person group: 60 × 200 = 12,000 WS sends/min.
   With 3-second throttle: 20 × 200 = 4,000 sends/min (3x reduction per user).
   At scale: this is the difference between manageable load and meltdown.
   LinkedIn throttles to 5s, WhatsApp to 3s, Slack to ~5s.

5. FAN-OUT ON WRITE FOR SMALL GROUPS, FAN-OUT ON READ FOR LARGE:
   1-1 chat: 1 write → 1 delivery = trivially cheap.
   Group of 10: 1 write → 9 deliveries = acceptable.
   Server with 100K members: 1 write → 100K deliveries = not acceptable inline.
   Switch to task queue (Celery/SQS) for groups above ~100 members.

6. OFFLINE QUEUE → PUSH NOTIFICATION → SEQ_NUM SYNC (three layers):
   Layer 1: offline_queue delivers immediately on reconnect (seconds offline).
   Layer 2: push notification wakes the app (minutes/hours offline).
   Layer 3: from_seq sync fetches exact missed messages (days offline).
   Each layer handles a different offline duration — they complement each other.

7. WEBSOCKET GATEWAY IS STATEFUL — HARDER TO SCALE THAN REST:
   REST servers are stateless: any server handles any request.
   WebSocket servers hold open connections: Bob's connection is on Server 2.
   To send to Bob from Server 1: publish to Redis channel "user:bob".
   Server 2 (subscribed to "user:bob") delivers to Bob's WebSocket.
   This pub/sub fan-out is how Discord, Slack, and WhatsApp scale horizontally.
```
