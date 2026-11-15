# Med Way: Project Analysis

## Overview
**Med Way** is an intelligent emergency ambulance dispatch, routing, and real-time coordination platform designed for the Noida metropolitan region.

The platform provides a complete end-to-end emergency response workflow:
- **Patient Interface (`web/index.html`, `web/app.js`)**: Interactive Leaflet map interface supporting immediate SOS dispatches, multi-criteria clinical ambulance bookings, active mission tracking, and duplicate dispatch prevention.
- **Driver Operations Portal (`web/driver.html`)**: Mobile-ready portal enabling drivers to manage duty status, receive dispatch notifications via Server-Sent Events (SSE), advance mission lifecycle stages, and stream live GPS telemetry.
- **Admin Command Center (`web/admin.html`)**: Real-time fleet monitoring, active mission management, completed dispatch analytics, and emergency fleet reset controls.

---

## Architectural Pillars

### 1. High-Performance Spatial Routing & Road Safety
- **OSM Road Network Engine**: Parses OpenStreetMap XML (`data/noida.osm`), filters for drivable vehicular highways, and indexes over 197,000 road nodes into a 0.01° spatial grid (~1.1 km cells).
- **One-Way & Directional Topology**: Models one-way streets, motorways, and roundabouts as directed graph edges to prevent routing ambulances against oncoming traffic.
- **A\* Travel-Time Optimization**: Uses speed-weighted edge travel times, an admissible straight-line time heuristic, $O(1)$ disconnected component island guards, and an in-memory LRU route cache for sub-millisecond corridor lookups.
- **Disk Graph Caching**: Pre-serializes the road network into `data/noida_graph.cache.json`, reducing cold-boot load times from 8.5 seconds to under 600 milliseconds.

### 2. Clinical Triage & Bed Allocation
- **Multi-Criteria Scoring Engine (`src/algorithms/ClinicalTriage.js`)**: Matches patient emergency conditions (Cardiac, Stroke, Trauma, Pregnancy, General) to hospital capabilities, ICU availability, and distance.
- **Atomic Compare-And-Swap (CAS) Bed Allocation**: Decrements hospital beds and ICU capacities atomically upon dispatch to prevent regional emergency room diversion.
- **Compensation Rollbacks**: Automatically releases claimed ambulances and reserved hospital beds if downstream dispatch steps fail.

### 3. Concurrency, Race Condition & DoS Prevention
- **Atomic Vehicle Claims**: Uses single-statement CAS queries (`UPDATE ambulances SET status = 'ASSIGNED' WHERE id = ? AND status = 'AVAILABLE'`) combined with an `AsyncMutex` serialization queue to eliminate double-dispatching during concurrent bursts.
- **Sliding-Window Rate Limiting**: In-memory rate limiting shields sensitive endpoints (`/api/sos`, `/api/auth/login`) against denial-of-service floods.
- **Spatial-Temporal Duplicate Guard**: Automatically identifies and intercepts accidental double-clicks within 50 meters and 10 minutes.

### 4. Zero-Dependency Real-Time Telemetry & Observability
- **Server-Sent Events (`src/utils/eventStream.js`)**: Zero-dependency persistent push streams delivering dispatch assignments, status changes, and GPS telemetry with < 50ms latency.
- **Automated Telemetry Retention Pruning (`src/utils/telemetryPruner.js`)**: Background sliding-window service pruning historical GPS waypoints to prevent database bloat.
- **Health & Diagnostics Probes (`/health`, `/api/diagnostics`)**: Exposes live memory metrics, fleet status, route cache efficiency, and connected SSE client statistics.
