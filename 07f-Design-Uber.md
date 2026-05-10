# Design Uber (Comprehensive)

## Intuition
Ride hailing is a real-time matching and geospatial system with strict latency requirements.

## Requirements
- Rider requests trip
- Nearby driver discovery
- Matching and dispatch
- Live location tracking
- Pricing, trip lifecycle, payments

## NFRs
- Match latency low
- High write throughput for location updates
- High availability in metro hotspots

## HLD
```text
Rider App -> Trip API -> Matching Service -> Driver Dispatch
Driver App -> Location Stream -> Geo Index -> Matching Service
Trip Service -> State Machine -> Payment Service
```

## LLD
- Use geospatial index (geohash/H3/S2).
- Candidate driver shortlist by nearby cells.
- Ranking by ETA, acceptance probability, driver quality.

## Schema
```sql
drivers(id, status, current_cell, last_update_ts)
trips(id, rider_id, driver_id, state, pickup_geo, drop_geo, fare, created_at)
trip_events(trip_id, event_type, ts, metadata)
```

## APIs
- `POST /v1/trips/request`
- `POST /v1/drivers/location`
- `POST /v1/trips/{id}/accept`
- `POST /v1/trips/{id}/state`

## Bottlenecks
- Downtown hotspots
- Surge traffic
- Dispatch timeout collisions

## Scaling
- Partition by geo cell.
- Locality-aware services by city/region.
- Asynchronous pricing updates with cached models.

## Failure Handling
- Fallback matching when precise ETA service degrades.
- Stale location handling with confidence scores.
- Graceful trip state recovery via event log.

## Security
- Driver/rider identity verification.
- Fraud detection on route/fare anomalies.

## Interview framing
"Uber is a geo-streaming + optimization problem. I focus on low-latency candidate selection and robust trip state transitions."

## Extended Deep Dive

### Matching pipeline stages
1. Candidate retrieval by geo cell
2. Eligibility filters (availability, constraints)
3. Scoring (ETA, acceptance probability, surge context)
4. Dispatch with timeout and fallback

### Trip state machine (example)
`requested -> matched -> driver_arriving -> in_progress -> completed | cancelled`

### Fraud and integrity
- GPS spoofing detection
- Anomalous route/fare checks
- Payment risk scoring

## Sophisticated Production Expansion

### Product promise
Riders should be matched with nearby drivers quickly, while location and trip state remain accurate enough for pricing, dispatch, and safety.

### Mature architecture
```text
Driver App -> Location Stream -> Geo Index
Rider App  -> Trip Request API -> Matching Service -> Dispatch
Trip Service -> Trip DB -> Event Bus
Pricing Service -> Demand/Supply Signals
Payment Service -> Ledger/Receipts
```

### Real-life design choices
- Driver location is high-volume and ephemeral.
- Trip state must be durable and auditable.
- Matching favors low latency over perfect global optimality.
- Payment uses idempotency and strong audit trails.

### What breaks first
- Location stream ingestion.
- Hot city cells during rush hour.
- Matching latency under demand spikes.
- Payment/provider failures.

### Metrics
- Match latency.
- Driver location freshness.
- Trip state transition failures.
- ETA error.
- Payment success rate.

## Rigorous Architecture Addendum

### Scaled architecture
```text
Driver App -> Location Gateway -> Location Stream -> Geo Index
Rider App  -> Trip API -> Matching Service -> Dispatch Service
                    -> Trip State Service -> Trip DB/Event Log
                    -> Pricing Service -> Demand/Supply Store
                    -> Payment Service -> Ledger
                    -> Notification Service
```

### Correctness boundaries
- Driver location is ephemeral and freshness-scored.
- Trip state transitions are durable and auditable.
- Dispatch accepts timeout/retry semantics with idempotent trip IDs.
- Payment is strongly consistent and auditable.
- Pricing can be cached briefly but must be explainable.

### Failure table
```text
Failure              Impact                         Mitigation
Location lag         bad matches                     freshness cutoff and confidence score
Geo cell hotspot     match latency                   cell splitting and regional workers
Dispatch timeout     rider wait                      fallback candidates and retry
Payment down         completion friction             delayed capture or fail-safe policy
Pricing lag          stale surge                     bounded TTL and recalculation
```
