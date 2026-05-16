# Part 2: Networking Basics (Deep)

## 1) How the Internet Works

### Intuition
The Internet is a network of networks. Think of it as a postal system: your home (client) sends a letter (packet) through your local post office (ISP), through regional distribution centers (backbone routers), to the destination building (server). Every packet is addressed, routed independently, and reassembled at the destination.

### Problem
Billions of devices communicate across heterogeneous infrastructure — wired, wireless, fiber, satellite — owned by thousands of companies, across political borders. No single entity controls it all.

### Naive approach
Dedicated circuit per pair of hosts — like old telephone systems. Expensive, fragile, and mathematically impossible to scale to billions of connections.

### Optimized evolution: Packet switching + layered protocols
```text
Layer 7: Application   (HTTP, gRPC, DNS, SMTP)     "What are we saying?"
Layer 4: Transport     (TCP, UDP, QUIC)             "How reliably do we send it?"
Layer 3: Network       (IP, ICMP, BGP)              "How do we route it?"
Layer 2: Data Link     (Ethernet, WiFi)             "How do we send on local segment?"
Layer 1: Physical      (cables, radio, fiber)       "What's the medium?"
```

Each layer adds its header and passes down. At destination, each layer strips its header and passes up. This layering is what allows WiFi, Ethernet, and 5G to all carry the same HTTP traffic.

### Deep internals
```text
Your HTTP request journey:

Browser (app layer)
  ↓ HTTP request: "GET / HTTP/1.1\r\nHost: google.com\r\n..."
TCP segment (adds source/dest port, seq numbers for reliability)
  ↓ Segment: [TCP header][HTTP data]
IP packet (adds source/dest IP for routing)
  ↓ Packet: [IP header][TCP header][HTTP data]
Ethernet frame (adds MAC addresses for local hop)
  ↓ Frame: [Ethernet header][IP header][TCP header][HTTP data]
  ↓ Transmitted as electrical signals / photons / radio waves
```

**BGP (Border Gateway Protocol):** How the internet's 70,000+ autonomous systems (ISPs, cloud providers, CDNs) advertise which IP prefixes they can reach. Misconfigured BGP caused the famous 2008 Pakistan Telecom outage that took YouTube offline globally.

**NAT (Network Address Translation):** Your home has one public IP but many devices. NAT on your router rewrites private (192.168.x.x) addresses to the one public IP. This is why the internet "runs out" of IPv4 addresses yet billions of devices still connect.

**MTU (Maximum Transmission Unit):** Ethernet's MTU is 1500 bytes. If your application sends a 10KB payload, it gets split into ~7 IP fragments. If any fragment is lost, the entire TCP segment is retransmitted. This is why oversized packets (e.g., VPN tunnels misconfigured without adjusting MTU) cause mysterious connection hangs.

### Tradeoffs
- More network hops = more routing = slightly higher latency but better resilience.
- Encryption (TLS) = more security but adds CPU cost and handshake latency.

### Real-world usage
```text
CDN: servers near users to reduce hops for static content
Anycast DNS: same IP announced from multiple locations; routed to nearest
API gateways: single entry point for your API, handles TLS/auth/routing
Service mesh: networking concerns extracted from app code
```

### Diagram
```text
Browser -> Home Router (NAT) -> ISP (AS12345)
       -> Transit AS -> Peering -> Google AS (AS15169)
       -> Google Load Balancer -> App Server

Approximate latencies:
Home to ISP:      1-5ms
ISP to CDN edge:  5-20ms  
CDN to origin:    20-100ms (cross-region)
Total (with CDN): 10-30ms
Total (no CDN):   50-200ms
```

---

## 2) DNS Resolution (Step-by-Step)

### Intuition
DNS is the internet's phone book. Humans use names (google.com), computers use addresses (142.250.80.46). DNS translates between them.

### Why it matters for system design
- DNS is the first hop for every new connection. Misconfigure it and your entire system is unreachable.
- DNS TTL controls cache time. Low TTL = fast failover but high query volume. High TTL = less load but slower failover.
- DNS-based load balancing is the first layer of geo-routing (before CDN/LB).

### The resolution process
```text
Step 1: Browser cache (fastest, OS-level)
   "Did I look up google.com recently? Yes, return cached IP."

Step 2: OS resolver cache
   Check /etc/hosts first (overrides DNS!)
   Check OS DNS cache (typically 60-300s)

Step 3: Recursive resolver (usually your ISP's or 8.8.8.8 / 1.1.1.1)
   Your requests always go here for uncached queries.

Step 4: Root name servers (13 clusters, Anycast)
   "Where are the .com TLD servers?"
   Returns NS records for .com TLD servers.

Step 5: TLD (.com) name servers  
   "Where are google.com's authoritative servers?"
   Returns NS records for google.com's name servers.

Step 6: Authoritative name server (Google's DNS)
   "What is the IP for google.com?"
   Returns A record: 142.250.80.46, TTL: 300s

Step 7: Result cached at recursive resolver for TTL seconds
   Returns IP to your browser.
```

### Practical DNS commands
```bash
# Full resolution trace (shows every step)
dig google.com +trace

# Check specific record types
dig google.com A        # IPv4 address
dig google.com AAAA     # IPv6 address  
dig google.com MX       # Mail server
dig google.com CNAME    # Canonical name (alias)
dig google.com TXT      # Text records (SPF, DKIM, etc.)
dig google.com NS       # Authoritative name servers

# Check from specific DNS server
dig @8.8.8.8 google.com

# Check TTL remaining
dig google.com +noall +answer
# ;; ANSWER SECTION:
# google.com.    213    IN    A    142.250.80.46
#                ^^^
#                213 seconds remaining in cache

# Flush DNS cache (Linux)
sudo systemd-resolve --flush-caches

# DNS lookup timing
time dig google.com
# real  0m0.012s  <- cached at resolver
# real  0m0.089s  <- not cached, full resolution
```

### Deep internals
```python
# DNS record types to know
dns_record_types = {
    "A": "IPv4 address mapping (api.example.com -> 1.2.3.4)",
    "AAAA": "IPv6 address mapping",
    "CNAME": "Alias to another name (www -> app.example.com)",
    "MX": "Mail server address with priority",
    "NS": "Authoritative name servers for zone",
    "TXT": "Text records (SPF, DKIM, verification tokens)",
    "SRV": "Service location (used by gRPC, XMPP for discovery)",
    "PTR": "Reverse DNS (IP -> name)",
    "SOA": "Start of authority (zone metadata)",
}

# TTL strategy
ttl_strategy = {
    "normal_operation": 300,       # 5 minutes - good balance
    "before_migration": 60,        # 1 minute - prepare for fast failover
    "during_migration": 30,        # 30 seconds - can recover quickly
    "after_migration": 3600,       # 1 hour - stable, reduce query load
    "health_check_api": 10,        # 10 seconds - for active-active routing
}
```

### Negative caching (NXDOMAIN)
DNS also caches "this domain doesn't exist" responses. If you try to deploy a new service at `new-api.company.com` before adding the DNS record, negative cache can prevent resolution for the TTL period even after you add the record. 

### DNSSEC
Adds cryptographic signatures to DNS responses to prevent cache poisoning attacks. Without DNSSEC, an attacker could poison a DNS cache to redirect users to malicious servers.

### Tradeoffs
```text
Long TTL (3600s):  fewer DNS queries, lower cost, but slow failover
Short TTL (30s):   fast failover, but 100x more DNS queries, higher resolver load

Rule: lower TTL one day before a planned failover/migration.
Rule: never use TTL=0 in production (many resolvers ignore it, some break).
```

### Design exercise: DNS migration plan
```text
Goal: Move api.example.com from old CDN to new CDN with zero downtime

Day -2: Lower TTL from 300s to 60s
        Monitor DNS query volume (expect 5x increase in queries)
        
Day 0:  Confirm new CDN is healthy and serving traffic
        Update DNS record to new CDN IP
        Wait 60s for all caches to expire
        
Day 0+5m: Monitor error rates in both old and new CDN
          (some clients still have old IP cached)
          
Day +1:  Confirm no traffic to old CDN
         Raise TTL back to 300s
         Decommission old CDN
```

---

## 3) TCP vs UDP (Deep Internals)

### TCP: Transmission Control Protocol
TCP is like certified mail: it guarantees delivery, in order, exactly once. You pay for this with handshake overhead and retransmission delays.

```text
Three-Way Handshake:
Client ──── SYN ──────────────────────> Server
             # "Can we talk? My seq is 1000"
Client <─── SYN-ACK ──────────────── Server  
             # "Yes! My seq is 5000, I got yours (1001)"
Client ──── ACK ──────────────────────> Server
             # "Got it! Starting data transfer"

Total: 1 round trip before first byte of data.
On a 50ms RTT connection: 50ms overhead before any data flows.
TLS adds another 1-2 round trips on top of this.
```

### TCP internals: what makes it reliable
```python
# Conceptual TCP sender behavior
class TCPSender:
    def __init__(self):
        self.window_size = 65535  # bytes (can send before waiting for ACK)
        self.seq_number = 0
        self.unacked_segments = {}
    
    def send(self, data: bytes) -> None:
        segment = {
            "seq": self.seq_number,
            "data": data,
            "sent_at": time.time()
        }
        self.unacked_segments[self.seq_number] = segment
        network.transmit(segment)
        self.seq_number += len(data)
    
    def receive_ack(self, ack_number: int) -> None:
        # Remove all segments with seq < ack_number (they were received)
        self.unacked_segments = {
            seq: seg for seq, seg in self.unacked_segments.items()
            if seq >= ack_number
        }
    
    def retransmit_timeout(self) -> None:
        # Any segments unacked after timeout → retransmit
        now = time.time()
        for seq, seg in self.unacked_segments.items():
            if now - seg["sent_at"] > self.rto:  # RTO: retransmission timeout
                network.transmit(seg)
```

### TCP Congestion Control
```text
Slow Start: begin at 1 MSS (1460 bytes), double every RTT
  → quickly find available bandwidth without overloading network

Congestion Avoidance: once threshold reached, increase linearly
  → carefully probe for more bandwidth

Congestion detected (packet loss or ECN): halve window, restart
  → back off to give network breathing room

Modern algorithms:
  CUBIC:    standard Linux TCP (aggressive, good for high-bandwidth)
  BBR:      Google's algorithm (models bandwidth and RTT directly)
  RENO:     older, simpler (still used in many stacks)
```

### UDP: User Datagram Protocol
UDP is like a postcard: send it and forget. No handshake, no acknowledgment, no ordering.

```python
# UDP sender - fire and forget
import socket

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
# No connect() call needed - connectionless

# Send without caring if received
sock.sendto(b"player_position:x=100,y=200", ("game-server.com", 7777))
sock.sendto(b"player_position:x=101,y=200", ("game-server.com", 7777))
sock.sendto(b"player_position:x=102,y=200", ("game-server.com", 7777))
# If packet 2 is lost, that's fine - packet 3 has the latest position
# Waiting for retransmission would show the player as frozen
```

### QUIC: TCP-killer on UDP
QUIC (used in HTTP/3) runs on UDP but reimplements reliability and ordering at the stream level:
```text
Problem with TCP + TLS:
  - Head-of-line blocking: one lost packet blocks ALL streams on connection
  - 1-2 RTT handshake (TCP + TLS separately)
  - Connection breaks when IP changes (mobile switching WiFi → 4G)

QUIC solutions:
  - Multiplexed streams: each stream independent (loss only blocks that stream)
  - 0-RTT/1-RTT handshake (TLS integrated into QUIC handshake)
  - Connection IDs: survive IP changes (connection migration)
  - Built-in encryption (always TLS 1.3)
```

### When to use each
```text
Use TCP when:
  - API calls (REST, gRPC)
  - Database connections
  - File transfers
  - Any ordered, reliable communication
  - You need exactly-once (TCP + app-level idempotency)

Use UDP when:
  - Real-time gaming (position updates, 60fps, can afford 1 lost frame)
  - Video/audio streaming (latency matters more than perfection)
  - DNS (single packet query/response, no connection needed)
  - IoT telemetry at massive scale (can lose some readings)
  - Broadcast/multicast (one sender, many receivers)

Use QUIC (HTTP/3) when:
  - Mobile-heavy users (frequent IP changes)
  - High packet loss environments (mobile, satellite)
  - Need fast page loads (0-RTT connection reuse)
```

---

## 4) HTTP/HTTPS, HTTP/2, HTTP/3

### HTTP/1.1 (1997)
```text
Request-response text protocol. One request per connection (or pipelined with HOL blocking).

GET /api/users/123 HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJ...
Accept: application/json

HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 156

{"id": "123", "name": "Alice", ...}
```

Problems:
- **Head-of-line blocking:** Pipeline allows multiple requests, but responses must come in order. Slow response 1 blocks response 2 even if ready.
- **Header overhead:** No compression. Same `Authorization`, `User-Agent`, `Accept` headers sent on every request.
- **Connection overhead:** Browsers open 6 TCP connections per domain to parallelize.

### HTTP/2 (2015)
```text
Binary framing over one multiplexed TCP connection.

Key improvements:
- Multiplexing: 100 requests on one connection, responses can interleave
- Header compression (HPACK): only send changed headers
- Server push: send resources before client asks
- Stream priorities: mark critical requests

Frame structure:
[Length: 3 bytes][Type: 1 byte][Flags: 1 byte][Stream ID: 4 bytes][Payload: varies]
```

```python
# HTTP/2 connection reuse in Python (httpx)
import httpx
import asyncio

async def fetch_many_resources():
    # One HTTP/2 connection handles all requests in parallel
    async with httpx.AsyncClient(http2=True) as client:
        tasks = [
            client.get("https://api.example.com/users/1"),
            client.get("https://api.example.com/posts/latest"),
            client.get("https://api.example.com/notifications"),
            client.get("https://api.example.com/ads/personalized"),
        ]
        responses = await asyncio.gather(*tasks)
        # All 4 requests inflight simultaneously on ONE TCP connection
        return [r.json() for r in responses]
```

Problem with HTTP/2: it still uses TCP. TCP's head-of-line blocking affects all HTTP/2 streams on one connection when a single TCP packet is lost.

### HTTP/3 (2022)
```text
HTTP semantics over QUIC (UDP-based).

Improvement over HTTP/2:
- QUIC streams are independent: lost packet only blocks its own stream
- 0-RTT: can send data on the first packet for known servers
- Connection migration: user switches WiFi → LTE, connection survives
- Built-in TLS 1.3: no separate handshake
```

### Latency comparison
```text
Scenario: Browser loads page with 20 resources

HTTP/1.1 (6 connections, pipelining):
  TCP handshake × 6: 60ms
  TLS handshake × 6: 120ms  
  Sequential requests in each connection: varies
  Total: ~800ms

HTTP/2 (1 connection, multiplexed):
  TCP handshake × 1: 10ms
  TLS handshake × 1: 20ms
  All 20 requests in parallel: ~150ms
  Total: ~180ms

HTTP/3 (QUIC, 0-RTT for known server):
  QUIC 0-RTT: 0ms handshake for repeat visitor
  All 20 requests in parallel: ~150ms
  Total: ~150ms (mobile networks with packet loss: much better)
```

### HTTPS = HTTP + TLS
TLS provides:
- **Confidentiality:** data is encrypted (can't be read by ISP or MITM)
- **Integrity:** data can't be modified in transit (MAC signatures)
- **Authentication:** you're talking to the real server (certificate)

---

## 5) TLS Handshake (Practical Depth)

### TLS 1.3 handshake
TLS 1.3 reduced handshake to **1 round trip** (vs 2 in TLS 1.2):

```text
Client ──── ClientHello ──────────────────────────────────────> Server
  Contains:
  - TLS version: 1.3
  - Supported cipher suites: [TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256]
  - Client key share: ECDHE public key (X25519)
  - SNI (Server Name Indication): "api.example.com"
  - ALPN: ["h2", "http/1.1"]  ← protocol negotiation

Client <─── ServerHello + Certificate + Finished ────────────── Server
  Contains:
  - Chosen cipher suite
  - Server key share: ECDHE public key
  - Certificate chain
  - Server Finished (proof of identity)

At this point:
  Both sides compute shared secret from ECDHE exchange
  All future data is encrypted with AES-256-GCM

Client ──── Finished + Application Data ─────────────────────> Server
  First encrypted request is sent in the SAME flight as Finished
  → 1 RTT total for new connections
```

### 0-RTT Session Resumption
```text
For subsequent connections to the same server:

Client ──── ClientHello + Early Data (0-RTT) ────────────────> Server
  Contains:
  - Session ticket from previous connection
  - Encrypted application data (the actual request!)
  
Server processes request immediately without waiting for round trip.
→ 0 RTT for known connections (but limited: replay attack risk on non-idempotent requests)
```

### Certificate verification
```python
# Simplified certificate chain validation
def verify_cert_chain(server_cert, intermediate_cert, root_ca_cert):
    """
    Browser pre-loads trusted root CA certificates (~200 globally).
    
    Chain: Your cert -> Intermediate CA -> Root CA (in browser trust store)
    
    Verification:
    1. Is server cert signed by intermediate CA?
    2. Is intermediate CA cert signed by root CA?
    3. Is root CA in our trust store?
    4. Are any certs expired?
    5. Is server cert revoked? (check OCSP/CRL)
    6. Does Subject Alternative Name match the domain we're connecting to?
    """
    steps = [
        verify_signature(server_cert, intermediate_cert.public_key),
        verify_signature(intermediate_cert, root_ca_cert.public_key),
        is_in_trust_store(root_ca_cert),
        not is_expired(server_cert),
        not is_revoked(server_cert),  # OCSP stapling avoids this extra round trip
        matches_domain(server_cert, "api.example.com")
    ]
    return all(steps)
```

### Forward secrecy
```text
TLS 1.3 mandates forward secrecy via ECDHE (Elliptic Curve Diffie-Hellman Ephemeral).

Why it matters:
- Attacker records your encrypted traffic today
- 5 years later, they steal your server's private key
- With RSA key exchange (TLS 1.2 optional): they can decrypt ALL past traffic
- With ECDHE (TLS 1.3): they cannot decrypt past traffic (each session had unique keys)

The session keys are ephemeral (generated per-session, never stored).
```

### mTLS (Mutual TLS)
```text
Standard TLS: only server authenticates (proves identity to client)
mTLS: BOTH sides authenticate

Use case: service-to-service authentication inside datacenter
  - Service A presents client certificate to Service B
  - Service B verifies Service A's certificate against CA
  - No passwords or API keys needed, certificates prove identity
  - Used in: Kubernetes service mesh (Istio/Linkerd), Zero Trust networking
```

---

## 6) REST vs gRPC

### REST (Representational State Transfer)
```python
# REST API definition
# Resources are nouns, HTTP methods are verbs

# Create user
POST /v1/users
Content-Type: application/json
{
    "email": "alice@example.com",
    "name": "Alice"
}
# Response: 201 Created
# Location: /v1/users/usr_abc123
# {"id": "usr_abc123", "email": "alice@example.com", "name": "Alice"}

# Get user
GET /v1/users/usr_abc123
# Response: 200 OK
# {"id": "usr_abc123", ...}

# Update (partial)
PATCH /v1/users/usr_abc123
{"name": "Alice Smith"}
# Response: 200 OK

# Delete
DELETE /v1/users/usr_abc123
# Response: 204 No Content

# List with filtering
GET /v1/users?role=admin&page=2&limit=50
```

### gRPC
```protobuf
// user.proto - Contract-first design
syntax = "proto3";
package user.v1;

service UserService {
  rpc GetUser(GetUserRequest) returns (User);
  rpc ListUsers(ListUsersRequest) returns (stream User);    // server streaming
  rpc BatchCreateUsers(stream User) returns (BatchResult);  // client streaming
  rpc ChatStream(stream Message) returns (stream Message);  // bidirectional
}

message GetUserRequest {
  string id = 1;
}

message User {
  string id = 1;
  string email = 2;
  string name = 3;
  google.protobuf.Timestamp created_at = 4;
}

message ListUsersRequest {
  string page_token = 1;
  int32 page_size = 2;
}
```

```python
# gRPC server implementation (Python)
import grpc
from concurrent import futures
import user_pb2, user_pb2_grpc

class UserServicer(user_pb2_grpc.UserServiceServicer):
    def GetUser(self, request, context):
        user = db.get_user(request.id)
        if not user:
            context.set_code(grpc.StatusCode.NOT_FOUND)
            context.set_details(f"User {request.id} not found")
            return user_pb2.User()
        
        return user_pb2.User(
            id=user.id,
            email=user.email,
            name=user.name
        )
    
    def ListUsers(self, request, context):
        # Server-side streaming: yield users one by one
        page_size = request.page_size or 100
        for user in db.paginate_users(request.page_token, page_size):
            yield user_pb2.User(id=user.id, email=user.email, name=user.name)

# Start server
server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
user_pb2_grpc.add_UserServiceServicer_to_server(UserServicer(), server)
server.add_insecure_port('[::]:50051')
server.start()
```

### Performance comparison
```text
Payload size comparison (same user object):
REST/JSON:    {"id":"usr_abc123","email":"alice@example.com","name":"Alice"} = 71 bytes
gRPC/proto:   [binary encoded]                                              = ~30 bytes (2.4x smaller)

With 1M requests/day and avg 1KB payload:
REST:  1 GB/day
gRPC:  ~430 MB/day (57% bandwidth reduction)

Latency:
JSON parse (Python):    ~200 microseconds for 1KB
Protobuf parse (Python): ~50 microseconds for same data
(4x faster deserialization)
```

### Decision matrix
```text
Use REST when:
  - Public API (browsers, mobile apps, third parties)
  - Team not familiar with protobuf toolchain
  - Need human-readable payloads for debugging
  - Caching via HTTP (CDN, reverse proxy) is important
  - Simple CRUD operations
  - Webhooks/callbacks

Use gRPC when:
  - Internal service-to-service communication
  - High-throughput internal microservices (>10K RPS)
  - Need streaming (server push, bidirectional)
  - Strong contract enforcement across many services
  - Multiple language services that share one API definition
  - Real-time features (chat, live feeds)

Hybrid pattern (common in practice):
  External API: REST (developer ergonomics)
  Internal APIs: gRPC (performance + strong typing)
  Streaming: gRPC or WebSockets
```

---

## 7) WebSockets and Long Polling

### Why needed
HTTP is request-response: client must always initiate. For real-time apps (chat, live dashboards, multiplayer games), the server needs to push data to the client.

### Long Polling (simple but inefficient)
```python
# Client side (pseudo-JavaScript)
async function longPoll(lastEventId):
    while True:
        # Hold connection open up to 30 seconds waiting for new data
        response = await fetch(`/events?since=${lastEventId}&timeout=30s`)
        
        if response.status == 200:
            events = await response.json()
            processEvents(events)
            lastEventId = events[-1].id
        elif response.status == 204:
            # No new events in 30s, immediately poll again
            pass

# Server side
@app.get("/events")
def get_events(since: str, timeout: int = 30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        events = db.get_events_since(since)
        if events:
            return events
        time.sleep(0.5)  # Check every 500ms
    return Response(status_code=204)  # Timeout, no events
```

Problems: holds HTTP connection open, high server resource usage, 1 request per client per poll cycle.

### Server-Sent Events (SSE) — one-directional push
```python
# Server side - SSE
from flask import Response, stream_with_context
import time

@app.get("/stream")
def event_stream():
    def generate():
        client_id = register_client()
        try:
            while True:
                events = get_pending_events(client_id)
                for event in events:
                    # SSE format: "data: {json}\n\n"
                    yield f"id: {event.id}\n"
                    yield f"event: {event.type}\n"
                    yield f"data: {json.dumps(event.data)}\n\n"
                time.sleep(0.1)
        finally:
            unregister_client(client_id)
    
    return Response(
        stream_with_context(generate()),
        content_type='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'  # Disable nginx buffering
        }
    )
```

Good for: live feeds, dashboards, notifications (one-way push). Bad for: bidirectional communication (chat).

### WebSockets — full-duplex
```javascript
// WebSocket server (Node.js with ws library)
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

// Track all connections per user
const userConnections = new Map(); // userId -> Set<WebSocket>

wss.on('connection', (ws, request) => {
    const userId = authenticate(request);
    
    // Register this connection
    if (!userConnections.has(userId)) {
        userConnections.set(userId, new Set());
    }
    userConnections.get(userId).add(ws);
    
    // Handle incoming messages
    ws.on('message', (data) => {
        const message = JSON.parse(data);
        
        switch (message.type) {
            case 'SEND_MESSAGE':
                handleChatMessage(userId, message);
                break;
            case 'TYPING':
                broadcastTyping(userId, message.conversationId);
                break;
            case 'PING':
                ws.send(JSON.stringify({ type: 'PONG' }));
                break;
        }
    });
    
    // Handle disconnection
    ws.on('close', () => {
        userConnections.get(userId)?.delete(ws);
        updatePresence(userId, 'offline');
    });
    
    // Send welcome and backlog
    const pendingMessages = getPendingMessages(userId);
    ws.send(JSON.stringify({ 
        type: 'CONNECTED', 
        pending: pendingMessages 
    }));
});

// Push message to all of a user's connected devices
function pushToUser(targetUserId, data) {
    const connections = userConnections.get(targetUserId);
    if (!connections) {
        // User offline: store in push notification queue
        pushQueue.enqueue(targetUserId, data);
        return;
    }
    for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }
}
```

### WebSocket at scale
```text
Problem: WebSockets are stateful (long-lived connection to one server).
If you have 10 servers and User A is on server 3, and User B is on server 7,
how does server 3 deliver User B's message?

Solution: Pub/Sub bus between gateway nodes

User A (server 3) sends to User B
  -> Server 3 publishes "send to user_B" to Redis Pub/Sub channel
  -> Server 7 (subscribed to user_B's channel) receives it
  -> Server 7 sends over its WebSocket connection to User B
```

---

## 8) Load Balancing Deep Dive

### Why load balancing
One server can handle limited concurrent connections. Load balancer distributes traffic across many servers, also removes unhealthy servers automatically.

### Algorithms
```python
import random
from collections import defaultdict

class RoundRobinLB:
    """Simplest. Works well when requests are roughly equal in cost."""
    def __init__(self, servers):
        self.servers = servers
        self.index = 0
    
    def get_server(self):
        server = self.servers[self.index % len(self.servers)]
        self.index += 1
        return server

class LeastConnectionsLB:
    """Better for mixed workloads (some requests take much longer than others)."""
    def __init__(self, servers):
        self.servers = servers
        self.connections = defaultdict(int)
    
    def get_server(self):
        return min(self.servers, key=lambda s: self.connections[s])
    
    def request_started(self, server):
        self.connections[server] += 1
    
    def request_finished(self, server):
        self.connections[server] -= 1

class ConsistentHashLB:
    """
    Same client always routed to same server (good for cache affinity).
    Uses consistent hashing: if server is removed, only its keys rehash,
    not all keys (unlike simple modulo hash).
    """
    def __init__(self, servers, virtual_nodes=150):
        import bisect
        import hashlib
        self.ring = {}
        self.keys = []
        
        for server in servers:
            for i in range(virtual_nodes):
                key = int(hashlib.md5(f"{server}:{i}".encode()).hexdigest(), 16)
                self.ring[key] = server
                bisect.insort(self.keys, key)
    
    def get_server(self, client_id: str) -> str:
        import bisect, hashlib
        hash_key = int(hashlib.md5(client_id.encode()).hexdigest(), 16)
        idx = bisect.bisect(self.keys, hash_key) % len(self.keys)
        return self.ring[self.keys[idx]]
```

### L4 vs L7 Load Balancing
```text
L4 (Transport Layer):
  - Routes based on IP + port only
  - Sees encrypted traffic as opaque bytes
  - Very fast, no TLS termination needed
  - Cannot route based on URL path or headers
  - Examples: AWS NLB, HAProxy TCP mode
  - Use for: TCP streams (databases, game servers), ultra-low latency

L7 (Application Layer):
  - Routes based on HTTP headers, URL path, host
  - Can terminate TLS and inspect request
  - Can make smart routing decisions
  - Higher CPU cost (must parse HTTP)
  - Examples: AWS ALB, Nginx, Traefik
  - Use for: HTTP APIs, A/B testing, canary deployments, auth at edge

Nginx config example (L7):
```

```nginx
upstream api_backend {
    least_conn;                          # algorithm: least connections
    server api1.internal:3000 weight=3;  # gets 3x the traffic
    server api2.internal:3000 weight=3;
    server api3.internal:3000 weight=1;  # new server, lower weight during ramp-up
    
    keepalive 32;  # maintain 32 persistent connections to each backend
}

upstream api_v2_backend {
    server api-v2.internal:3001;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;
    
    ssl_certificate     /etc/ssl/cert.pem;
    ssl_certificate_key /etc/ssl/key.pem;
    
    # Route based on URL path
    location /v2/ {
        proxy_pass http://api_v2_backend;
    }
    
    location / {
        proxy_pass http://api_backend;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # Timeouts (critical - always set these!)
        proxy_connect_timeout  5s;
        proxy_read_timeout     60s;
        proxy_send_timeout     60s;
    }
}
```

### Health checks
```python
# Nginx active health check concept
health_check_config = {
    "interval": "5s",       # check every 5 seconds
    "fails": 3,             # mark unhealthy after 3 failures  
    "passes": 2,            # mark healthy after 2 successes
    "uri": "/health",       # endpoint to hit
    "expected_status": 200, # expected response code
}

# Good health endpoint
@app.get("/health")
def health():
    checks = {
        "db": check_db_connection(),
        "redis": check_redis_connection(),
        "disk_space": check_disk_space() > 10  # > 10% free
    }
    
    healthy = all(checks.values())
    status_code = 200 if healthy else 503
    
    return Response(
        json.dumps({"status": "healthy" if healthy else "unhealthy", "checks": checks}),
        status=status_code
    )
```

---

## Networking Mastery Exercises

1. **Trace a request:** Open browser DevTools → Network tab → load any website. Identify: DNS time, TLS time, TTFB, download time. Which is biggest? Why?

2. **Compare compression:** `curl -H "Accept-Encoding: gzip" https://api.example.com/large-endpoint -w "%{size_download}"` vs without. Calculate savings.

3. **TCP connection pool size:** Given: 5000 req/s, 50ms avg latency per request. Calculate required connection pool size using Little's Law.

4. **DNS failover drill:** Set a low TTL (60s) on a test subdomain, change the IP, verify propagation time matches TTL.

---

## Deep Internals Addendum

### Congestion and Flow Control
```text
Two different concepts, often confused:

Flow Control (end-to-end, TCP):
  "My receive buffer is almost full, slow down!"
  TCP window size advertisement: receiver tells sender max in-flight bytes
  Prevents sender from overwhelming receiver's memory

Congestion Control (network-wide, TCP):
  "The network is dropping packets, something is congested!"
  TCP infers congestion from packet loss or ECN marks
  Prevents overwhelming the network links between sender and receiver

Practical impact:
  Bursty traffic (10x normal QPS spike) + retry storms can:
  1. Fill receive buffers (flow control kicks in, slows senders)
  2. Overflow router queues (congestion control kicks in, TCP backs off)
  3. If backoff not implemented: constant retransmissions amplify load
  This is why rate limiting + backoff are both necessary
```

### TCP SYN Flood Protection
```bash
# SYN flood: attacker sends many SYN packets but never completes handshake
# Each incomplete connection occupies kernel memory in SYN_RCVD state
# Eventually exhausts connection table → legitimate connections refused

# Protection via SYN cookies (kernel setting)
sysctl -w net.ipv4.tcp_syncookies=1

# Also tune backlog queue
sysctl -w net.core.somaxconn=65535
sysctl -w net.ipv4.tcp_max_syn_backlog=65535

# Rate limit SYN packets at firewall level
iptables -A INPUT -p tcp --syn -m limit --limit 1000/s --limit-burst 3000 -j ACCEPT
iptables -A INPUT -p tcp --syn -j DROP  # anything above rate is dropped
```

### HTTP Caching Headers
```python
# Cache-Control directives
cache_examples = {
    # Cache for 5 minutes, must revalidate after
    "public_api_response": "Cache-Control: public, max-age=300",
    
    # Cache for 1 year (immutable content, hash in URL)
    "static_asset_with_hash": "Cache-Control: public, max-age=31536000, immutable",
    
    # Never cache (user-specific data, security-sensitive)
    "user_profile": "Cache-Control: private, no-store",
    
    # Always revalidate (dashboard that must be fresh)
    "dashboard": "Cache-Control: no-cache",  # confusing name: actually means "revalidate"
    
    # Serve stale while revalidating in background
    "news_feed": "Cache-Control: public, max-age=60, stale-while-revalidate=600",
}

# ETag-based conditional requests (save bandwidth)
# First request:
# Response: ETag: "abc123def456"

# Subsequent request:
# If-None-Match: "abc123def456"
# Response: 304 Not Modified (empty body, client uses cached version)
# Bandwidth saved: entire response body
```

### Retry with Exponential Backoff
```python
import time
import random

def retry_with_backoff(
    fn,
    max_retries: int = 3,
    base_delay_ms: float = 100,
    max_delay_ms: float = 10000,
    backoff_multiplier: float = 2.0,
    jitter: bool = True
):
    """
    Exponential backoff prevents retry storms.
    
    Without jitter: all clients retry at the same time -> amplifies overload
    With jitter: clients spread retries randomly -> smooths load
    
    Example retry schedule (base=100ms, multiplier=2, jitter=20%):
    Attempt 1: fail -> wait 100ms ± 20ms
    Attempt 2: fail -> wait 200ms ± 40ms  
    Attempt 3: fail -> wait 400ms ± 80ms
    Attempt 4: fail -> raise exception
    """
    last_exception = None
    
    for attempt in range(max_retries + 1):
        try:
            return fn()
        except Exception as e:
            last_exception = e
            
            if attempt == max_retries:
                break
            
            # Exponential delay
            delay_ms = min(base_delay_ms * (backoff_multiplier ** attempt), max_delay_ms)
            
            # Add jitter to prevent thundering herd
            if jitter:
                delay_ms = delay_ms * (0.5 + random.random() * 0.5)
            
            time.sleep(delay_ms / 1000)
    
    raise last_exception

# Usage
def call_payment_api():
    return requests.post("https://payment-api.com/charge", timeout=5)

result = retry_with_backoff(call_payment_api, max_retries=3)
```

### API Transport Design Checklist
```text
Before deploying any API:
1. Max payload size: set request body size limit (e.g., 10MB max)
2. Compression: enable gzip/brotli for responses > 1KB
3. Timeout budgets:
   - Client timeout: 30s (never wait forever)
   - Server timeout: 25s (respond before client gives up)
   - Downstream call timeout: 5s (don't wait for slow dependencies)
4. Retry semantics:
   - GET/HEAD: always safe to retry
   - POST/PUT/DELETE: only retry if idempotency key present
5. Idempotency: all state-changing operations must support idempotency keys
6. Backward compatibility: adding fields is safe, removing/renaming fields is breaking
7. Rate limiting: implement at API gateway, not just in service code
```
