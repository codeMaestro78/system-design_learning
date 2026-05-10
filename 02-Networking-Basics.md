# Part 1: Networking Basics (Deep)

## 1) How the Internet Works

### Intuition
The Internet is a network of networks that forward packets based on addressing and routing policies.

### Problem
Billions of devices communicate across heterogeneous infrastructure.

### Naive approach
Dedicated circuit per pair of hosts (non-scalable, expensive, fragile).

### Optimized evolution
Packet switching + layered protocols:
- Link layer
- IP layer
- Transport layer (TCP/UDP/QUIC)
- Application protocols (HTTP, gRPC, DNS)

### Deep internals
- Routers forward based on routing tables.
- BGP exchanges reachability between autonomous systems.
- NAT rewrites private addresses to public edge addresses.
- MTU affects packet fragmentation and retransmissions.

### Tradeoffs
- More hops improve reachability but add latency.
- Encryption improves security but adds CPU and handshake cost.

### Real-world usage
CDN, Anycast DNS, edge PoPs, API gateways.

### Diagram
```text
Browser -> Home Router -> ISP -> Transit AS -> Datacenter Edge -> Service
```

### Interview perspective
Explain request path lifecycle and where latency accumulates.

## Advanced Roadmap: Networking

### Topics and subtopics
- DNS: recursive resolvers, authoritative servers, TTL, CNAME, Anycast.
- Transport: TCP handshake, congestion control, retransmission, UDP, QUIC.
- Security: TLS handshake, certificates, mTLS, certificate rotation.
- Application protocols: HTTP/1.1, HTTP/2 multiplexing, HTTP/3, gRPC, WebSockets.
- Edge networking: CDN, WAF, DDoS protection, global load balancing.
- Internal networking: service mesh, retries, deadlines, circuit breakers.

### Request architecture
```text
Mobile App
  -> DNS Resolver
  -> CDN Edge / WAF
  -> Global Load Balancer
  -> Regional Load Balancer
  -> API Gateway
  -> Service Pod
  -> Cache / DB / Downstream Service
```

### Example: why p99 latency increases
If a request calls 5 downstream services and each has a 1% slow-tail probability, the aggregate request is much more likely to hit at least one slow dependency. This is why deadlines, bulkheads, and fewer synchronous hops matter.

### Real systems to study
- Netflix/Open Connect style CDN: place content near users.
- Cloudflare-style edge protection: absorb attacks before origin.
- Slack/WhatsApp-style realtime gateways: manage millions of long-lived connections.

### Design exercise
Design a global API routing layer for users in India, Europe, and the United States. Include:
- DNS and global load balancing.
- Regional failover.
- TLS termination.
- Health checks.
- Latency and availability metrics.

## Rigorous Network Architecture

### Production request path
```text
Client
  -> Local DNS cache
  -> Recursive DNS resolver
  -> Authoritative DNS / Global Traffic Manager
  -> CDN/WAF edge
  -> Regional load balancer
  -> API gateway
  -> Service mesh or service discovery
  -> Backend service
  -> Cache/DB/downstream
```

### Network failure table
```text
Failure                         Symptom                     Design response
DNS misconfiguration            Global outage               Low TTL during migration, staged rollout
TLS certificate expiry          Clients cannot connect      Automated renewal and expiry alert
CDN POP degraded                Regional high latency       Traffic steering and origin fallback
Load balancer bad health check  Good nodes removed          Synthetic probes and slow-start
Packet loss                     p99 latency spike           Retries with deadlines, connection reuse
Cross-region dependency call    Tail latency explosion      Regional data locality
```

### Rules for rigorous designs
- Every network call needs a timeout.
- Retries must have a budget and backoff.
- Do not retry non-idempotent writes unless the API supports idempotency keys.
- Propagate deadlines from edge to downstream services.
- Track latency by hop, not only end-to-end.

---

## 2) DNS Resolution (Step-by-Step)

### Intuition
DNS maps human-readable names to machine-routable addresses.

### Steps
1. Browser cache lookup
2. OS resolver cache
3. Recursive resolver query
4. Root server referral
5. TLD server referral
6. Authoritative server response (A/AAAA/CNAME)
7. Cache result with TTL

### Deep internals
- Negative caching for NXDOMAIN
- TTL controls staleness vs query volume
- CNAME chains add extra lookups
- DNSSEC validates authenticity

### Tradeoffs
- Long TTL: lower DNS load, slower failover.
- Short TTL: faster changes, higher query cost.

### Diagram
```text
Client -> Resolver -> Root -> TLD -> Authoritative -> Resolver -> Client
```

### Interview
Mention DNS as part of latency budget and failover strategy.

**Exercise:** Design low-downtime DNS migration plan between providers.

---

## 3) TCP vs UDP (Deep Internals)

## TCP
- Connection-oriented (3-way handshake)
- Reliable delivery with ACK + retransmit
- Ordered byte stream
- Congestion control (e.g., CUBIC/BBR depending stack)

## UDP
- Connectionless datagrams
- No built-in reliability/ordering
- Lower protocol overhead

### When to use
- TCP: APIs, databases, transactional workloads.
- UDP: realtime media, gaming, telemetry bursts.
- QUIC uses UDP but adds secure reliable streams in user space.

### Tradeoffs
- TCP simpler correctness; may increase latency under packet loss.
- UDP lower latency potential; shifts complexity to application.

### Interview
Tie choice to workload semantics (ordering, loss tolerance, latency target).

**Exercise:** Pick transport for multiplayer game state updates and justify.

---

## 4) HTTP/HTTPS, HTTP/2, HTTP/3

### HTTP/1.1
- Text-based, request-response.
- Connection reuse possible, but head-of-line issues at app layer.

### HTTP/2
- Binary framing, multiplexing streams over one TCP connection.
- Header compression (HPACK).

### HTTP/3
- Runs on QUIC over UDP.
- Better loss isolation and faster connection migration.

### HTTPS
HTTP encrypted with TLS for confidentiality, integrity, and authentication.

### Tradeoffs
- HTTP/3 can reduce tail latency on lossy mobile networks.
- Operational and debugging complexity can increase.

---

## 5) TLS Handshake (Practical Depth)

### Intuition
Establish a secure shared session key over an insecure network.

### Typical TLS 1.3 flow
1. ClientHello (cipher suites, key share, SNI, ALPN)
2. ServerHello (chosen params + cert chain)
3. Certificate verification
4. Key agreement (ECDHE)
5. Finished messages
6. Encrypted application data

### Internals
- Forward secrecy via ephemeral key exchange.
- Session resumption (tickets/PSK) reduces handshake latency.
- ALPN negotiates HTTP/1.1 vs HTTP/2.

### Interview
Mention certificate validation and forward secrecy explicitly.

---

## 6) REST vs gRPC

### REST
- Resource-oriented, HTTP verbs, JSON.
- Broad compatibility and easy debugging.

### gRPC
- Contract-first (protobuf), binary payloads, streaming support.
- Strong typing and lower serialization overhead.

### Real-world pattern
- Public APIs: REST.
- Internal service-to-service: gRPC.

### Tradeoffs
- REST: easier ecosystem, larger payloads.
- gRPC: better perf, more tooling discipline required.

### Interview
State transport + schema + evolution strategy and fallback plan.

---

## Networking Mastery Exercises
1. Build end-to-end request timeline from DNS to DB query.
2. Compare HTTP/2 and HTTP/3 for mobile high-loss network.
3. Design API auth + TLS termination at edge and service mesh mTLS internally.

---

## Deep Internals Addendum

### Congestion and Flow Control (must know)
- **Congestion control** protects network from collapse.
- **Flow control** protects receiver from sender overrun.
- Practical impact: bursty traffic and retry storms can amplify tail latency.

### TCP Handshake and Failure Cases
```text
SYN -> SYN-ACK -> ACK
```
- SYN floods can exhaust connection queues.
- Tune backlog, SYN cookies, and timeouts carefully.

### Keepalive and Connection Reuse
- Reusing connections reduces handshake overhead.
- Idle timeouts too low cause churn; too high can waste resources.

### HTTP caching semantics
- `Cache-Control`, `ETag`, `If-None-Match`, `304 Not Modified`
- Proper cache headers can remove significant backend load.

### API transport design checklist
1. Max payload size
2. Compression policy
3. Timeout budgets
4. Retry semantics (safe methods only by default)
5. Idempotency for unsafe operations
6. Backward compatibility versioning

### Interview mini-case
If p99 latency spikes globally:
1. Check DNS/edge reachability.
2. Check TLS handshake duration.
3. Check connection reuse rates.
4. Check downstream dependency latency.
5. Validate retry behavior isn’t amplifying load.
