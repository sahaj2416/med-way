# Med Way: Emergency Ambulance Coordination Platform

An intelligent, real-time emergency ambulance dispatch, routing, and hospital coordination web application built with Node.js, Express, SQLite, and Leaflet.

---

## Features

- **Emergency SOS Dispatch**: 1-click instant ambulance dispatch with nearest available unit matching and hospital bed reservation.
- **Clinical Triage Booking**: Multi-step booking flow matching emergencies (Cardiac, Stroke, Trauma, Pregnancy, General) to specialized hospital facilities and ICU beds.
- **Accidental Re-Click Prevention**: Spatial-temporal deduplication guard preventing redundant dispatches.
- **Directional A\* Road Routing**: Realistic fastest-path routing respecting one-way streets, roundabouts, and speed limits across Noida.
- **Sub-Second Boot Time**: In-memory topological road graph with persistent JSON disk caching.
- **Real-Time Push Streams (SSE)**: Zero-dependency Server-Sent Events delivering live GPS coordinates, fleet updates, and mission statuses.
- **Security & RBAC**: Timing-safe HMAC-SHA256 JWT authentication, Scrypt password hashing, and role-based access control for Admins and Drivers.
- **Driver Portal**: Dedicated interface for drivers to manage duty status, accept dispatches, update mission progress, and stream GPS fixes.
- **Admin Command Center**: Centralized dispatcher dashboard with live fleet status, active missions map, completed incident records, and panic fleet reset.

---

## Quick Start

### 1. Prerequisites
- Node.js (v18 or higher recommended)
- npm

### 2. Install Dependencies
```bash
npm install
```

### 3. Seed Database (Optional / Initial Setup)
```bash
npm run seed
```

### 4. Start the Application
```bash
npm start
```
The server will start on `http://localhost:3000`.

### 5. Accessing the Portals
- **Patient Interface**: [http://localhost:3000](http://localhost:3000)
- **Driver Portal**: [http://localhost:3000/driver.html](http://localhost:3000/driver.html)
- **Admin Command Center**: [http://localhost:3000/admin.html](http://localhost:3000/admin.html)

---

## Running Verification Tests

Med Way includes a comprehensive suite of automated verification tests:

```bash
npm test
```

Individual test suites:
```bash
node tests/concurrency_test.js
node tests/security_test.js
node tests/road_safety_test.js
node tests/clinical_triage_test.js
node tests/telemetry_architecture_test.js
node tests/performance_reliability_test.js
node tests/accidental_dispatch_test.js
node tests/reload_tracking_test.js
```
