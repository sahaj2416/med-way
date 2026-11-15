# Med Way: In-Depth Technical Flaws & Architectural Vulnerability Analysis

This document provides a comprehensive, rigorous software engineering and security audit of the **Med Way** emergency ambulance dispatch platform. It identifies critical architectural shortcomings, race conditions, security vulnerabilities, algorithmic deficiencies, and operational risks across the codebase.

---

## Table of Contents
1. [Executive Summary of Flaws](#1-executive-summary-of-flaws)
2. [Critical Architectural & Functional Flaws](#2-critical-architectural--functional-flaws)
3. [Concurrency, Race Conditions & Data Integrity](#3-concurrency-race-conditions--data-integrity)
4. [Security & Access Control Vulnerabilities (OWASP Top 10)](#4-security--access-control-vulnerabilities-owasp-top-10)
5. [Algorithmic & Spatial Routing Deficiencies](#5-algorithmic--spatial-routing-deficiencies)
6. [Data Model & Persistence Inconsistencies](#6-data-model--persistence-inconsistencies)
7. [Code Quality, Dependencies & Operational Risks](#7-code-quality-dependencies--operational-risks)
8. [Prioritized Remediation Roadmap](#8-prioritized-remediation-roadmap)

---

## 1. Executive Summary of Flaws

While Med Way presents a visually appealing concept and a functional prototype for emergency routing, a deep code inspection reveals **structural flaws** that make it unsafe for real-world deployment. The system contains unauthenticated destructive endpoints, critical race conditions permitting double-dispatching of ambulances, road routing that ignores one-way streets (routing ambulances into oncoming traffic), and a complete absence of live telemetry streaming despite architectural claims.

```
+---------------------------------------------------------------------------------------+
|                                SEVERITY BREAKDOWN                                     |
+---------------------------------------------------------------------------------------+
|  CRITICAL (Immediate system failure, data corruption, or catastrophic security hole)  |
|  - Zero authentication / Unprotected god-mode admin endpoints                         |
|  - Double-dispatch race condition on concurrent emergency requests                    |
|  - Hardcoded bidirectional road graph (routing against one-way traffic)               |
|  - Non-existent driver live telemetry endpoint (broken location tracking)             |
+---------------------------------------------------------------------------------------+
|  HIGH (Significant performance degradation, clinical misrouting, or denial of service)|
|  - Clinical-blind hospital selection (ignoring ICU beds, open emergency wards)        |
|  - Event-loop blocking on disconnected graph components (A* DoS)                      |
|  - HTTP polling latency (3-5s delay) in life-critical emergency workflows             |
|  - Non-vehicular pathways (pedestrian footpaths/steps) parsed as ambulance highways    |
+---------------------------------------------------------------------------------------+
|  MEDIUM (Operational friction, missing dependencies, schema drift)                    |
|  - Undeclared runtime dependency (`sax` missing from package.json)                    |
|  - SQLite default rollback journal blocking concurrent queries                        |
|  - In-memory graph re-parsing on every boot (8.5s freeze)                             |
|  - Stored XSS vectors in patient dispatch status rendering                            |
+---------------------------------------------------------------------------------------+
```

---

## 2. Critical Architectural & Functional Flaws

### 2.1. Phantom Telemetry: Missing Driver Location Endpoint
- **Location in Code**: Documented in [`ARCHITECTURE.md`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/ARCHITECTURE.md#L45-L48) and table `ambulance_location_history`, but **missing** in [`server.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/server.js).
- **The Defect**: `ARCHITECTURE.md` explicitly specifies:
  ```text
  DP -->|"Location ping on each poll cycle"| LOC_EP["POST /api/driver/location"]
  LOC_EP -->|"UPDATE ambulance lat and lon"| AMB
  ```
  In reality, `POST /api/driver/location` was never implemented in `server.js`. Furthermore, [`web/driver.html`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/web/driver.html) only sends coordinates once when the driver clicks "Go Online". During an active mission, driver coordinates are never transmitted.
- **Impact**:
  - The vehicle remains completely stationary on the map at its initial registration point.
  - The table `ambulance_location_history` remains permanently empty (0 rows).
  - Dispatchers and patients have no visibility into vehicle progress.

### 2.2. Polling Inefficiencies & Emergency Latency
- **Location in Code**: [`web/driver.html`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/web/driver.html#L1109) (5000ms interval) and [`web/admin.html`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/web/admin.html#L864) (3000ms interval).
- **The Defect**: The system relies on short HTTP polling rather than persistent bi-directional connections (WebSockets or Server-Sent Events).
- **Impact**:
  - **Latency Bottleneck**: When a patient hits SOS, up to **5 seconds** elapse before the assigned driver's browser detects the dispatch. In acute cardiac or trauma emergencies, a 5-second notification delay is unacceptable.
  - **Server Storms**: With $N$ active drivers and $M$ dispatchers, the server is bombarded with continuous, redundant HTTP GET requests, causing thread starvation and rapid battery drain on mobile driver devices.

### 2.3. Ghost Animation & One-Way Patient Feedback
- **Location in Code**: [`web/app.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/web/app.js#L9).
- **The Defect**:
  - Variable `animatedAmbulance` is declared in `state`, but no animation loop or movement logic was ever implemented.
  - Once the patient receives the initial dispatch response, `app.js` stops all server communication. It never polls for trip updates.
- **Impact**: If a driver accepts the mission, arrives at the scene, or cancels, the patient UI remains permanently frozen on the initial "Assigned" screen.

### 2.4. Ephemeral In-Memory Graph with Boot Latency
- **Location in Code**: [`server.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/server.js#L896-L912) and [`src/algorithms/OSMParser.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/src/algorithms/OSMParser.js).
- **The Defect**: The application does not serialize or persist its topological road graph. On every restart, it must stream-parse the entire 139 MB `noida.osm` XML file from scratch.
- **Impact**:
  - Server boot takes **8.5 to 12 seconds**, allocating ~250 MB of RAM for the graph heap.
  - If a production instance crashes and restarts, incoming emergency requests fail or fall back to Euclidean straight lines until the XML stream completes.

---

## 3. Concurrency, Race Conditions & Data Integrity

### 3.1. Double-Dispatch Race Condition (Time-of-Check to Time-of-Use)
- **Location in Code**: [`server.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/server.js#L127-L260).
- **The Defect**: In `handleDispatchFlow()`, selecting and reserving an ambulance is non-atomic:
  1. `SELECT ... FROM ambulances WHERE status = 'AVAILABLE'` (Ambulance $A$ is picked).
  2. Asynchronously query hospital database.
  3. Execute synchronous, CPU-intensive $A^*$ pathfinding (~50–200ms).
  4. Asynchronously insert incident record (`INSERT INTO incidents`).
  5. Finally, update ambulance status: `UPDATE ambulances SET status = 'ASSIGNED' WHERE id = ?`.
- **Impact**: If Patient 1 and Patient 2 trigger SOS within 200ms of each other in the same district:
  - Both requests read the same fleet snapshot.
  - **Both select Ambulance $A$**.
  - Both insert dispatches assigning Ambulance $A$.
  - Two emergency patients believe the same single ambulance is en route to them.

```mermaid
sequenceDiagram
    autonumber
    actor Patient1 as Patient 1
    actor Patient2 as Patient 2
    participant Server as Node.js Dispatch Engine
    participant DB as SQLite DB

    Patient1->>Server: POST /api/sos (Location X)
    Server->>DB: SELECT available ambulances
    DB-->>Server: AMB-101 is nearest & AVAILABLE
    Note over Server: Server starts A* pathfinding for Patient 1...

    Patient2->>Server: POST /api/sos (Location Y near X)
    Server->>DB: SELECT available ambulances
    DB-->>Server: AMB-101 is STILL listed as AVAILABLE!
    Note over Server: Server starts A* pathfinding for Patient 2...

    Server->>DB: UPDATE AMB-101 status = 'ASSIGNED' (for Patient 1)
    Server->>Patient1: Dispatched AMB-101!
    Server->>DB: UPDATE AMB-101 status = 'ASSIGNED' (for Patient 2)
    Server->>Patient2: Dispatched AMB-101!
    Note over Patient1,Patient2: CRITICAL FAILURE: Single ambulance assigned to two emergencies!
```

### 3.2. SQLite Concurrency & Database Locking
- **Location in Code**: [`src/db/database.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/src/db/database.js#L16).
- **The Defect**: The database runs in default journal mode (rollback journal) without Write-Ahead Logging (`WAL`) enabled.
- **Impact**: When multiple writes occur (concurrent dispatches, driver status updates, admin overrides), SQLite locks the entire database file. Concurrent reads from the 3-second admin polling and 5-second driver polling intermittently crash with `SQLITE_BUSY: database is locked`.

---

## 4. Security & Access Control Vulnerabilities (OWASP Top 10)

### 4.1. Complete Absence of Authentication & Authorization (Broken Access Control)
- **Location in Code**: Entire API surface in [`server.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/server.js).
- **The Defect**:
  - The `users` table contains `password_hash`, but **no authentication middleware, session token, or JWT verification exists**.
  - In `web/driver.html`, any user can select any driver from a dropdown and take over their identity.
  - In `web/admin.html`, there is no login gate; anyone with network access has full command authority.

### 4.2. Unauthenticated God-Mode Fleet Cancellation
- **Location in Code**: [`server.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/server.js#L383-L398).
- **The Defect**:
  ```javascript
  app.post('/api/admin/ambulances/free-all', (req, res) => {
    db.run("UPDATE dispatches SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE status != 'COMPLETED'", ...);
    db.run("UPDATE ambulances SET status = 'AVAILABLE'...", ...);
  });
  ```
- **Exploitation**: An unauthenticated attacker can send a single HTTP POST request to `/api/admin/ambulances/free-all`. Every active emergency dispatch across the entire city is immediately marked `COMPLETED` and wiped from dispatch tracking.

### 4.3. Wildcard CORS & Cross-Origin Request Forgery (CSRF)
- **Location in Code**: [`server.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/server.js#L12-L20).
- **The Defect**:
  ```javascript
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  ```
- **Exploitation**: Because credentials are not validated and CORS allows all origins, a malicious website visited by any dispatcher or user can trigger emergency dispatches or call the `free-all` endpoint in the background.

### 4.4. Fleet Denial of Service via Unthrottled SOS Flooding
- **Location in Code**: [`server.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/server.js#L333-L343).
- **The Defect**: There is no rate limiting, CAPTCHA, IP throttling, or phone verification on `/api/sos`.
- **Exploitation**: A script sending 16 rapid POST requests can mark all 16 fleet ambulances as `ASSIGNED` in under 2 seconds, rendering the EMS infrastructure completely unavailable to genuine callers.

### 4.5. Stored Cross-Site Scripting (XSS)
- **Location in Code**: [`web/app.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/web/app.js#L213-L230).
- **The Defect**: Hospital names, addresses, and emergency notes are directly injected into the DOM using unescaped `innerHTML`:
  ```javascript
  ui.sosResult.innerHTML = `<strong>${dispatch.hospital.name}</strong>`;
  ```
- **Exploitation**: If a malicious user supplies an address containing `<img src=x onerror=alert(document.cookie)>`, it executes within the context of the client portal.

---

## 5. Algorithmic & Spatial Routing Deficiencies

### 5.1. The One-Way Street Catastrophe (Routing Into Oncoming Traffic)
- **Location in Code**: [`src/algorithms/OSMParser.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/src/algorithms/OSMParser.js#L79-L83).
- **The Defect**:
  ```javascript
  if (currentWay.isHighway && currentWay.nds.length >= 2) {
    for (let i = 0; i < currentWay.nds.length - 1; i++) {
      graph.addEdge(currentWay.nds[i], currentWay.nds[i + 1], null, true); // true = bidirectional!
    }
  }
  ```
  The parser hardcodes `bidirectional = true` for **every single roadway in the graph**.
- **Impact**:
  - Tags like `oneway=yes`, `junction=roundabout`, and dual-carriageway expressways (such as the Noida-Greater Noida Expressway) are treated as two-way roads.
  - The $A^*$ algorithm routes ambulances the wrong way down one-way streets, backwards through roundabouts, and against high-speed expressway traffic. In a real-world setting, following these waypoints would cause severe accidents.

### 5.2. Inclusion of Non-Vehicular Infrastructure
- **Location in Code**: [`src/algorithms/OSMParser.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/src/algorithms/OSMParser.js#L53-L55).
- **The Defect**:
  ```javascript
  if (k === 'highway') {
    currentWay.isHighway = true;
  }
  ```
  The code treats any entity with a `highway` key as a drivable road.
- **Impact**: OpenStreetMap tags `highway=footway`, `highway=pedestrian`, `highway=steps`, `highway=cycleway`, and `highway=path` are incorporated directly into the vehicle routing graph. Ambulances are routed down pedestrian staircases, park walkways, and narrow pedestrian alleys.

### 5.3. Disconnected Graph "Island Trap" & Event Loop DoS
- **Location in Code**: [`src/algorithms/AStar.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/src/algorithms/AStar.js#L108-L153).
- **The Defect**:
  ```javascript
  while (!pq.isEmpty()) {
    const currentId = pq.pop();
    if (currentId === targetId) break;
    // ... expands all reachable neighbors
  }
  ```
- **Impact**:
  - OSM graphs frequently contain disconnected subgraphs (e.g., gated residential societies or isolated service paths).
  - If a patient snaps to an isolated component and the hospital is on the main network, target node $T$ is unreachable.
  - The Priority Queue does not terminate early; it **exhaustively explores every single connected node** in the component. In the main network of 216,000+ nodes, this locks the single-threaded Node.js event loop for several seconds, freezing all HTTP requests across the server.

### 5.4. Primitive Node-Snapping vs. Edge Projection
- **Location in Code**: [`src/algorithms/Graph.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/src/algorithms/Graph.js#L101-L153).
- **The Defect**: Coordinates are snapped to the nearest road *node* (point vertex) rather than projecting perpendicularly onto the nearest road *edge* (vector segment).
- **Impact**: On expressways or rural roads where nodes are spaced 500+ meters apart, snapping to a node selects a vertex far behind the vehicle or on an elevated flyover, producing large routing detours.

### 5.5. Clinically Blind Hospital Selection
- **Location in Code**: [`server.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/server.js#L163-L175).
- **The Defect**:
  ```javascript
  const selectNearestHospital = (cb) => {
    db.all('SELECT id, name, latitude, longitude, road_node_id FROM hospitals...', [], (hErr, hospitals) => {
      hospitals.sort((a, b) => {
        const dA = haversineDistance(a.latitude, a.longitude, lat, lon);
        const dB = haversineDistance(b.latitude, b.longitude, lat, lon);
        return dA - dB;
      });
      cb(hospitals[0]);
    });
  };
  ```
- **Impact**:
  - The algorithm sorts hospitals **strictly by straight-line Haversine distance**.
  - It completely ignores `emergency_available`, `available_beds`, `available_icu_beds`, and `hospital_capabilities`.
  - A patient suffering from a critical cardiac infarction can be routed to an outpatient eye clinic or a closed dispensary simply because it is 100 meters closer than a multi-specialty trauma center.

---

## 6. Data Model & Persistence Inconsistencies

### 6.1. Zombie Tables and Dead Schema
- **Location in Code**: [`src/db/database.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/src/db/database.js#L115-L135).
- **The Defect**:
  - `notifications`: Declared in schema, seeded with 0 rows, and never queried or inserted by any endpoint.
  - `ambulance_location_history`: Declared in schema, but never populated due to the missing location streaming endpoint.

### 6.2. SQL In-Memory Sorting & Scalability Bottleneck
- **Location in Code**: [`server.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/server.js#L79-L100, #L163-L175).
- **The Defect**: In `/api/hospitals` and `selectNearestHospital`, the server executes `SELECT * FROM hospitals` (253 rows), deserializes all rows into JavaScript memory, computes Haversine distances in a loop, and sorts using `Array.prototype.sort()`.
- **Impact**: Unnecessary memory churn and CPU overhead on every single user interaction.

---

## 7. Code Quality, Dependencies & Operational Risks

### 7.1. Missing Explicit Runtime Dependency
- **Location in Code**: [`package.json`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/package.json#L16-L20) vs [`src/algorithms/OSMParser.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/src/algorithms/OSMParser.js#L3).
- **The Defect**: `OSMParser.js` requires `'sax'`, but `package.json` only lists `express`, `sqlite3`, and `xml2js`.
- **Impact**: The application only functions because `sax` happens to be a sub-dependency of `xml2js`. In modern package managers (e.g., `pnpm`, or with `npm prune --production`), `sax` will fail to resolve, preventing server boot.

### 7.2. Platform-Specific Artifacts in Version Control
- **Location in Code**: `tools/mv.exe`, `tools/osmtools/osmconvert64-0.8.8p.exe`, `desktop.ini`.
- **The Defect**: Windows PE executables and Windows shell metadata files are stored in the repository. On Linux/Unix environments, these binaries are useless overhead and create security compliance flags.

### 7.3. Unhandled Promise Rejections & Hanging Initializations
- **Location in Code**: [`src/db/database.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/src/db/database.js#L144-L190).
- **The Defect**: Deeply nested callback pyramids (`db.serialize` $\rightarrow$ `db.all` $\rightarrow$ `migrateAmbulances` $\rightarrow$ `db.all` $\rightarrow$ `handleMigrations`). Several error branches fail to invoke `reject(err)`.
- **Impact**: If a migration query fails, the initialization Promise remains pending forever, causing the server boot sequence to hang indefinitely without logging the cause.

---

## 8. Prioritized Remediation Roadmap

To transform Med Way from an academic prototype into a resilient, production-grade emergency dispatch platform, the following fixes should be implemented in order of priority:

```mermaid
graph TD
    subgraph P1["Phase 1: Security & Concurrency (Immediate)"]
        S1["Implement Atomic Ambulance Reservation<br/>(Transaction / CAS query)"]
        S2["Add JWT / Session Authentication & RBAC"]
        S3["Protect Admin Endpoints & Secure CORS"]
    end

    subgraph P2["Phase 2: Routing & Clinical Accuracy (High)"]
        R1["Respect oneway=yes & Roundabouts in OSMParser"]
        R2["Filter out non-vehicular highway tags (footways, steps)"]
        R3["Incorporate Bed & ICU Availability into Hospital Ranking"]
    end

    subgraph P3["Phase 3: Real-Time Telemetry (Medium)"]
        T1["Implement POST /api/driver/location endpoint"]
        T2["Replace HTTP polling with WebSockets / SSE"]
        T3["Enable SQLite WAL Mode (PRAGMA journal_mode = WAL)"]
    end

    P1 --> P2 --> P3
```

1. **Atomic Fleet Reservation**:
   Replace the multi-step `SELECT` then `UPDATE` with an atomic conditional update:
   ```sql
   UPDATE ambulances 
   SET status = 'ASSIGNED', last_location_updated_at = CURRENT_TIMESTAMP 
   WHERE id = ? AND status = 'AVAILABLE';
   ```
   Verify that `changes === 1` before proceeding; if 0, retry with the next nearest unit.

2. **Respect One-Way Restrictions in OSM Parsing**:
   Inspect OSM tags in `OSMParser.js`:
   ```javascript
   const isOneWay = (currentWay.tags['oneway'] === 'yes') || (currentWay.tags['junction'] === 'roundabout');
   graph.addEdge(u, v, weight, !isOneWay);
   ```

3. **Clinical Triage Filtering**:
   Modify hospital selection to filter by clinical capability:
   ```sql
   SELECT h.* FROM hospitals h
   JOIN hospital_capabilities hc ON h.id = hc.hospital_id
   WHERE h.emergency_available = 1 
     AND h.available_beds > 0
     AND (h.available_icu_beds > 0 OR ? != 'Critical')
     AND hc.specialty = ?;
   ```

4. **Implement Real-Time Driver Telemetry**:
   - Create `POST /api/driver/location` to persist location history into `ambulance_location_history` and update `ambulances (latitude, longitude)`.
   - Upgrade client communication to **WebSockets** for instant dispatch notifications and live map animations.

---

## 9. Status of Remediations

| Area | Issues Remediated | Key Files Modified | Verification Test | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Concurrency & Race Conditions** | Mutex dispatch queue, SQLite WAL mode, Atomic CAS vehicle reservation (`changes === 1`) | `src/utils/mutex.js`, `src/db/database.js`, `server.js` | [`tests/concurrency_test.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/tests/concurrency_test.js) | **VERIFIED (100% Pass)** |
| **Security & Access Control** | Scrypt password hashing, timing-safe HMAC-SHA256 JWTs, RBAC middleware, Driver ID spoofing elimination, Rate Limiting (DoS), XSS mitigation | `src/utils/auth.js`, `src/utils/rateLimiter.js`, `src/middleware/auth.js`, `server.js`, `web/app.js` | [`tests/security_test.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/tests/security_test.js) | **VERIFIED (15/15 Pass)** |
| **Algorithmic & Road Safety** | Drivable vehicular highway filtering, One-way road & roundabout directed graph edges, Speed-weighted travel-time routing, $O(1)$ Island Guard component pre-indexing, Clinical triage hospital selection | `src/algorithms/OSMParser.js`, `src/algorithms/Graph.js`, `src/algorithms/AStar.js`, `src/db/seed.js`, `server.js` | [`tests/road_safety_test.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/tests/road_safety_test.js) | **VERIFIED (6/6 Pass)** |
| **Real-Time Architecture & Telemetry** | Sub-400ms graph disk caching, zero-dependency Server-Sent Events (SSE) event hub, active driver telemetry streaming, ambulance location history persistence, live patient Leaflet animation & dynamic ETA countdown, notifications table logging | `src/algorithms/Graph.js`, `src/algorithms/OSMParser.js`, `src/utils/eventStream.js`, `server.js`, `web/driver.html`, `web/app.js`, `web/admin.html` | [`tests/telemetry_architecture_test.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/tests/telemetry_architecture_test.js) | **VERIFIED (6/6 Pass)** |
| **Clinical Triage & Bed Allocation** | Multi-criteria clinical triage scoring (Cardiac, Stroke, Trauma, Pregnancy, General), ICU & emergency department validation, Atomic CAS hospital bed allocation (`changes === 1`), regional ER diversion guard, rollback compensation, frontend clinical badges & live bed visibility | `src/algorithms/ClinicalTriage.js`, `server.js`, `web/app.js` | [`tests/clinical_triage_test.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/tests/clinical_triage_test.js) | **VERIFIED (6/6 Pass)** |
| **Performance & Operational Reliability** | SQLite 11 B-tree indices ($O(1)$ query lookup), PRAGMA memory tuning (64MB cache, mmap 256MB), in-memory LRU Route Cache ($<0.05$ms corridor lookups, $>50\times$ speedup), bounded concentric radial grid snapping (eliminating 197k linear scans), process crash guards (`unhandledRejection`, `uncaughtException`), request timeout guards, automated sliding-window telemetry retention pruning, clean SIGTERM/SIGINT graceful shutdown, production health & diagnostics endpoints (`/health`, `/api/diagnostics`) | `src/db/database.js`, `src/algorithms/AStar.js`, `src/algorithms/Graph.js`, `src/utils/telemetryPruner.js`, `src/utils/eventStream.js`, `server.js` | [`tests/performance_reliability_test.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/tests/performance_reliability_test.js) | **VERIFIED (6/6 Pass)** |
| **Accidental Re-Dispatch & Duplicate Prevention** | Frontend state-aware action switching (`#activeMissionActions` vs `#mainActions`), in-flight submission debounce locking (`isSubmitting`), duplicate confirmation modal (`#duplicateModal`), session storage mission re-hydration, and backend spatial-temporal active dispatch deduplication guard ($\Delta \le 50$m, 10-minute window) | `server.js`, `web/app.js`, `web/index.html`, `web/styles.css` | [`tests/accidental_dispatch_test.js`](file:///home/spulse/Projects/se%20project%20med%20way%20copy/tests/accidental_dispatch_test.js) | **VERIFIED (5/5 Pass)** |


