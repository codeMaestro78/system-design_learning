# Design Uber / Ride-Sharing (Comprehensive)

## 1) Intuition
Uber's hardest problem is **real-time geospatial matching**: efficiently finding the nearest available driver to a rider, updating driver locations every few seconds, and doing this for millions of concurrent drivers and riders across all cities.

Secondary challenges:
- Pricing (surge pricing based on supply/demand)
- Trip lifecycle state machine (request -> match -> pickup -> in-trip -> complete)
- ETA computation (routing graph, traffic awareness)
- High-frequency location writes (every driver sends GPS every 4 seconds)

Real-world analogy: Like a taxi dispatch office where:
- Thousands of taxis send their GPS position every few seconds (location writes)
- When you call, the dispatcher finds the closest available taxi in seconds (geospatial query)
- The dispatcher tracks the taxi coming to you (trip tracking)
- Prices go up when too many people call and not enough taxis are nearby (surge pricing)

---

## 2) Functional Requirements
- Rider: request ride, see driver ETA, track driver in real-time
- Driver: go online/offline, accept/reject rides, navigate to pickup/dropoff
- Matching: find best available driver for rider
- Pricing: dynamic surge pricing based on supply/demand
- Trip: start, in-progress, complete, fare calculation
- Ratings: rider/driver mutual rating after trip

---

## 3) Non-Functional Requirements
- **Match latency:** Rider sees matched driver in < 10 seconds
- **Location update latency:** Driver location visible to rider within 2-3 seconds
- **Availability:** 99.99%
- **Scale:** 5M concurrent drivers, 3M concurrent ride requests

---

## 4) Capacity Estimation

```python
uber_scale = {
    # Drivers
    "active_drivers_worldwide": 5_000_000,
    "location_update_interval_s": 4,   # Every 4 seconds when on duty
    "driver_location_updates_per_second": 5_000_000 / 4,  # 1.25M writes/sec!
    "location_payload_bytes": 100,      # GPS coords + accuracy + heading + speed
    "location_write_bandwidth_mbps": (1_250_000 * 100) / (1024**2) * 8,  # ~953 Mbps
    
    # Rides
    "ride_requests_per_day": 20_000_000,   # 20M trips/day
    "ride_requests_per_second_avg": 231,
    "ride_requests_per_second_peak": 700,   # 3x peak (rush hour, rain, events)
    
    # Matching queries
    "geospatial_queries_per_second": 700,   # One per ride request
    "drivers_checked_per_query": 500,        # Search nearby drivers
    
    # Storage
    "avg_trip_record_bytes": 2000,
    "trips_storage_per_day_gb": (20_000_000 * 2000) / (1024**3),  # ~37 GB/day
    
    # Location history (stored for fraud/dispute resolution)
    "location_points_per_trip": 300,  # 20-min trip * (60/4) = 300 points
    "location_storage_per_trip_kb": 300 * 100 / 1024,  # ~29 KB
    "location_storage_per_day_gb": 20_000_000 * 29 / (1024 * 1024),  # ~553 GB/day
}
```

---

## 5) Geospatial Index: Quadtree and Geohash

### The core problem
```text
Naive approach: Store all 5M driver locations in DB.
For each ride request: SELECT all drivers within X km radius.
Problem: Full table scan = O(5M) rows per query!

Better: Geospatial index (Quadtree or Geohash)

Geohash: Divides Earth into a hierarchical grid
- Level 1: 32 cells (large regions)
- Level 6: ~1.2 km² cells
- Level 8: ~38 m² cells

Key insight: Nearby locations share the same geohash prefix.
"dr5ru7" and "dr5ru9" are adjacent cells (share "dr5ru" prefix)
```

```python
import geohash2

class GeospatialDriverIndex:
    """
    Uses Redis sorted set for fast geospatial queries.
    Redis GEO commands: GEOADD, GEOEARCH, GEODIST.
    
    Internally Redis stores lat/lng encoded as a 52-bit integer
    in a sorted set (each score is the geohash integer).
    GEOEARCH is O(N+log(M)) where N = results, M = total members.
    """
    
    GEOHASH_PRECISION = 6   # ~1.2 km resolution
    SEARCH_RADIUS_KM = 5.0  # Initial search radius
    MAX_RADIUS_KM = 30.0    # Expand if no drivers found
    
    def __init__(self, redis_client):
        self.redis = redis_client
    
    async def update_driver_location(
        self,
        driver_id: str,
        lat: float,
        lng: float,
        city_id: str,
        is_available: bool
    ) -> None:
        """
        Called every 4 seconds per driver.
        1.25M calls/second total.
        
        Separate index per city to partition the data.
        """
        if is_available:
            # Add/update in city's available driver index
            await self.redis.geoadd(f"drivers:{city_id}:available", lng, lat, driver_id)
        else:
            # Remove from available index (occupied or offline)
            await self.redis.zrem(f"drivers:{city_id}:available", driver_id)
        
        # Always update last known location (for ETA, tracking)
        await self.redis.hset(f"driver:{driver_id}", mapping={
            "lat": lat,
            "lng": lng,
            "updated_at": int(time.time()),
            "is_available": int(is_available),
            "city_id": city_id
        })
        await self.redis.expire(f"driver:{driver_id}", 3600)  # Auto-expire stale drivers
    
    async def find_nearby_drivers(
        self,
        rider_lat: float,
        rider_lng: float,
        city_id: str,
        count: int = 10
    ) -> list:
        """
        Find nearest available drivers within expanding radius.
        Uses Redis GEOEARCH command.
        """
        radius = self.SEARCH_RADIUS_KM
        
        while radius <= self.MAX_RADIUS_KM:
            results = await self.redis.geoearch(
                f"drivers:{city_id}:available",
                longitude=rider_lng,
                latitude=rider_lat,
                radius=radius,
                unit="km",
                count=count,
                sort="ASC",          # Sort by distance (closest first)
                withcoord=True,
                withdist=True
            )
            
            if results:
                return [
                    {
                        "driver_id": r[0],
                        "distance_km": r[1],
                        "lat": r[2][1],
                        "lng": r[2][0]
                    }
                    for r in results
                ]
            
            # No drivers found, expand search radius
            radius *= 2
        
        return []  # No drivers available
```

---

## 6) Data Model

```sql
-- Users (both riders and drivers)
CREATE TABLE users (
    id           BIGINT PRIMARY KEY,
    type         VARCHAR(10) NOT NULL,  -- 'RIDER', 'DRIVER', 'BOTH'
    name         VARCHAR(100) NOT NULL,
    phone        VARCHAR(20) UNIQUE NOT NULL,
    email        VARCHAR(255) UNIQUE,
    rating       DECIMAL(3,2) DEFAULT 5.00,  -- 1.00 - 5.00
    trips_count  INTEGER DEFAULT 0,
    created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Driver profiles
CREATE TABLE driver_profiles (
    driver_id     BIGINT PRIMARY KEY,
    license_num   VARCHAR(20) UNIQUE NOT NULL,
    vehicle_make  VARCHAR(50),
    vehicle_model VARCHAR(50),
    vehicle_year  INTEGER,
    vehicle_plate VARCHAR(20) UNIQUE NOT NULL,
    vehicle_type  VARCHAR(10),  -- 'ECONOMY', 'PREMIUM', 'SUV', 'XL'
    documents_verified BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (driver_id) REFERENCES users(id)
);

-- Trips
CREATE TABLE trips (
    id             BIGINT PRIMARY KEY,   -- Snowflake ID
    rider_id       BIGINT NOT NULL,
    driver_id      BIGINT,               -- NULL until matched
    status         VARCHAR(15) NOT NULL, -- 'REQUESTED','MATCHED','PICKUP','IN_TRIP','COMPLETED','CANCELLED'
    
    -- Location data
    pickup_lat     DECIMAL(9,6) NOT NULL,
    pickup_lng     DECIMAL(9,6) NOT NULL,
    pickup_address VARCHAR(500) NOT NULL,
    dropoff_lat    DECIMAL(9,6),
    dropoff_lng    DECIMAL(9,6),
    dropoff_address VARCHAR(500),
    
    -- Timing
    requested_at   TIMESTAMP NOT NULL,
    matched_at     TIMESTAMP,
    pickup_at      TIMESTAMP,
    completed_at   TIMESTAMP,
    cancelled_at   TIMESTAMP,
    
    -- Fare
    estimated_fare_usd DECIMAL(8,2),
    actual_fare_usd    DECIMAL(8,2),
    surge_multiplier   DECIMAL(3,2) DEFAULT 1.00,  -- e.g., 2.5x surge
    
    -- Route
    route_polyline TEXT,                -- Encoded polyline for display
    distance_km    DECIMAL(7,2),
    duration_mins  INTEGER
);
CREATE INDEX idx_trips_rider ON trips(rider_id, requested_at DESC);
CREATE INDEX idx_trips_driver ON trips(driver_id, requested_at DESC);
CREATE INDEX idx_trips_status ON trips(status, requested_at DESC);

-- Trip location trail (for disputes, route replay)
-- High write volume: 300 points * 20M trips/day = 6B rows/day
-- Use Cassandra or time-series DB
CREATE TABLE trip_locations (
    trip_id      BIGINT NOT NULL,
    recorded_at  TIMESTAMP NOT NULL,
    lat          DECIMAL(9,6) NOT NULL,
    lng          DECIMAL(9,6) NOT NULL,
    speed_kmh    DECIMAL(5,1),
    heading_deg  SMALLINT,
    PRIMARY KEY (trip_id, recorded_at)
);
```

---

## 7) High-Level Design (HLD)

```text
Rider App / Driver App
    |
    v
[API Gateway]  <- Auth (JWT), rate limiting
    |
    +---[Location Service]        <- 1.25M driver location writes/sec
    |   [Redis Geo Index]         <- GEOADD per driver update
    |
    +---[Trip Service]            <- Ride request, state machine
    |   [Trip DB (Postgres)]      <- Sharded by trip_id
    |
    +---[Matching Service]        <- Find + select best driver
    |   [Redis Geo + Scoring]     <- Nearest driver ranking
    |
    +---[Pricing Service]         <- Dynamic surge calculation
    |   [Supply/Demand Cache]     <- Redis counters per geohash cell
    |
    +---[ETA Service]             <- Route + traffic ETA
    |   [Google Maps / HERE API]  <- External routing graph
    |
    +---[Notification Service]    <- Push to driver/rider
    |   [APNs / FCM]
    |
    +---[Tracking Service]        <- Real-time driver position for rider
        [WebSocket Gateway]       <- Rider app subscribes to driver location
```

---

## 8) Trip Lifecycle State Machine

```python
from enum import Enum

class TripStatus(Enum):
    REQUESTED  = "REQUESTED"    # Rider requested, searching for driver
    MATCHING   = "MATCHING"     # Searching for nearby driver
    MATCHED    = "MATCHED"      # Driver assigned, on way to pickup
    ARRIVED    = "ARRIVED"      # Driver at pickup location
    IN_TRIP    = "IN_TRIP"      # Rider in car, going to destination
    COMPLETED  = "COMPLETED"    # Trip finished, fare calculated
    CANCELLED  = "CANCELLED"    # Cancelled by rider or driver

VALID_TRANSITIONS = {
    TripStatus.REQUESTED:  [TripStatus.MATCHING, TripStatus.CANCELLED],
    TripStatus.MATCHING:   [TripStatus.MATCHED, TripStatus.CANCELLED],
    TripStatus.MATCHED:    [TripStatus.ARRIVED, TripStatus.CANCELLED],
    TripStatus.ARRIVED:    [TripStatus.IN_TRIP, TripStatus.CANCELLED],
    TripStatus.IN_TRIP:    [TripStatus.COMPLETED],
    TripStatus.COMPLETED:  [],
    TripStatus.CANCELLED:  [],
}

class TripStateMachine:
    def transition(self, trip: dict, new_status: TripStatus) -> dict:
        current = TripStatus(trip["status"])
        
        if new_status not in VALID_TRANSITIONS[current]:
            raise InvalidTransitionError(
                f"Cannot transition from {current} to {new_status}"
            )
        
        trip["status"] = new_status.value
        trip[f"{new_status.value.lower()}_at"] = datetime.utcnow()
        return trip
```

### Matching algorithm
```python
class RideMatchingService:
    """
    Matching is more than just distance.
    Factors: distance, driver acceptance rate, ETA, vehicle type.
    """
    
    async def match_driver(self, trip: dict) -> str | None:
        """
        Find best available driver for a ride request.
        Returns driver_id if match found, None if no drivers available.
        """
        rider_lat = trip["pickup_lat"]
        rider_lng = trip["pickup_lng"]
        city_id = trip["city_id"]
        
        # 1. Get nearest available drivers
        nearby_drivers = await self.geo_index.find_nearby_drivers(
            rider_lat, rider_lng, city_id, count=20
        )
        
        if not nearby_drivers:
            return None
        
        # 2. Score and rank drivers
        scored_drivers = []
        for driver_info in nearby_drivers:
            score = await self._score_driver(driver_info, trip)
            if score > 0:
                scored_drivers.append((score, driver_info["driver_id"]))
        
        scored_drivers.sort(reverse=True)
        
        # 3. Send offers to top drivers (first one who accepts gets the trip)
        for _, driver_id in scored_drivers[:3]:  # Parallel offer to top 3
            offered = await self._offer_trip(driver_id, trip)
            if offered:
                return driver_id
        
        return None
    
    async def _score_driver(self, driver_info: dict, trip: dict) -> float:
        """
        Score = weighted combination of:
        - Proximity (closer = higher score)
        - Driver rating
        - Historical acceptance rate
        - Time idle (prefer drivers who haven't had a trip recently)
        """
        driver_id = driver_info["driver_id"]
        profile = await self.driver_cache.get(driver_id)
        
        if not profile or profile["is_available"] == 0:
            return 0.0
        
        # Normalize each factor to 0-1 range
        distance_score = max(0, 1 - driver_info["distance_km"] / 30)  # 0 at 30km
        rating_score = (profile.get("rating", 5.0) - 1.0) / 4.0       # 1-5 -> 0-1
        acceptance_rate = float(profile.get("acceptance_rate", 0.8))
        
        # Weighted sum
        return (
            0.50 * distance_score +
            0.25 * rating_score +
            0.25 * acceptance_rate
        )
    
    async def _offer_trip(self, driver_id: str, trip: dict) -> bool:
        """
        Push trip offer to driver app.
        Driver has 15 seconds to accept.
        """
        await self.push_service.send_to_driver(driver_id, {
            "type": "TRIP_OFFER",
            "trip_id": trip["id"],
            "pickup_location": {
                "lat": trip["pickup_lat"],
                "lng": trip["pickup_lng"],
                "address": trip["pickup_address"]
            },
            "estimated_earnings_usd": trip["estimated_fare_usd"] * 0.75,
            "expires_at_ms": int(time.time() * 1000) + 15_000  # 15 second offer
        })
        
        # Wait up to 15 seconds for driver acceptance
        try:
            accepted = await asyncio.wait_for(
                self._wait_for_driver_response(driver_id, trip["id"]),
                timeout=15.0
            )
            return accepted
        except asyncio.TimeoutError:
            return False
```

---

## 9) Surge Pricing

```python
class SurgePricingEngine:
    """
    Surge = f(demand, supply) in a geographic cell.
    When demand >> supply, multiply base price by surge factor.
    
    Surge is calculated per geohash cell (roughly 1km x 1km).
    """
    
    SURGE_MATRIX = {
        # (supply_score, demand_score) -> multiplier
        # Supply/Demand: 0=low, 1=medium, 2=high
        (2, 0): 1.0,   # Lots of supply, no demand: no surge
        (2, 1): 1.0,
        (2, 2): 1.0,
        (1, 1): 1.0,
        (1, 2): 1.5,
        (0, 1): 1.5,
        (0, 2): 2.0,
        (0, 0): 1.0,   # No one around, no surge
    }
    
    async def get_surge_multiplier(self, lat: float, lng: float) -> float:
        cell = geohash2.encode(lat, lng, precision=6)
        
        # Supply: available drivers in this cell and adjacent cells
        nearby_cells = geohash2.neighbors(cell)  # 8 adjacent cells
        cells_to_check = [cell] + list(nearby_cells.values())
        
        available_drivers = await self.redis.sunionstore(
            "tmp:available",
            *[f"drivers:{c}:available" for c in cells_to_check]
        )
        
        # Demand: ride requests in last 5 minutes in this area
        pending_requests = await self.redis.get(f"demand:{cell}:5min") or 0
        
        # Categorize supply/demand level
        supply_score = 2 if available_drivers > 10 else (1 if available_drivers > 3 else 0)
        demand_score = 2 if int(pending_requests) > 20 else (1 if int(pending_requests) > 5 else 0)
        
        multiplier = self.SURGE_MATRIX.get((supply_score, demand_score), 1.0)
        
        # Cache surge multiplier (recalculate every 30 seconds)
        await self.redis.setex(f"surge:{cell}", 30, str(multiplier))
        
        return multiplier
```

---

## 10) Real-Time Driver Tracking for Rider

```python
# When matched, rider's app subscribes to driver's location updates via WebSocket

class TrackingService:
    async def subscribe_to_driver(
        self, rider_websocket, trip_id: str, driver_id: str
    ) -> None:
        """
        Rider app holds a WebSocket connection.
        Every time driver location updates, push it to rider.
        """
        subscription = await self.redis.subscribe(f"driver_location:{driver_id}")
        
        try:
            async for message in subscription.listen():
                if message["type"] == "message":
                    location = json.loads(message["data"])
                    
                    await rider_websocket.send_json({
                        "type": "DRIVER_LOCATION",
                        "trip_id": trip_id,
                        "lat": location["lat"],
                        "lng": location["lng"],
                        "heading": location["heading"],
                        "speed_kmh": location["speed"],
                        "eta_minutes": location.get("eta_minutes")
                    })
        except websockets.ConnectionClosed:
            pass

class LocationService:
    async def update_driver_location(self, driver_id: str, location: dict) -> None:
        # Update geo index for matching
        await self.geo_index.update_driver_location(
            driver_id, location["lat"], location["lng"],
            location["city_id"], location["is_available"]
        )
        
        # Publish to rider's subscription channel (if on trip)
        current_trip = await self.get_active_trip(driver_id)
        if current_trip:
            await self.redis.publish(
                f"driver_location:{driver_id}",
                json.dumps(location)
            )
```

---

## 11) Interview Strategy

### Opening framing
```text
"Uber's core technical challenge is real-time geospatial matching: 
efficiently finding the nearest driver from 5M concurrent drivers, 
while accepting 1.25M location updates per second.

I'll use Redis GEO commands for the spatial index (O(log N) nearest neighbor),
a distributed state machine for trip lifecycle, and a WebSocket-based 
tracking service to push driver location to riders."
```

### Key decisions
```text
1. Why Redis GEO instead of PostGIS?
   - Redis GEO: in-memory, O(log N), sub-millisecond response
   - PostGIS: disk-based, more complex queries, better for historical analysis
   - At 1.25M writes/sec: Redis GEOADD handles this; Postgres cannot

2. Why separate location service from trip service?
   - Location updates are write-heavy, low-value data (overwritten every 4s)
   - Trip data is write-once, high-value (permanent record)
   - Separating lets you scale location independently (Redis cluster)
   - Separating lets you apply different durability guarantees

3. How does matching avoid double-booking a driver?
   - Optimistic locking: when driver accepts, check driver is still unassigned
   - Use Redis SETNX ("set if not exists") as distributed lock
   - If SETNX fails: driver was just matched by another rider request
   - Fallback: try next driver in the ranked list

4. How does surge pricing prevent gaming?
   - Geohash precision: cell size ~1km, hard to game by moving slightly
   - Surge smoothing: change slowly over 5-minute windows (not per-second)
   - Driver tip transparency: drivers can see where surge is and drive there
```
