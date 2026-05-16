# Design WhatsApp (Comprehensive)

## 1) Intuition
WhatsApp is fundamentally a **connection management + reliable message delivery** problem.

The two hardest parts:
1. **Scale of persistent connections:** 2B users with persistent WebSocket connections. At any given time, ~500M are online. Managing this many long-lived TCP connections is the main infra challenge.
2. **Delivery guarantees for offline users:** A message sent to an offline user must be queued durably and delivered when they reconnect — no matter how long (days, weeks).

Real-world analogy: WhatsApp is like a postal system where:
- Every person has a dedicated phone line that rings the moment a message arrives (WebSocket connection)
- If you're not home, messages are stored in a box at the post office (offline queue)
- The box is emptied the moment you pick up the phone again (reconnect sync)
- But group chats are like broadcasting to a room of 1000 people — much harder

---

## 2) Functional Requirements
- 1:1 messaging (text, images, videos, audio, files, locations)
- Group messaging (up to 1024 members)
- Delivery receipts: sent ✓, delivered ✓✓, read ✓✓ (blue)
- Presence status: online, last seen
- Push notifications for offline users
- End-to-end encryption (E2E)
- Voice and video calls
- Media storage with link sharing

---

## 3) Non-Functional Requirements
- **Message delivery guarantee:** At-least-once delivery; exactly-once display via dedup
- **Send latency:** P95 < 100ms (online recipient)
- **Availability:** 99.99%
- **Scale:** 2B registered users, 500M DAU, 100B messages/day
- **Connection scale:** 500M concurrent WebSocket connections
- **E2E encryption:** Server never sees plaintext

---

## 4) Capacity Estimation

```python
whatsapp_scale = {
    # Users
    "registered_users": 2_000_000_000,
    "DAU": 500_000_000,
    "concurrent_connections": 100_000_000,  # At any given time (20% of DAU)
    
    # Messages
    "messages_per_day": 100_000_000_000,    # 100B
    "messages_per_second_avg": 1_157_407,   # 100B / 86400
    "messages_per_second_peak": 3_500_000,  # 3x peak
    
    # Message size (text only)
    "avg_text_message_bytes": 100,          # Typical short text
    "text_ingress_gbps": (1_157_407 * 100) / (1024**3) * 8,  # ~0.86 Gbps
    
    # Media
    "percent_messages_with_media": 0.10,    # 10% have photos/videos
    "avg_media_size_mb": 2,                 # Compressed before send
    "media_ingress_gbps": (1_157_407 * 0.1 * 2 * 1024 * 1024) / (1024**3) * 8,  # ~17 Gbps
    
    # Connections (the big infra problem)
    "connections_per_chat_server": 500_000,
    "chat_servers_needed": 100_000_000 / 500_000,  # 200 servers minimum!
    "why_hard": "100M long-lived WebSocket connections, each maintaining TCP state"
}

group_chat = {
    "max_group_size": 1024,
    "avg_group_size": 10,
    "groups_per_user": 20,
    
    # Worst case: large active group
    "group_message_fanout": 1024,  # Message must be delivered to 1024 members
    "active_large_groups": 10_000,
    "messages_per_group_per_day": 100,
    "fanout_writes_per_day": 10_000 * 100 * 1024,  # 1B fanout writes/day just from large groups
}
```

---

## 5) Protocol Design (WebSocket + Custom Signaling)

### Connection setup
```text
Client connects:
1. TCP handshake
2. TLS 1.3 handshake (mTLS: server verifies client certificate = phone verification)
3. WebSocket upgrade (HTTP -> WS)
4. Authentication (JWT derived from Signal protocol registration)
5. Session registration: chat server learns "user_123 is connected to server chat-42"

After connection:
- Heartbeat: client sends PING every 30 seconds, server responds PONG
- If no PING in 90 seconds: server marks user offline, closes connection
- Reconnect: client immediately reconnects, receives all queued messages
```

### Message format (simplified, real WA uses Protocol Buffers)
```python
# WhatsApp uses Protocol Buffers for efficiency (~50% smaller than JSON)
# Shown here as Python dict for clarity

OUTGOING_MESSAGE = {
    "id": "msg_abc123",          # Client-generated UUID (idempotency)
    "type": "TEXT",              # TEXT, IMAGE, VIDEO, AUDIO, DOC, LOCATION
    "from": "user_alice",
    "to": "user_bob",            # Or "group_xyz" for groups
    "timestamp_client_ms": 1705310400000,
    
    # E2E encrypted payload (server never sees the plaintext below)
    "ciphertext": "base64_encrypted_bytes...",
    "cipher_type": "signal_protocol",
    
    # Only for media: pre-uploaded to WhatsApp media servers
    "media_key": "media_key_xyz",  # Server-side media identifier
    
    # Routing metadata (NOT encrypted - server needs this to route)
    "routing": {
        "to_user_id": "user_bob",
        "to_group_id": None
    }
}

DELIVERY_RECEIPT = {
    "type": "RECEIPT",
    "for_message_id": "msg_abc123",
    "status": "DELIVERED",  # "SENT", "DELIVERED", "READ"
    "user_id": "user_bob",
    "timestamp_ms": 1705310405000
}
```

---

## 6) Data Model

```sql
-- Users
CREATE TABLE users (
    id           VARCHAR(20) PRIMARY KEY,  -- Phone number hash or UUID
    phone_hash   VARCHAR(64) UNIQUE NOT NULL,  -- SHA-256 of phone, for contact discovery
    display_name VARCHAR(50),
    status_text  VARCHAR(139),
    last_seen    TIMESTAMP,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Messages (hot table: ~100B rows/day added)
-- Sharded by (conversation_id, message_id) using Cassandra or HBase
-- Partition key: conversation_id (all messages in a chat go to same shard)
-- Clustering key: message_id (time-sortable, used for range queries)
CREATE TABLE messages (
    conversation_id  VARCHAR(40) NOT NULL,   -- "user_alice:user_bob" or "group_xyz"
    message_id       VARCHAR(40) NOT NULL,   -- UUID (client-generated)
    sender_id        VARCHAR(20) NOT NULL,
    ciphertext       TEXT NOT NULL,          -- E2E encrypted, server can't read
    message_type     VARCHAR(10) NOT NULL,   -- 'TEXT', 'IMAGE', 'VIDEO', etc.
    media_key        VARCHAR(100),           -- Non-null for media messages
    sent_at          TIMESTAMP NOT NULL,
    PRIMARY KEY (conversation_id, message_id)
) WITH CLUSTERING ORDER BY (message_id ASC);
-- Secondary index on sent_at for range queries

-- Message status (delivery tracking)
-- High write volume: DELIVERED + READ receipt for every message
CREATE TABLE message_status (
    message_id   VARCHAR(40) NOT NULL,
    user_id      VARCHAR(20) NOT NULL,  -- Recipient
    status       VARCHAR(10) NOT NULL,  -- 'SENT', 'DELIVERED', 'READ'
    updated_at   TIMESTAMP NOT NULL,
    PRIMARY KEY (message_id, user_id)
);

-- Offline message queue (messages waiting for offline users)
-- Redis: RPUSH "offline:{user_id}" message_json + EXPIRE 30 days
-- Or dedicated message queue (SQS/Kafka partition per user)
CREATE TABLE offline_queue (
    user_id      VARCHAR(20) NOT NULL,
    message_id   VARCHAR(40) NOT NULL,
    payload      TEXT NOT NULL,         -- Full message JSON
    queued_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMP NOT NULL,    -- queued_at + 30 days
    PRIMARY KEY (user_id, queued_at, message_id)
);

-- Groups
CREATE TABLE groups (
    id           VARCHAR(40) PRIMARY KEY,
    name         VARCHAR(100) NOT NULL,
    description  VARCHAR(500),
    icon_url     VARCHAR(500),
    created_by   VARCHAR(20) NOT NULL,
    max_members  INTEGER DEFAULT 1024,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Group members (sharded by group_id)
CREATE TABLE group_members (
    group_id     VARCHAR(40) NOT NULL,
    user_id      VARCHAR(20) NOT NULL,
    role         VARCHAR(10) NOT NULL DEFAULT 'MEMBER',  -- 'ADMIN', 'MEMBER'
    joined_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_members_user ON group_members(user_id);
```

---

## 7) High-Level Design (HLD)

```text
Mobile Client (iOS/Android)
    |
    v  [TLS + WebSocket]
[Load Balancer / Connection Broker]   <- Sticky sessions (same LB for reconnects)
    |
    +---> [Chat Server Fleet]          <- 200+ servers, each holds 500K WebSocket conns
              |
              +---> [Presence Service]  <- In-memory + Redis: who is online?
              |
              +---> [Message Router]    <- Where is the recipient's connection?
              |
              +---> [Message Store]     <- Cassandra (100B rows/day)
              |
              +---> [Offline Queue]     <- Redis (messages for offline users)
              |
              +---> [Push Notification] <- APNs (iOS) / FCM (Android) for offline
    
[Media Service]  <- Separate from chat; handles media upload/download
    |
    v
[Object Store (S3)] -> [CDN]          <- Media reads via CDN

[Group Service]  <- Handles group membership queries
```

---

## 8) Core Chat Flow

### Sending a message (1:1)
```python
class ChatServer:
    """
    One chat server holds ~500K persistent WebSocket connections.
    Horizontally scaled: 200 servers = 100M concurrent connections.
    """
    
    def __init__(self, server_id: str):
        self.server_id = server_id
        # In-process connection map: user_id -> WebSocket
        self.connections: dict = {}
        self.message_store = MessageStore()
        self.presence_service = PresenceService()
        self.router = MessageRouter()
        self.offline_queue = OfflineQueue()
        self.push_service = PushNotificationService()
    
    async def on_connect(self, websocket, user_id: str) -> None:
        # Register connection
        self.connections[user_id] = websocket
        
        # Announce presence
        await self.presence_service.set_online(user_id, self.server_id)
        
        # Deliver queued messages (offline catch-up)
        await self._deliver_offline_messages(user_id, websocket)
    
    async def on_disconnect(self, user_id: str) -> None:
        del self.connections[user_id]
        await self.presence_service.set_offline(user_id)
    
    async def handle_send_message(self, sender_id: str, msg: dict) -> None:
        """
        Called when client sends a message via WebSocket.
        """
        # 1. Idempotency check (duplicate suppression)
        if await self.message_store.exists(msg["id"]):
            # Already processed, just re-send ACK
            await self._ack(sender_id, msg["id"], "SENT")
            return
        
        # 2. Persist message (before routing)
        await self.message_store.save(msg)
        
        # 3. ACK to sender: "server received your message"
        await self._ack(sender_id, msg["id"], "SENT")
        
        # 4. Route to recipient
        recipient_id = msg["routing"]["to_user_id"]
        await self._route_to_recipient(recipient_id, msg)
    
    async def _route_to_recipient(self, recipient_id: str, msg: dict) -> None:
        # Check if recipient is online and on which server
        location = await self.presence_service.get_location(recipient_id)
        
        if location is None:
            # User is offline: queue for later delivery
            await self.offline_queue.enqueue(recipient_id, msg, ttl_days=30)
            await self.push_service.send_push(recipient_id, msg)
            return
        
        if location["server_id"] == self.server_id:
            # Recipient is on this same server
            ws = self.connections.get(recipient_id)
            if ws:
                await ws.send_json(msg)
                # Recipient's client will send DELIVERED receipt back
        else:
            # Recipient is on a different chat server
            await self._forward_to_server(location["server_id"], recipient_id, msg)
    
    async def _deliver_offline_messages(self, user_id: str, websocket) -> None:
        """
        When user reconnects, drain their offline queue.
        Order is preserved (FIFO queue per user).
        """
        queued = await self.offline_queue.dequeue_all(user_id)
        
        if not queued:
            return
        
        # Send in batches to avoid overwhelming client
        BATCH_SIZE = 100
        for i in range(0, len(queued), BATCH_SIZE):
            batch = queued[i:i + BATCH_SIZE]
            await websocket.send_json({
                "type": "MESSAGE_BATCH",
                "messages": batch,
                "has_more": i + BATCH_SIZE < len(queued)
            })
        
        await self.offline_queue.clear(user_id)
    
    async def _ack(self, user_id: str, message_id: str, status: str) -> None:
        ws = self.connections.get(user_id)
        if ws:
            await ws.send_json({
                "type": "ACK",
                "message_id": message_id,
                "status": status,
                "timestamp_ms": int(time.time() * 1000)
            })
```

### Cross-server message routing
```python
class MessageRouter:
    """
    Routes messages between chat servers using internal pub/sub.
    Uses Redis Pub/Sub or Kafka for cross-server delivery.
    """
    
    async def forward_to_server(
        self, target_server_id: str, recipient_id: str, msg: dict
    ) -> None:
        # Publish to the target server's channel
        channel = f"chat_server:{target_server_id}"
        await self.redis.publish(channel, json.dumps({
            "recipient_id": recipient_id,
            "message": msg
        }))
    
    async def subscribe_to_own_channel(self, server_id: str, chat_server) -> None:
        """
        Each chat server subscribes to its own Redis channel.
        Messages from other servers arrive here.
        """
        channel = f"chat_server:{server_id}"
        async for message in self.redis.subscribe(channel):
            data = json.loads(message["data"])
            recipient_id = data["recipient_id"]
            msg = data["message"]
            
            ws = chat_server.connections.get(recipient_id)
            if ws:
                await ws.send_json(msg)
            else:
                # Recipient disconnected between presence check and delivery
                await chat_server.offline_queue.enqueue(recipient_id, msg)
```

---

## 9) Group Messaging

```python
class GroupMessageHandler:
    """
    Group chat fanout strategy.
    Unlike Twitter fanout (push to all follower timelines),
    group messages must be reliably delivered to all members.
    """
    
    async def handle_group_message(self, sender_id: str, group_id: str, msg: dict) -> None:
        # 1. Get group members
        members = await self.group_service.get_members(group_id)
        
        # 2. Save message once (single copy for all group members)
        await self.message_store.save_group_message(group_id, msg)
        
        # 3. ACK to sender
        await self._ack(sender_id, msg["id"], "SENT")
        
        # 4. Fan out to all members except sender
        recipients = [m for m in members if m != sender_id]
        
        if len(recipients) <= 100:
            # Small group: deliver synchronously to all online members
            await asyncio.gather(*[
                self._deliver_to_member(recipient_id, msg)
                for recipient_id in recipients
            ])
        else:
            # Large group: enqueue in background workers
            await self.fanout_queue.enqueue_bulk(recipients, msg)
    
    async def _deliver_to_member(self, user_id: str, msg: dict) -> None:
        location = await self.presence_service.get_location(user_id)
        
        if location:
            await self.router.forward_to_server(location["server_id"], user_id, msg)
        else:
            await self.offline_queue.enqueue(user_id, msg)
            await self.push_service.send_push(user_id, msg)
    
    # Group message read receipts: much more complex
    # Blue ticks only show when ALL members have read the message
    async def get_group_read_status(self, message_id: str, group_id: str) -> dict:
        members = await self.group_service.get_members(group_id)
        statuses = await self.message_status.get_all(message_id, members)
        
        return {
            "total_members": len(members),
            "delivered_to": len([s for s in statuses if s["status"] in ("DELIVERED", "READ")]),
            "read_by": len([s for s in statuses if s["status"] == "READ"]),
            "all_delivered": all(s["status"] in ("DELIVERED", "READ") for s in statuses),
            "all_read": all(s["status"] == "READ" for s in statuses)
        }
```

### Large group fanout optimization
```text
Problem: Group with 1024 members. 100 messages/day.
         Naive fanout: 100 * 1024 = 102,400 deliveries per group per day.
         Across 10,000 active large groups: 1B deliveries/day.

Optimization strategies:
1. Don't fan out to offline users in real-time
   - Skip offline users during fanout
   - When they reconnect: fetch all group messages since last_seen
   - "Catch-up query" instead of delivery: SELECT * FROM messages WHERE group_id=? AND sent_at > last_seen

2. Message store is shared (single copy per group message)
   - Don't store 1024 copies of the same message
   - Store ONE message + read status table (1024 rows per message)
   - This is WA's actual architecture

3. Hot group sharding
   - Popular groups have partition affinity: route all members of group_xyz to same cluster region
   - Reduces cross-datacenter traffic for group messages
```

---

## 10) Presence Service

```python
class PresenceService:
    """
    Tracks who is online, on which server, and last seen time.
    
    Scale challenge: 100M concurrent connections = 100M presence updates
    every ~30 seconds (heartbeat-driven). That's ~3M presence events/second.
    
    Architecture:
    - In-process: each chat server keeps local set of connected user_ids
    - Distributed: Redis Cluster for cross-server lookups
    - Privacy: last_seen can be hidden by user preference
    """
    
    ONLINE_TTL_SECONDS = 90  # Mark offline if no heartbeat in 90 seconds
    
    async def set_online(self, user_id: str, server_id: str) -> None:
        pipe = self.redis.pipeline()
        pipe.hset(f"presence:{user_id}", mapping={
            "status": "online",
            "server_id": server_id,
            "last_heartbeat": int(time.time())
        })
        pipe.expire(f"presence:{user_id}", self.ONLINE_TTL_SECONDS)
        await pipe.execute()
    
    async def heartbeat(self, user_id: str) -> None:
        """Called every 30 seconds when client sends PING."""
        await self.redis.hset(f"presence:{user_id}", "last_heartbeat", int(time.time()))
        await self.redis.expire(f"presence:{user_id}", self.ONLINE_TTL_SECONDS)
    
    async def set_offline(self, user_id: str) -> None:
        last_seen = int(time.time())
        await self.redis.hset(f"presence:{user_id}", mapping={
            "status": "offline",
            "last_seen": last_seen
        })
        # Remove TTL so "last seen" persists
        await self.redis.persist(f"presence:{user_id}")
        
        # Write to DB asynchronously (audit trail)
        await self.db_queue.enqueue("UPDATE users SET last_seen=$1 WHERE id=$2",
                                    [datetime.utcfromtimestamp(last_seen), user_id])
    
    async def get_location(self, user_id: str) -> dict | None:
        data = await self.redis.hgetall(f"presence:{user_id}")
        if not data or data.get("status") != "online":
            return None
        return {"server_id": data["server_id"]}
    
    async def get_presence(self, user_id: str, requesting_user_id: str) -> dict:
        """
        Respects privacy settings.
        """
        prefs = await self.user_settings.get(user_id, "presence_privacy")
        
        if prefs == "NOBODY":
            return {"status": "hidden"}
        elif prefs == "CONTACTS" and not await self.is_contact(user_id, requesting_user_id):
            return {"status": "hidden"}
        
        data = await self.redis.hgetall(f"presence:{user_id}")
        if data.get("status") == "online":
            return {"status": "online"}
        else:
            return {
                "status": "offline",
                "last_seen": data.get("last_seen")
            }
```

---

## 11) End-to-End Encryption

```text
WhatsApp uses the Signal Protocol for E2E encryption.
The server NEVER has the private keys needed to decrypt messages.

Key Exchange (happens once on first message):
1. Alice wants to message Bob for the first time
2. Alice fetches Bob's public key bundle from WA server (pre-key bundle)
3. Alice performs X3DH key agreement (Elliptic Curve Diffie-Hellman)
4. Alice encrypts message with derived shared secret
5. Server stores and forwards ciphertext - cannot decrypt it

Double Ratchet (per-message forward secrecy):
- Each message derives a new encryption key
- If one message's key is compromised, past messages are safe (forward secrecy)
- Each message key used once then discarded
```

```python
# Simplified Signal Protocol flow (conceptual)
class E2EEncryptionLayer:
    """
    Server-side: handles key distribution, NEVER decryption.
    """
    
    async def get_key_bundle(self, user_id: str) -> dict:
        """
        Return public key bundle for initiating new conversation.
        Client uses this to establish shared secret without server involvement.
        """
        return await self.key_store.get_public_bundle(user_id)
    
    async def store_prekeys(self, user_id: str, prekeys: list) -> None:
        """
        Client uploads one-time prekeys (100 at registration).
        Each prekey used once for new conversation, then deleted.
        """
        await self.key_store.save_prekeys(user_id, prekeys)
    
    async def consume_prekey(self, user_id: str) -> dict | None:
        """
        Fetch and delete one prekey for new conversation initialization.
        If no prekeys left: alert user to generate more (happens on reconnect).
        """
        return await self.key_store.pop_prekey(user_id)

# What WA server sees for every message:
server_sees = {
    "from": "user_alice_id",           # Routing metadata
    "to": "user_bob_id",               # Routing metadata
    "message_id": "uuid_abc123",       # For delivery tracking
    "timestamp": 1705310400,           # For ordering
    "ciphertext": "AES-GCM encrypted binary...",  # Server CANNOT read this
    "message_type": "CIPHERTEXT",      # But not the content
}
# The actual text, media, location - all encrypted. Server is a dumb pipe.
```

---

## 12) Push Notifications (Offline Users)

```python
class PushNotificationService:
    """
    When recipient is offline, must send push to wake up their device.
    Two platforms: APNs (Apple) and FCM (Google/Android).
    """
    
    async def send_push(self, recipient_id: str, msg: dict) -> None:
        device_tokens = await self.device_registry.get_tokens(recipient_id)
        
        for token in device_tokens:
            if token["platform"] == "IOS":
                await self._send_apns(token["token"], msg)
            elif token["platform"] == "ANDROID":
                await self._send_fcm(token["token"], msg)
    
    async def _send_apns(self, device_token: str, msg: dict) -> None:
        """
        Apple Push Notification Service.
        WA uses "content-available" silent push to minimize preview leakage.
        """
        payload = {
            "aps": {
                "content-available": 1,  # Silent push: wake app without showing preview
                "alert": {
                    "title": "New Message",
                    # Note: WA does NOT include message content in push payload
                    # (E2E encryption: notification server shouldn't see plaintext)
                    "body": "You have a new message"
                },
                "sound": "default",
                "badge": 1,
                "mutable-content": 1   # Allow app extension to modify before show
            },
            "message_id": msg["id"],  # App uses this to fetch actual content via WS on wake
        }
        
        await self.apns_client.send(device_token, payload)
    
    # Push notification limitations:
    # - APNs: max payload 4 KB
    # - FCM: max payload 4 KB
    # - Push delivery not guaranteed (device offline, token expired, etc.)
    # - Therefore: push is just a "wake-up signal"
    # - Actual message delivery happens via WebSocket after wake-up
```

---

## 13) Scaling Connection Management

```text
100M concurrent WebSocket connections — this is WA's primary infra problem.

Challenge: Each WebSocket is a persistent TCP connection.
           TCP connection maintains kernel state: file descriptor, socket buffer, etc.
           OS default: ~1K connections per process
           After tuning: 500K-1M connections per server (ulimit, TCP tuning)

Linux TCP tuning for high-connection servers:
```

```bash
# /etc/sysctl.conf tuning for 500K+ connections per server
net.core.somaxconn = 65535          # Max backlog queue per socket
net.core.netdev_max_backlog = 262144
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535  # More client-side ports

# File descriptor limits (each connection = 1 FD)
fs.file-max = 10000000              # System-wide FD limit
# Per-process: set in /etc/security/limits.conf
# user hard nofile 1000000

# TCP keepalive (detect dead connections faster)
net.ipv4.tcp_keepalive_time = 60    # Send keepalive after 60s idle (not 2h default)
net.ipv4.tcp_keepalive_intvl = 10   # Retry every 10s
net.ipv4.tcp_keepalive_probes = 6   # Give up after 6 probes = ~60+60s

# Memory per connection: reduce buffer sizes for idle connections
net.ipv4.tcp_wmem = 4096 16384 4194304  # Socket write buffer: min/default/max
net.ipv4.tcp_rmem = 4096 16384 4194304  # Socket read buffer: min/default/max
```

```python
# Asyncio-based chat server: handles 500K connections in single Python process
import asyncio
import uvloop  # Faster event loop (Cython-based)
asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())

class ChatServerApp:
    """
    At 500K concurrent connections:
    - Synchronous server: 500K threads = ~500 GB RAM (1 MB per thread stack)
    - Async server: 500K coroutines = ~500 MB RAM (1 KB per coroutine)
    This is why async is REQUIRED for this scale.
    """
    
    async def handle_connection(self, websocket, path: str) -> None:
        user_id = await self.authenticate(websocket)
        await self.on_connect(user_id, websocket)
        
        try:
            async for message in websocket:
                await self.handle_message(user_id, json.loads(message))
        except websockets.ConnectionClosed:
            pass
        finally:
            await self.on_disconnect(user_id)
    
    async def start(self, host: str, port: int) -> None:
        server = await websockets.serve(
            self.handle_connection,
            host,
            port,
            max_size=65536,           # Max message size: 64 KB
            ping_interval=30,         # Send PING every 30s
            ping_timeout=90,          # Mark dead if no PONG in 90s
            compression=None,         # Disable per-message compression (too slow at scale)
        )
        await server.wait_closed()
```

---

## 14) Failure Modes and Handling

```text
Failure               Impact                     Mitigation
Chat server crash     ~500K users reconnect      LB distributes reconnects across fleet
                                                 Client reconnects in 1-5s with backoff
                                                 Offline queue catches any missed messages

Presence service down Routing fails (can't       Fallback: try to deliver to offline queue
                      find recipient server)     Push notification instead

DB (message store) lag Messages might be lost     Save to message store BEFORE routing
                       if routed before saved    Two-phase: ack after persist, deliver after ack

Offline queue full    New messages dropped for   Queue with high-water mark alert
                      offline user               Oldest messages dropped first (configurable)

Push service down     Offline users not notified Messages still queued, delivered on reconnect
                                                 User opens app manually (acceptable degradation)

Network partition     Messages lost between      Use Kafka for cross-server delivery
  between DCs         DCs                        (guaranteed at-least-once delivery)
```

---

## 15) Interview Strategy

### Opening framing
```text
"WhatsApp's two core challenges are: 1) managing 100M+ persistent WebSocket 
connections at scale (an infra problem), and 2) guaranteed message delivery 
to offline users who may reconnect hours or days later (a storage problem).

My design uses a fleet of async chat servers behind a sticky LB, Redis for 
presence/routing, Cassandra for durable message storage, and a per-user 
offline queue with 30-day TTL."
```

### Key decisions to articulate
```text
1. Why WebSocket (not polling)?
   - Long-polling creates new HTTP connection per message (expensive at scale)
   - WebSocket: single persistent connection, full-duplex (server can push)
   - At 100M users: short-polling = 100M requests/second just for heartbeats

2. Why persist BEFORE routing?
   - If you route first and the server crashes before persist: message lost
   - If you persist first: crash = message in DB, deliver on retry/reconnect
   - Tradeoff: slightly higher send latency (one extra DB write in the path)

3. Why Cassandra for messages?
   - Sequential writes (append-only message log)
   - Cassandra's LSM-tree optimized for write-heavy workloads
   - Wide rows: all messages in a conversation stored together (efficient range scan)
   - Horizontal scalability: shard by conversation_id

4. Why group messages stored once (not per-member)?
   - At 1024 members: storing 1024 copies = 1024x storage
   - Single copy + read status table is O(members) not O(messages * members)

5. E2E encryption design:
   - Server distributes public key bundles (registration)
   - Clients compute shared secrets (X3DH)
   - Server forwards encrypted ciphertext - can't decrypt
   - Delete-by-design: server deletes message after delivery confirmation
```

### Common follow-ups
```text
Q: How does group message "delivered to all" receipt work?
A: Two separate receipts: 
   Server-delivered (single check ✓): server received the message
   Member-delivered (double check ✓✓): ALL members got the message
   For large groups: aggregate status. "Read by N of M members"

Q: What happens to messages if offline queue overflows?
A: WA has a 30-day queue limit. After 30 days: oldest messages dropped.
   User is notified on reconnect: "Some old messages may not have been delivered."
   
Q: How do you handle message ordering in poor network conditions?
A: Client assigns sequence numbers per conversation.
   Chat server ensures delivery in order within a conversation.
   Clock skew: use server-assigned timestamp for final ordering, not client clock.

Q: How does E2E encryption work with message storage/search?
A: It doesn't. WA doesn't have server-side search for this reason.
   All search is on-device (scan local message history).
   This is a fundamental privacy tradeoff.

Q: How do you handle device migrations (new phone)?
A: Message backup to iCloud/Google Drive (encrypted with user-held key).
   E2E key material reset (new keys for new device).
   Messages in transit to old device are dropped.
   WhatsApp recommends explicit backup before switching phones.
```

---

## 16) Metrics and SLOs

```python
slos = {
    "message_delivery_p95":           "< 100ms (online recipient)",
    "message_delivery_p99":           "< 500ms (online recipient)",
    "offline_delivery_after_reconnect": "< 5 seconds",
    "push_notification_latency":      "< 3 seconds",
    "group_message_delivery_p95":     "< 1 second (for groups < 100)",
    "connection_establishment":       "< 2 seconds",
    "message_durability":             "0 message loss after server ack",
}

key_metrics = [
    "messages_per_second",                  # Business health
    "delivery_success_rate",                # Core reliability
    "connection_count",                     # Infrastructure health
    "offline_queue_depth_p95",             # Alert if growing (consumers slow)
    "presence_lookup_latency_ms",          # Routing dependency
    "group_message_fanout_lag_seconds",    # Large group health
    "push_delivery_success_rate",          # Offline notification health
]
```
